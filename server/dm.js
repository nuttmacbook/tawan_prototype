import crypto from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { DATA_DIR, USER_ID } from "./profiles.js";
import { withFileLock, writeAtomic } from "./fsutil.js";

/* ------------------------------------ chats between real users */

// Two friends talking directly, like any messaging app. No character and no brain here:
// one JSON file per pair, newest last.
const DM_DIR = path.join(DATA_DIR, "dm");
const MAX_TEXT = 2000;
const KEEP = 5000;

/** The same id whichever of the two asks */
export function pairOf(a, b) {
    const ids = [ String(a ?? ""), String(b ?? "") ];
    if (!ids.every((id) => USER_ID.test(id)) || ids[0] === ids[1]) throw new Error("แชทนี้ไม่ถูกต้อง");
    return ids.sort().join("__");
}

const fileOf = (pair) => path.join(DM_DIR, `${pair}.json`);

async function load(pair) {
    try {
        const value = JSON.parse(await readFile(fileOf(pair), "utf8"));
        return Array.isArray(value?.messages) ? value.messages : [];
    } catch {
        return [];
    }
}

/**
 * @returns {Promise<{ id: string, from: string, text: string, at: number }>} the saved message
 */
export async function sendDm(from, to, text) {
    const clean = String(text ?? "").replace(/\r/g, "").trim().slice(0, MAX_TEXT);
    if (!clean) throw new Error("ยังไม่ได้พิมพ์อะไร");
    const pair = pairOf(from, to);
    const message = { id: `d${Date.now().toString(36)}${crypto.randomBytes(3).toString("hex")}`, from, text: clean, at: Date.now() };
    await mkdir(DM_DIR, { recursive: true });
    await withFileLock(fileOf(pair), async () => {
        const list = await load(pair);
        list.push(message);
        await writeAtomic(fileOf(pair), `${JSON.stringify({ messages: list.slice(-KEEP) })}\n`);
    });
    return message;
}

/** The latest messages (before a time, for scrolling back) */
export async function readDm(a, b, { before = Infinity, limit = 200 } = {}) {
    const list = await load(pairOf(a, b));
    return list.filter((m) => m.at < before).slice(-limit);
}

/** How many messages from the other person arrived after `since` */
export async function unreadCount(me, other, since = 0) {
    return (await load(pairOf(me, other))).filter((m) => m.from !== me && m.at > since).length;
}

/** The last message, for the chat list */
export async function lastDm(a, b) {
    return (await load(pairOf(a, b))).at(-1) ?? null;
}
