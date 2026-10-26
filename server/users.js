import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { DATA_DIR, loadSettings, saveSettings } from "./profiles.js";
import { withFileLock, writeAtomic } from "./fsutil.js";

/* ------------------------------------ accounts */

// Everyone who uses this server. One small file is plenty for a handful of testers;
// every change goes through the file lock, so two signups at once can't drop each other.
const USERS_FILE = path.join(DATA_DIR, "users.json");
const scrypt = promisify(crypto.scrypt);

const HANDLE = /^[a-z0-9_.]{3,20}$/;
const MIN_PASSWORD = 6;
const COOKIE = "sid";
const SESSION_DAYS = 60;

const newUserId = () => `u${crypto.randomBytes(6).toString("hex")}`;

async function loadAll() {
    try {
        const value = JSON.parse(await readFile(USERS_FILE, "utf8"));
        return value && typeof value === "object" && value.users && typeof value.users === "object" ? value : { users: {} };
    } catch {
        return { users: {} };
    }
}

/** Reads, changes and saves users.json inside the lock; fn may return a value to hand back */
function change(fn) {
    return withFileLock(USERS_FILE, async () => {
        const all = await loadAll();
        const result = await fn(all);
        await writeAtomic(USERS_FILE, `${JSON.stringify(all, null, 1)}\n`);
        return result;
    });
}

const cleanName = (s) => String(s ?? "").replace(/[\r\n\t]+/g, " ").replace(/[<>]/g, "").trim().slice(0, 40);
export const cleanHandle = (s) => String(s ?? "").trim().replace(/^@/, "").toLowerCase();

/** What other people may see about a user */
export const publicUser = (u) => (u ? { id: u.id, handle: u.handle, name: u.name } : null);

const blank = (u) => ({
    friends: [],
    incoming: [],
    outgoing: [],
    chats: [],
    activeBot: "",
    dmRead: {},
    tokenVersion: 1,
    ...u,
});

export async function listUsers() {
    return Object.values((await loadAll()).users).map(blank);
}

export async function getUser(id) {
    const u = (await loadAll()).users[String(id ?? "")];
    return u ? blank(u) : null;
}

export async function findByHandle(handle) {
    const h = cleanHandle(handle);
    return (await listUsers()).find((u) => u.handle === h) ?? null;
}

export const hasUsers = async () => (await listUsers()).length > 0;

async function hashPassword(password, salt = crypto.randomBytes(16)) {
    const key = await scrypt(String(password), salt, 64);
    return `scrypt:${salt.toString("base64")}:${key.toString("base64")}`;
}

async function checkPassword(password, stored) {
    const [ kind, salt, key ] = String(stored ?? "").split(":");
    if (kind !== "scrypt" || !salt || !key) return false;
    const expected = Buffer.from(key, "base64");
    const actual = await scrypt(String(password), Buffer.from(salt, "base64"), expected.length);
    return crypto.timingSafeEqual(expected, actual);
}

/** The invite code new users need; made on first ask, changed by the admin */
export async function inviteCode({ rotate = false } = {}) {
    const settings = await loadSettings();
    if (settings?.inviteCode && !rotate) return settings.inviteCode;
    const code = crypto.randomBytes(5).toString("hex");
    await saveSettings({ inviteCode: code });
    return code;
}

/**
 * Makes an account. The very first one is the admin (the person running this server) and needs no invite.
 * @returns {Promise<object>} the new user
 */
