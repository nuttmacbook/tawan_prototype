import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile, readdir, stat, copyFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

/* ------------------------------------ config */

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const BACKUP_DIR = path.join(ROOT, "data", ".backups");
const RESTART_MARK = path.join(ROOT, "data", ".backups", "pending-restart.json");
const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";
const LOGIC_MODEL = process.env.CLAUDE_LOGIC_MODEL || "sonnet";
const LOGIC_TOOLS = "Read,Edit,Write,Glob,Grep";
const KEEP_BACKUPS = 20;
const isWin = process.platform === "win32";

// Only the system's own code is editable here; memories in data/ have their own editor
const CODE_DIRS = [ "server", "src", "scripts", "public" ];
const CODE_FILES = [ "index.html", "vite.config.js", "CLAUDE.md", "package.json" ];
const CODE_EXT = /\.(js|css|html|md|json|webmanifest)$/;

/* ------------------------------------ code files */

async function walk(dir) {
    const out = [];
    let entries = [];
    try {
        entries = await readdir(path.join(ROOT, dir), { withFileTypes: true });
    } catch {
        return out;
    }
    for (const e of entries) {
        const rel = path.posix.join(dir, e.name);
        if (e.isDirectory()) out.push(...(await walk(rel)));
        else if (CODE_EXT.test(e.name)) out.push(rel);
    }
    return out;
}

/** Every file editlogic may touch, as forward-slash paths relative to the project */
export async function listCodeFiles() {
    const nested = (await Promise.all(CODE_DIRS.map(walk))).flat();
    const roots = [];
    for (const f of CODE_FILES) {
        try {
            if ((await stat(path.join(ROOT, f))).isFile()) roots.push(f);
        } catch {}
    }
    return [ ...roots, ...nested.sort() ];
}

/** Rejects anything outside the allowed code files, including ../ tricks */
async function resolveCode(rel) {
    const clean = path.posix.normalize(String(rel ?? "").replace(/\\/g, "/")).replace(/^\/+/, "");
    if (!(await listCodeFiles()).includes(clean)) throw new Error("แก้ไฟล์นี้จากหน้าเว็บไม่ได้");
    return path.join(ROOT, clean);
}

export const readCode = async (rel) => readFile(await resolveCode(rel), "utf8");

export async function writeCode(rel, text) {
    const file = await resolveCode(rel);
    const backupId = await backup(`แก้มือ: ${rel}`);
    await writeFile(file, String(text ?? ""));
    return { backupId, needsRestart: needsRestart([ rel ]) };
}

