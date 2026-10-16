import { spawn } from "node:child_process";
import { mkdir, writeFile, copyFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "./store.js";

/* ------------------------------------ config */

const API_MODEL = process.env.MODEL || "claude-sonnet-5-5";
const CC_MODEL = process.env.CLAUDE_CODE_MODEL || "sonnet";
const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";
const CC_TIMEOUT_MS = 180000;
const isWin = process.platform === "win32";

// An empty folder to run Claude Code in, so it doesn't pick up this project's CLAUDE.md or .mcp.json
const BRAIN_DIR = path.join(DATA_DIR, ".brain");

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

function runProcess(args, { input = "", timeout = CC_TIMEOUT_MS } = {}) {
    return new Promise((resolve, reject) => {
        const child = isWin
            ? spawn([ CLAUDE_BIN, ...args ].map(quoteWin).join(" "), { cwd: BRAIN_DIR, env: ccEnv(), shell: true })
            : spawn(CLAUDE_BIN, args, { cwd: BRAIN_DIR, env: ccEnv() });

        let out = "";
        let err = "";
        const timer = setTimeout(() => {
            child.kill("SIGINT");
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
    await mkdir(BRAIN_DIR, { recursive: true });
    const systemFile = path.join(BRAIN_DIR, "system.md");
    await writeFile(systemFile, system);

    // Pictures are copied next to the prompt so Claude can open them with Read, its only tool here
    for (const old of (await readdir(BRAIN_DIR)).filter((f) => f.startsWith("img-"))) {
        await rm(path.join(BRAIN_DIR, old), { force: true });
    }
    const names = [];
    for (const [ i, file ] of images.entries()) {
        const name = `img-${i}${path.extname(file) || ".jpg"}`;
        await copyFile(file, path.join(BRAIN_DIR, name));
        names.push(name);
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
        // Variadic flags go last; the prompt arrives on stdin, not as an argument
        ...(names.length ? [ "--tools", "Read", "--allowedTools", "Read" ] : [ "--disallowedTools", "*" ]),
    ];

    const { code, out, err } = await runProcess(args, { input: `${prompt}${imageNote}` });

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
        await mkdir(BRAIN_DIR, { recursive: true });
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