export async function register({ name, handle, password, invite = "" }) {
    const n = cleanName(name);
    const h = cleanHandle(handle);
    if (!n) throw new Error("ใส่ชื่อที่แสดงก่อน");
    if (!HANDLE.test(h)) throw new Error("ไอดีใช้ a-z 0-9 _ . ยาว 3–20 ตัว");
    if (String(password ?? "").length < MIN_PASSWORD) throw new Error(`รหัสผ่านอย่างน้อย ${MIN_PASSWORD} ตัว`);
    const passHash = await hashPassword(password);
    const code = await inviteCode();
    return change((all) => {
        const list = Object.values(all.users);
        const isFirst = list.length === 0;
        if (!isFirst && String(invite ?? "").trim() !== code) throw new Error("รหัสเชิญไม่ถูกต้อง (ขอจากคนที่เปิดเซิร์ฟเวอร์)");
        if (list.some((u) => u.handle === h)) throw new Error("ไอดีนี้มีคนใช้แล้ว");
        const user = blank({ id: newUserId(), handle: h, name: n, passHash, role: isFirst ? "admin" : "user", createdAt: Date.now() });
        all.users[user.id] = user;
        return user;
    });
}

/** @returns {Promise<object | null>} the user, or null when the handle or password is wrong */
export async function login(handle, password) {
    const user = await findByHandle(handle);
    // Same work whether the account exists or not, so timing doesn't tell which handles are real
    const ok = await checkPassword(password, user?.passHash ?? "scrypt:AAAAAAAAAAAAAAAAAAAAAA==:" + "A".repeat(86) + "==");
    return ok && user ? user : null;
}

export async function changePassword(id, oldPassword, newPassword) {
    const user = await getUser(id);
    if (!user || !(await checkPassword(oldPassword, user.passHash))) throw new Error("รหัสผ่านเดิมไม่ถูกต้อง");
    if (String(newPassword ?? "").length < MIN_PASSWORD) throw new Error(`รหัสผ่านอย่างน้อย ${MIN_PASSWORD} ตัว`);
    const passHash = await hashPassword(newPassword);
    // A new version signs every other device out
    await change((all) => {
        all.users[id].passHash = passHash;
        all.users[id].tokenVersion = Number(all.users[id].tokenVersion ?? 1) + 1;
    });
}

export function updateProfile(id, { name } = {}) {
    return change((all) => {
        const u = all.users[id];
        if (!u) throw new Error("ไม่พบผู้ใช้");
        if (name !== undefined) {
            const n = cleanName(name);
            if (!n) throw new Error("ใส่ชื่อที่แสดงก่อน");
            u.name = n;
        }
        return blank(u);
    });
}

/* ------------------------------------ sign-in cookie */

async function secret() {
    const settings = await loadSettings();
    if (settings?.authSecret) return Buffer.from(settings.authSecret, "base64");
    const value = crypto.randomBytes(32).toString("base64");
    const saved = await saveSettings((current) => (current?.authSecret ? {} : { authSecret: value }));
    return Buffer.from(saved.authSecret, "base64");
}

const sign = async (body) => crypto.createHmac("sha256", await secret()).update(body).digest("base64url");