/** Server code only takes effect after a restart; page code reloads with the browser */
const needsRestart = (files) => files.some((f) => /^(server|scripts)\//.test(f) || f === "package.json");

/* ------------------------------------ backups */

const stamp = () => new Date().toLocaleString("sv-SE").replace(/[: ]/g, "-");

/**
 * Copies every code file into data/.backups/<time>/ before anything changes.
 * @returns {Promise<string>} backup id
 */
export async function backup(label = "") {
    const id = `${stamp()}-${Math.random().toString(36).slice(2, 6)}`;
    const dir = path.join(BACKUP_DIR, id);
    for (const rel of await listCodeFiles()) {
        const to = path.join(dir, rel);
        await mkdir(path.dirname(to), { recursive: true });
        await copyFile(path.join(ROOT, rel), to);
    }
    await writeFile(path.join(dir, "_label.txt"), String(label).slice(0, 200));

    // Old backups pile up quickly; keep the most recent ones
    const all = (await listBackups()).map((b) => b.id);
    for (const old of all.slice(KEEP_BACKUPS)) await rm(path.join(BACKUP_DIR, old), { recursive: true, force: true });
    return id;
}

export async function listBackups() {
    try {
        const ids = (await readdir(BACKUP_DIR, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
        const rows = await Promise.all(ids.map(async (id) => ({
            id,
            label: await readFile(path.join(BACKUP_DIR, id, "_label.txt"), "utf8").catch(() => ""),
        })));
        return rows.sort((a, b) => b.id.localeCompare(a.id));
    } catch {
        return [];
    }
}

/**
 * Puts every code file back to how it was in that backup.
 * Files created after the backup are left alone.
 */
export async function restoreBackup(id) {
    const dir = path.join(BACKUP_DIR, path.basename(String(id ?? "")));
    const restored = [];
    async function copyBack(rel) {
        const from = path.join(dir, rel);
        const entries = await readdir(from, { withFileTypes: true }).catch(() => null);
        if (entries) {
            for (const e of entries) await copyBack(path.posix.join(rel, e.name));
            return;
        }
        if (rel === "_label.txt") return;
        const to = path.join(ROOT, rel);
        await mkdir(path.dirname(to), { recursive: true });
        await copyFile(from, to);
        restored.push(rel);
    }
    await stat(dir);
    await copyBack("");
    return restored.filter(Boolean);
}

/** Tells scripts/run.js which backup to roll back to if the restarted server crashes */
export const markRestart = (backupId) => writeFile(RESTART_MARK, JSON.stringify({ backupId, at: Date.now() }));

/* ------------------------------------ run Claude Code on the project */

const run = {
    isRunning: false,
    sessionId: null,
    events: [],
    seq: 0,
    changed: [],
    backupId: null,
};

// A long session would otherwise keep every line it ever printed in memory
const MAX_EVENTS = 1000;

const emit = (e) => {
    run.events.push({ i: run.seq++, at: Date.now(), ...e });
    if (run.events.length > MAX_EVENTS) run.events.splice(0, run.events.length - MAX_EVENTS);
};

/** Files editlogic may change; anything else it touched is reported as a warning */
const isCodePath = (rel) =>
    CODE_FILES.includes(rel) || CODE_DIRS.some((d) => rel.startsWith(`${d}/`));

/** Child env without API keys, so the run uses the Claude Code login on this PC */
const ccEnv = () => {
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    return env;
};

const quoteWin = (a) => (/[\s"&|<>^*()]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a);

const relPath = (p) => path.relative(ROOT, path.resolve(ROOT, String(p ?? ""))).split(path.sep).join("/");

/** Turns one stream-json line from Claude Code into page events */
function handleLine(line) {
    let msg;
    try {
        msg = JSON.parse(line);
    } catch {
        return;
    }

    if (msg?.session_id) run.sessionId = msg.session_id;

    if (msg?.type === "assistant") {
        for (const block of msg?.message?.content ?? []) {
            if (block?.type === "text" && block.text?.trim()) emit({ kind: "text", text: block.text.trim() });
            if (block?.type === "tool_use") {
                const file = block.input?.file_path ? relPath(block.input.file_path) : "";
                const isWrite = block.name === "Edit" || block.name === "Write";
                if (isWrite && file && !run.changed.includes(file)) run.changed.push(file);
                emit({ kind: "tool", tool: block.name, file, pattern: block.input?.pattern ?? "" });
            }
        }
    }

    if (msg?.type === "result") {
        if (msg.is_error) emit({ kind: "error", text: String(msg.result ?? "Claude ในเครื่องผิดพลาด") });
        emit({ kind: "done", cost: msg.total_cost_usd ?? null });
    }
}

/**
 * Starts Claude Code in the project folder with file tools only (no shell).
 * Progress is read back with logicState(); the conversation continues across requests.
 * @param {string} prompt what the user wants changed
 */
export async function startLogicRun(prompt) {
    const text = String(prompt ?? "").trim();
    if (!text) throw new Error("พิมพ์สิ่งที่อยากให้แก้ก่อน");
    if (run.isRunning) throw new Error("กำลังแก้ระบบอยู่ รอให้เสร็จก่อน");

    run.isRunning = true;
    run.changed = [];
    try {
        run.backupId = await backup(`ก่อนสั่ง: ${text}`);
    } catch (err) {
        // Without a backup there's no way back, so don't start; and don't stay stuck as "running"
        run.isRunning = false;
        throw new Error(`สำรองโค้ดก่อนแก้ไม่สำเร็จ จึงยังไม่เริ่ม: ${err?.message ?? err}`);
    }
    const startIndex = run.seq;
    emit({ kind: "user", text });

    const args = [
        "-p",
        "--output-format", "stream-json",
        "--verbose",
        "--model", LOGIC_MODEL,
        "--permission-mode", "acceptEdits",
        "--strict-mcp-config",
        ...(run.sessionId ? [ "--resume", run.sessionId ] : []),
        // Variadic flags go last; the prompt arrives on stdin
        "--tools", LOGIC_TOOLS,
        "--allowedTools", LOGIC_TOOLS,
        // Enforced by Claude Code itself, not just asked for in the prompt: characters' data,
        // the API key and installed packages are off limits (an Edit rule covers Write too)
        "--disallowedTools", "Edit(./data/**)", "Read(./.env)", "Edit(./.env)", "Edit(./node_modules/**)",
    ];

    const child = isWin
        ? spawn([ CLAUDE_BIN, ...args ].map(quoteWin).join(" "), { cwd: ROOT, env: ccEnv(), shell: true })
        : spawn(CLAUDE_BIN, args, { cwd: ROOT, env: ccEnv() });

    let buffer = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
        buffer += d;
        let nl;
        while ((nl = buffer.indexOf("\n")) >= 0) {
            handleLine(buffer.slice(0, nl));
            buffer = buffer.slice(nl + 1);
        }
    });
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => {
        emit({ kind: "error", text: e?.code === "ENOENT" ? "ไม่พบคำสั่ง claude ในเครื่อง" : e.message });
        run.isRunning = false;
    });
    child.on("close", (code) => {
        if (buffer.trim()) handleLine(buffer);
        const outside = run.changed.filter((f) => !isCodePath(f));
        if (outside.length) emit({ kind: "error", text: `⚠ มีการแก้ไฟล์นอกโค้ดระบบ: ${outside.join(", ")} (ตรวจดูเองด้วย ระบบย้อนกลับให้เฉพาะโค้ด)` });
        if (code !== 0 && !run.events.some((e) => e.kind === "done" && e.i >= startIndex)) {
            emit({ kind: "error", text: stderr.trim().slice(0, 400) || `จบด้วยรหัส ${code}` });
        }
        emit({ kind: "finished", changed: [ ...run.changed ], needsRestart: needsRestart(run.changed), backupId: run.backupId });
        run.isRunning = false;
    });

    child.stdin.end(
        `${text}\n\n(คำขอนี้มาจากโหมด editlogic ในหน้าเว็บ อ่าน CLAUDE.md ก่อนแก้ แก้เฉพาะโค้ดระบบ ห้ามแตะ data/ แล้วสรุปสั้น ๆ เป็นภาษาไทยว่าแก้อะไรไปบ้าง)`,
    );
}

/** Events after index `since`, so the page can poll and also catch up after a reload */
export const logicState = (since = 0) => ({
    isRunning: run.isRunning,
    hasSession: Boolean(run.sessionId),
    events: run.events.filter((e) => e.i >= since),
    next: run.seq,
});

export function resetLogicSession() {
    if (run.isRunning) throw new Error("กำลังแก้ระบบอยู่ รอให้เสร็จก่อน");
    run.sessionId = null;
    run.events = [];
}

/** True while editlogic is working, so the page and the runner can wait before restarting */
export const isLogicRunning = () => run.isRunning;

export { LOGIC_MODEL };
