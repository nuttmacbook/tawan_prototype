// Keeps the server running: restarts it when editlogic asks (exit code 75),
// rolls the code back to the last backup if a restart crashes right away,
// and keeps a Cloudflare quick tunnel open across those restarts when TUNNEL=1.
import { spawn } from "node:child_process";
import { readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const RESTART_MARK = path.join(ROOT, "data", ".backups", "pending-restart.json");
const TUNNEL_FILE = path.join(ROOT, "data", ".tunnel.json");
const SETTINGS_FILE = path.join(ROOT, "data", "settings.json");
const RESTART_CODE = 75;
const CRASH_WINDOW_MS = 10000;

try {
    process.loadEnvFile(path.join(ROOT, ".env"));
} catch {}

const PORT = Number(process.env.PORT ?? 3939) || 3939;
const isTunnel = /^(1|true|yes)$/i.test(String(process.env.TUNNEL ?? ""));
const CLOUDFLARED = process.env.CLOUDFLARED_BIN || "cloudflared";

const args = process.argv.slice(2);
let startedAt = 0;
let hasRolledBack = false;
let server = null;
let tunnel = null;

async function pendingBackup() {
    try {
        return JSON.parse(await readFile(RESTART_MARK, "utf8"))?.backupId ?? null;
    } catch {
        return null;
    }
}

/* ------------------------------------ server */

function start() {
    startedAt = Date.now();
    server = spawn(process.execPath, [ path.join(ROOT, "server", "index.js"), ...args ], { stdio: "inherit", cwd: ROOT, env: { ...process.env, PERSONA_RUNNER: "1" } });

    server.on("exit", async (code) => {
        if (code === RESTART_CODE) {
            console.log("\n  ↻ รีสตาร์ทเซิร์ฟเวอร์เพื่อใช้โค้ดใหม่...\n");
            hasRolledBack = false;
            return start();
        }

        const backupId = await pendingBackup();
        const crashedEarly = Date.now() - startedAt < CRASH_WINDOW_MS;
        if (code !== 0 && crashedEarly && backupId && !hasRolledBack) {
            console.log(`\n  ⚠ โค้ดใหม่ทำให้เซิร์ฟเวอร์เปิดไม่ขึ้น กำลังย้อนกลับไปที่ backup ${backupId}...\n`);
            const { restoreBackup } = await import("../server/logic.js");
            await restoreBackup(backupId);
            await rm(RESTART_MARK, { force: true });
            hasRolledBack = true;
            return start();
        }

        stop(code ?? 0);
    });
}

/* ------------------------------------ Cloudflare quick tunnel */

/** The server creates the access key on start; wait for it so the printed link works */
async function waitForKey() {
    for (let i = 0; i < 30; i++) {
        try {
            const key = JSON.parse(await readFile(SETTINGS_FILE, "utf8"))?.lanKey;
            if (key) return key;
        } catch {}
        await new Promise((r) => setTimeout(r, 500));
    }
    return "";
}

/**
 * Runs `cloudflared tunnel --url http://localhost:PORT` and saves the random
 * https://….trycloudflare.com address it prints, so the page can show it.
 * It lives in the runner, not the server, so editlogic restarts don't change the address.
 */
function startTunnel() {
    let isAnnounced = false;
    tunnel = spawn(CLOUDFLARED, [ "tunnel", "--no-autoupdate", "--url", `http://localhost:${PORT}` ], {
        cwd: ROOT,
        shell: process.platform === "win32",
    });

    const onOutput = async (chunk) => {
        const url = String(chunk).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0];
        if (!url || isAnnounced) return;
        isAnnounced = true;
        await mkdir(path.dirname(TUNNEL_FILE), { recursive: true });
        await writeFile(TUNNEL_FILE, JSON.stringify({ url, at: Date.now() }));
        const key = await waitForKey();
        console.log(`\n  🌐 เปิดจากที่ไหนก็ได้ (ลิงก์นี้มีรหัส อย่าแชร์):\n     ${url}/?key=${key}\n`);
    };
    tunnel.stdout.on("data", onOutput);
    tunnel.stderr.on("data", onOutput);

    tunnel.on("error", (err) => {
        if (err?.code !== "ENOENT") return console.log(`\n  ⚠ เปิด tunnel ไม่ได้: ${err.message}\n`);
        console.log([
            "",
            "  ⚠ ไม่พบ cloudflared ในเครื่อง ติดตั้งก่อนแล้วเปิดใหม่:",
            "     Windows:  winget install --id Cloudflare.cloudflared",
            "     macOS:    brew install cloudflared",
            "     Linux:    https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/",
            "",
        ].join("\n"));
    });

    tunnel.on("exit", async (code) => {
        await rm(TUNNEL_FILE, { force: true }).catch(() => {});
        if (tunnel?.isStopping) return;
        console.log(`\n  ⚠ tunnel ปิดไป (รหัส ${code}) กำลังเปิดใหม่ใน 5 วินาที ลิงก์จะเปลี่ยน\n`);
        setTimeout(startTunnel, 5000);
    });
}

/* ------------------------------------ lifecycle */

function stop(code = 0) {
    if (tunnel) {
        tunnel.isStopping = true;
        tunnel.kill();
    }
    rm(TUNNEL_FILE, { force: true }).finally(() => process.exit(code));
}

// Ctrl+C stops the runner, the server and the tunnel together
process.on("SIGINT", () => {
    server?.kill("SIGINT");
    stop(0);
});

await rm(TUNNEL_FILE, { force: true }).catch(() => {});
start();
if (isTunnel && !process.env.PUBLIC_URL) startTunnel();