/** A signed cookie value: user, token version (bumped to sign out everywhere) and expiry */
export async function sessionCookie(user, { secure = false } = {}) {
    const exp = Date.now() + SESSION_DAYS * 86400000;
    const body = `${user.id}.${Number(user.tokenVersion ?? 1)}.${exp}`;
    const value = `${body}.${await sign(body)}`;
    return `${COOKIE}=${value}; Path=/; Max-Age=${SESSION_DAYS * 86400}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

export const clearCookie = (secure = false) => `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;

const cookieOf = (req, name) =>
    String(req?.headers?.cookie ?? "").split(";").map((c) => c.trim().split("=")).find(([ k ]) => k === name)?.[1] ?? "";

/** @returns {Promise<object | null>} the signed-in user of this request */
export async function userOf(req) {
    const [ id, ver, exp, sig ] = cookieOf(req, COOKIE).split(".");
    if (!id || !sig || !(Number(exp) > Date.now())) return null;
    const expected = Buffer.from(await sign(`${id}.${ver}.${exp}`));
    const given = Buffer.from(sig);
    if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
    const user = await getUser(id);
    return user && String(user.tokenVersion ?? 1) === ver ? user : null;
}

/* ------------------------------------ chats and screen */

export function setActiveBot(id, bot) {
    return change((all) => {
        if (!all.users[id]) return;
        all.users[id].activeBot = String(bot ?? "");
        if (bot && !(all.users[id].chats ?? []).includes(bot)) all.users[id].chats = [ ...(all.users[id].chats ?? []), bot ];
    });
}

export function addChat(id, bot) {
    return change((all) => {
        const u = all.users[id];
        if (!u) return;
        if (!(u.chats ?? []).includes(bot)) u.chats = [ ...(u.chats ?? []), bot ];
    });
}

export function removeChat(id, bot) {
    return change((all) => {
        const u = all.users[id];
        if (!u) return;
        u.chats = (u.chats ?? []).filter((b) => b !== bot);
        if (u.activeBot === bot) u.activeBot = "";
    });
}

/** A character removed for good: out of everyone's list */
export function dropBotEverywhere(bot) {
    return change((all) => {
        for (const u of Object.values(all.users)) {
            u.chats = (u.chats ?? []).filter((b) => b !== bot);
            if (u.activeBot === bot) u.activeBot = "";
        }
    });
}

/* ------------------------------------ friends */

/**
 * Asks to be friends. If they already asked you, you're friends right away.
 * @returns {Promise<"friends" | "requested">}
 */
export function requestFriend(from, to) {
    return change((all) => {
        const a = all.users[from];
        const b = all.users[to];
        if (!a || !b) throw new Error("ไม่พบผู้ใช้");
        if (from === to) throw new Error("เพิ่มตัวเองไม่ได้");
        for (const u of [ a, b ]) Object.assign(u, { ...blank({}), ...u });
        if (a.friends.includes(to)) return "friends";
        if (a.incoming.includes(to)) {
            a.incoming = a.incoming.filter((x) => x !== to);
            b.outgoing = b.outgoing.filter((x) => x !== from);
            a.friends.push(to);
            b.friends.push(from);
            return "friends";
        }
        if (!a.outgoing.includes(to)) a.outgoing.push(to);
        if (!b.incoming.includes(from)) b.incoming.push(from);
        return "requested";
    });
}

/** Accept (true) or decline (false) a request someone sent you */
export function answerFriend(me, from, accept) {
    return change((all) => {
        const a = all.users[me];
        const b = all.users[from];
        if (!a || !b) throw new Error("ไม่พบผู้ใช้");
        for (const u of [ a, b ]) Object.assign(u, { ...blank({}), ...u });
        if (!a.incoming.includes(from)) return false;
        a.incoming = a.incoming.filter((x) => x !== from);
        b.outgoing = b.outgoing.filter((x) => x !== me);
        if (accept) {
            if (!a.friends.includes(from)) a.friends.push(from);
            if (!b.friends.includes(me)) b.friends.push(me);
        }
        return true;
    });
}

export function removeFriend(me, other) {
    return change((all) => {
        for (const [ x, y ] of [ [ me, other ], [ other, me ] ]) {
            const u = all.users[x];
            if (!u) continue;
            for (const k of [ "friends", "incoming", "outgoing" ]) u[k] = (u[k] ?? []).filter((v) => v !== y);
        }
    });
}

export const areFriends = async (a, b) => Boolean((await getUser(a))?.friends?.includes(b));

export function markDmRead(me, pair, at = Date.now()) {
    return change((all) => {
        const u = all.users[me];
        if (!u) return;
        u.dmRead = { ...(u.dmRead ?? {}), [pair]: at };
    });
}

/* ------------------------------------ search */

/** People by name or @id, best match first */
export async function searchUsers(query, { exclude = "" } = {}) {
    const q = cleanHandle(query);
    if (!q) return [];
    const score = (u) => (u.handle === q ? 0 : u.handle.startsWith(q) ? 1 : u.name.toLowerCase().includes(q) || u.handle.includes(q) ? 2 : 9);
    return (await listUsers())
        .filter((u) => u.id !== exclude && score(u) < 9)
        .sort((a, b) => score(a) - score(b) || a.name.localeCompare(b.name))
        .slice(0, 20);
}

export { HANDLE };
