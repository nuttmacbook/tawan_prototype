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

/**
 * Starts claude and returns a handle; the prompt is sent later with send(). Starting early lets
 * Node and Claude Code load while you're still typing, so the reply doesn't wait for that.
 */
function startProcess(args, { cwd = BRAIN_ROOT } = {}) {
    const child = isWin
        ? spawn([ CLAUDE_BIN, ...args ].map(quoteWin).join(" "), { cwd, env: ccEnv(), shell: true })
        : spawn(CLAUDE_BIN, args, { cwd, env: ccEnv() });

    let out = "";
    let err = "";
    let spawnError = null;
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const exited = new Promise((resolve) => {
        child.on("error", (e) => {
            spawnError = e;
            resolve();
        });
        child.on("close", (code) => resolve(code));
    });

    return {
        child,
        /** Still waiting for its prompt (it can quit on its own while idle) */
        isAlive: () => child.exitCode == null && child.signalCode == null && !spawnError && !child.killed,
        kill: () => killTree(child),
        send(input, timeout = CC_TIMEOUT_MS) {
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    killTree(child);
                    reject(new Error("Claude ในเครื่องตอบช้าเกินไป ลองใหม่อีกครั้ง"));
                }, timeout);
                exited.then((code) => {
                    clearTimeout(timer);
                    if (spawnError) {
                        reject(new Error(spawnError?.code === "ENOENT" ? "ไม่พบคำสั่ง claude ในเครื่อง ติดตั้ง Claude Code ก่อน" : spawnError.message));
                    } else {
                        resolve({ code, out, err });
                    }
                });
                child.stdin.on("error", () => {});
                child.stdin.end(input);
            });
        },
    };
}

function runProcess(args, { input = "", timeout = CC_TIMEOUT_MS, cwd = BRAIN_ROOT } = {}) {
    return startProcess(args, { cwd }).send(input, timeout);
}

const replyArgs = (systemFile, imageCount) => [
    "-p",
    "--output-format", "json",
    "--system-prompt-file", systemFile,
    "--model", CC_MODEL,
    "--max-turns", imageCount ? String(2 + imageCount) : "2",
    "--no-session-persistence",
    "--strict-mcp-config",
    // Variadic flags go last; the prompt arrives on stdin, not as an argument.
    // Read is allowed for the copied pictures only: a bare "Read" would let a crafted persona file
    // talk her into opening anything on this computer (~/.ssh, .env) and quoting it in chat.
    ...(imageCount ? [ "--tools", "Read", "--allowedTools", "Read(./img-*)" ] : [ "--disallowedTools", "*" ]),
];

/* ------------------------------------ a claude started ahead of time */

// CLAUDE_PREWARM=0 turns this off if your Claude Code version doesn't like waiting for its prompt
const PREWARM = !/^(0|false|no)$/i.test(String(process.env.CLAUDE_PREWARM ?? ""));
const SPARE_IDLE_MS = 15 * 60000;

/** One claude process already started for the next chat reply, with the same system prompt */
let spare = null;

function dropSpare() {
    const old = spare;
    spare = null;
    if (!old) return;
    clearTimeout(old.idleTimer);
    old.proc.kill();
    old.cleanup();
}

/** Starts the next reply's claude in the background; the system prompt only changes when files are edited */
function prepareSpare(system) {
    if (!PREWARM) return;
    dropSpare();
    prepareRun(system, []).then((run) => {
        // An idle claude shouldn't sit there forever
        run.idleTimer = setTimeout(() => {
            if (spare === run) dropSpare();
        }, SPARE_IDLE_MS);
        if (spare) {
            run.proc.kill();
            run.cleanup();
            return;
        }
        spare = run;
    }).catch(() => {});
}

// A spare left behind would be waiting on a prompt that never comes; stop it with the server.
// Exit code 0 on a signal: the runner treats Ctrl+C and stop requests as a normal stop, not a crash.
process.on("exit", () => spare?.proc.kill());
for (const signal of [ "SIGINT", "SIGTERM" ]) {
    process.once(signal, () => {
        spare?.proc.kill();
        process.exit(0);
    });
}

/**
 * Asks the user's own logged-in Claude Code for one reply, with all built-in tools turned off.
 * @param {{ system: string, prompt: string, images?: string[], keepWarm?: boolean }} req
 *   keepWarm: chat replies; the next one will likely use the same system prompt, so start it now
 * @returns {Promise<string>} the model's text
 */
export async function askClaudeCode({ system, prompt, images = [], keepWarm = false }) {
    const started = Date.now();
    // Use the claude started ahead of time when it's ready, alive and set up for this same system prompt
    let run = null;
    let isWarm = false;
    if (!images.length && spare && spare.system === system && spare.proc.isAlive()) {
        run = spare;
        spare = null;
        clearTimeout(run.idleTimer);
        isWarm = true;
    }

    try {
        let result;
        try {
            if (!run) run = await prepareRun(system, images);
            result = await finish(run, prompt);
        } catch (err) {
            // A spare that went bad while waiting must not cost the reply: try once more the normal way
            if (!isWarm || /ล็อกอิน|ไม่พบคำสั่ง/.test(err?.message ?? "")) throw err;
            run.cleanup();
            run = await prepareRun(system, images);
            isWarm = false;
            result = await finish(run, prompt);
        }
        lastUsage = { ...(lastUsage ?? {}), ms: Date.now() - started, isWarm };
        return result;
    } finally {
        run?.cleanup();
        if (keepWarm && !images.length) prepareSpare(system);
    }
}

/**
 * A folder of its own per call: a memory tidy-up running in the background must never
 * swap its prompt or pictures with the chat reply being written at the same time.
 */
async function prepareRun(system, images) {
    await mkdir(BRAIN_ROOT, { recursive: true });
    const dir = await mkdtemp(path.join(BRAIN_ROOT, "run-"));
    const cleanup = () => rm(dir, { recursive: true, force: true }).catch(() => {});
    try {
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
        const proc = startProcess(replyArgs(systemFile, names.length), { cwd: dir });
        return { dir, system, proc, cleanup, names };
    } catch (err) {
        await cleanup();
        throw err;
    }
}

async function finish(run, prompt) {
    const names = run.names ?? [];
    const imageNote = names.length
        ? `\n\nผู้ใช้ส่งรูปมา ${names.length} รูป ใช้เครื่องมือ Read เปิดดูไฟล์ ${names.map((n) => `./${n}`).join(", ")} ก่อนตอบ`
        : "";
    const { code, out, err } = await run.proc.send(`${prompt}${imageNote}`);

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
