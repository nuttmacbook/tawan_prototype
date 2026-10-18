import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile, copyFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/* ------------------------------------ config */

const API_MODEL = process.env.MODEL || "claude-sonnet-5-5";
const CC_MODEL = process.env.CLAUDE_CODE_MODEL || "sonnet";
const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";
const CC_TIMEOUT_MS = 180000;
const isWin = process.platform === "win32";

// Claude Code runs in an empty folder outside the project. Inside the project it would also read
// CLAUDE.md from the parent folders (the editlogic manual) and treat it as part of her instructions.
const BRAIN_ROOT = path.join(os.tmpdir(), "persona-agent-brain");

/* ------------------------------------ Claude Code (local login) */

/**
 * Child env without API keys: Claude Code prefers ANTHROPIC_API_KEY over the
 * subscription login, which would silently bill the API instead.
 */
const ccEnv = () => {
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    return env;
};

/** Quotes an argument for cmd.exe; npm-installed `claude` is a .cmd shim that needs a shell on Windows */
const quoteWin = (a) => (/[\s"&|<>^*()]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a);

/** On Windows the child is cmd.exe; killing only that would leave claude running and billing */
function killTree(child) {
    if (!isWin || !child?.pid) return child?.kill("SIGINT");
    spawn("taskkill", [ "/pid", String(child.pid), "/T", "/F" ], { stdio: "ignore" }).on("error", () => child.kill());
}

function runProcess(args, { input = "", timeout = CC_TIMEOUT_MS, cwd = BRAIN_ROOT } = {}) {
    return new Promise((resolve, reject) => {
        const child = isWin
            ? spawn([ CLAUDE_BIN, ...args ].map(quoteWin).join(" "), { cwd, env: ccEnv(), shell: true })
            : spawn(CLAUDE_BIN, args, { cwd, env: ccEnv() });

        let out = "";
        let err = "";
        const timer = setTimeout(() => {
            killTree(child);
            reject(new Error("Claude ในเครื่องตอบช้าเกินไป ลองใหม่อีกครั้ง"));
        }, timeout);

        child.stdout.on("data", (d) => (out += d));
        child.stderr.on("data", (d) => (err += d));
        child.on("error", (e) => {
            clearTimeout(timer);
            reject(new Error(e?.code === "ENOENT" ? "ไม่พบคำสั่ง claude ในเครื่อง ติดตั้ง Claude Code ก่อน" : e.message));
        });
        child.on("close", (code) => {
            clearTimeout(timer);
            resolve({ code, out, err });
        });

        child.stdin.end(input);
    });
}

/**
 * Asks the user's own logged-in Claude Code for one reply, with all built-in tools turned off.
 * @param {{ system: string, prompt: string }} req
 * @returns {Promise<string>} the model's text
 */
export async function askClaudeCode({ system, prompt, images = [] }) {
    // A folder of its own per call: a memory tidy-up running in the background must never
    // swap its prompt or pictures with the chat reply being written at the same time
    await mkdir(BRAIN_ROOT, { recursive: true });
    const dir = await mkdtemp(path.join(BRAIN_ROOT, "run-"));
    try {
        return await askIn(dir, { system, prompt, images });
    } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
}

async function askIn(dir, { system, prompt, images }) {
    const systemFile = path.join(dir, "system.md");
    await writeFile(systemFile, system);

    // Pictures are copied next to the prompt so Claude can open them with Read, its only tool here
    const names = [];
    for (const [ i, file ] of images.entries()) {
        const name = `img-${i}${path.extname(file) || ".jpg"}`;
        try {
            await copyFile(file, path.join(dir, name));
            names.push(name);
        } catch {
            // A picture that's gone shouldn't block the whole reply
        }
    }
    const imageNote = names.length
        ? `\n\nผู้ใช้ส่งรูปมา ${names.length} รูป ใช้เครื่องมือ Read เปิดดูไฟล์ ${names.map((n) => `./${n}`).join(", ")} ก่อนตอบ`
        : "";

    const args = [
        "-p",
        "--output-format", "json",
        "--system-prompt-file", systemFile,
        "--model", CC_MODEL,
        "--max-turns", names.length ? String(2 + names.length) : "2",
        "--no-session-persistence",
        "--strict-mcp-config",
        // Variadic flags go last; the prompt arrives on stdin, not as an argument.
        // Read is allowed for the copied pictures only: a bare "Read" would let a crafted persona file
        // talk her into opening anything on this computer (~/.ssh, .env) and quoting it in chat.
        ...(names.length ? [ "--tools", "Read", "--allowedTools", "Read(./img-*)" ] : [ "--disallowedTools", "*" ]),
    ];

    const { code, out, err } = await runProcess(args, { input: `${prompt}${imageNote}`, cwd: dir });

    let parsed = null;
    try {
        parsed = JSON.parse(out);
    } catch {
        // Older versions or crashes print plain text; surface it rather than a JSON error
    }

    if (parsed?.is_error || code !== 0) {
        const reason = String(parsed?.result ?? err ?? out).trim() || `exit ${code}`;
        if (/login|auth|credential|401/i.test(reason)) {
            throw new Error("Claude ในเครื่องยังไม่ได้ล็อกอิน เปิด terminal แล้วพิมพ์ claude เพื่อล็อกอินก่อน");
        }
        throw new Error(`Claude ในเครื่องผิดพลาด: ${reason.slice(0, 300)}`);
    }

    lastUsage = usageOf(parsed?.usage, parsed?.total_cost_usd);
    return String(parsed?.result ?? out).trim();
}

let lastUsage = null;

/** Token counts in one shape for both brains; cached tokens are cheaper and faster */
export const usageOf = (u, cost = null) => (u ? {
    input: Number(u.input_tokens ?? 0) + Number(u.cache_read_input_tokens ?? 0) + Number(u.cache_creation_input_tokens ?? 0),
    cached: Number(u.cache_read_input_tokens ?? 0),
    output: Number(u.output_tokens ?? 0),
    cost: cost == null ? null : Number(cost),
} : null);

/** Usage of the latest Claude Code call */
export const claudeCodeUsage = () => lastUsage;

/**
 * Checks whether Claude Code is installed and logged in, without spending any tokens.
 * @returns {Promise<{ installed: boolean, loggedIn: boolean, method: string }>}
 */
export async function claudeCodeStatus() {
    try {
        await mkdir(BRAIN_ROOT, { recursive: true });
        const { code, out } = await runProcess([ "auth", "status" ], { timeout: 15000 });
        let info = {};
        try {
            info = JSON.parse(out);
        } catch {}
        return { installed: true, loggedIn: code === 0, method: String(info?.authMethod ?? "") };
    } catch {
        return { installed: false, loggedIn: false, method: "" };
    }
}

/* ------------------------------------ API key */

let client = null;

/** Lazy so the app still starts (in Claude Code mode) when no API key or SDK is set up */
async function apiClient() {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("ยังไม่ได้ใส่ ANTHROPIC_API_KEY ในไฟล์ .env");
    if (!client) {
        const { default: Anthropic } = await import("@anthropic-ai/sdk");
        client = new Anthropic();
    }
    return client;
}

/** One Messages API call; the tool loop lives in brain.js */
export async function askApi(params) {
    const c = await apiClient();
    return c.messages.create({ model: API_MODEL, max_tokens: 1024, ...params });
}

export const hasApiKey = () => Boolean(process.env.ANTHROPIC_API_KEY);

export { API_MODEL, CC_MODEL };
