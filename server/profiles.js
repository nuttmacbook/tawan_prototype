import { mkdir, readFile, writeFile, readdir, rename, cp, rm, stat, link, copyFile } from "node:fs/promises";
import { AsyncLocalStorage } from "node:async_hooks";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { withFileLock, writeAtomic, readText as readFileText } from "./fsutil.js";

/* ------------------------------------ layout */

// data/
// ├── personas/<id>/            one folder per character: who she is and her own life (BOT_MD, life.json, owner.json)
// │   └── chats/<userId>/       her relationship with one user: memory, mood, history/, uploads/, pending…
// ├── users.json                accounts, friends, which chats each user has (server/users.js)
// ├── dm/                       chats between two real users (server/dm.js)
// ├── .snapshots/<id>/users/<userId>/   backups of one relationship (plus her files at that moment)
// ├── .trash/                   deleted characters (moved, never erased)
// └── settings.json             brain, push keys, invite code — shared by everyone
// Work without a user (tests, the old single-user layout) keeps everything in personas/<id>/ itself
// PERSONA_DATA_DIR lets tests run against a scratch folder instead of your real characters
const DATA_DIR = process.env.PERSONA_DATA_DIR
    ? `${path.resolve(process.env.PERSONA_DATA_DIR)}${path.sep}`
    : fileURLToPath(new URL("../data/", import.meta.url));
const PERSONAS_DIR = path.join(DATA_DIR, "personas");
const SNAP_DIR = path.join(DATA_DIR, ".snapshots");
const TRASH_DIR = path.join(DATA_DIR, ".trash");
const TEMPLATE_DIR = fileURLToPath(new URL("./templates/", import.meta.url));
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");
const SETTINGS_BACKUP = path.join(DATA_DIR, "settings.json.bak");

const MD_FILES = [ "persona", "style", "teachings", "memory", "state", "threads", "diary", "journal", "people", "today", "dates", "opinions", "relation" ];
// Hers, the same whoever she talks to: who she is, how she types, what the owner taught her,
// and her own life (her day, diary, people, opinions), so she tells everyone the same story
const BOT_MD = new Set([ "persona", "style", "teachings", "today", "diary", "people", "opinions" ]);
// Everything else (memory, mood, threads, journal, dates, relation) belongs to one relationship
// What a copied character keeps; everything about the relationship starts fresh
const IDENTITY_FILES = [ "persona", "style", "teachings" ];
// Her life as the system keeps it (city, story arcs, goals; coach suggestions; your routine).
// Not editable by hand, but part of her: snapshots and the portable file carry them too
const DATA_FILES = [ "life", "coach", "usage" ];
const BOT_DATA = new Set([ "life" ]);
const KEEP_SNAPSHOTS = 30;

let activeId = "";
// Which character each user has on screen (kept in users.json; mirrored here by server/index.js)
const activeByUser = new Map();

/* ------------------------------------ helpers */

const exists = async (p) => {
    try {
        await stat(p);
        return true;
    } catch {
        return false;
    }
};

const readText = async (file) => {
    try {
        return await readFile(file, "utf8");
    } catch {
        return "";
    }
};

const stamp = () => new Date().toLocaleString("sv-SE").replace(/[: ]/g, "-");
const today = () => new Date().toLocaleDateString("sv-SE");
const nameOf = (persona) => String(persona ?? "").match(/ชื่อ\s*[:：]\s*(.+)/)?.[1]?.trim() || "ไม่มีชื่อ";

/** Folder names are generated, never typed by the user, so they can't escape data/personas */
const safeId = (id) => {
    const clean = String(id ?? "");
    if (!/^[a-z0-9-]{1,40}$/.test(clean)) throw new Error("รหัสตัวละครไม่ถูกต้อง");
    return clean;
};

// User ids are generated too (server/users.js)
const USER_ID = /^u[a-z0-9]{6,24}$/;
const safeUser = (user) => {
    const clean = String(user ?? "");
    if (!USER_ID.test(clean)) throw new Error("รหัสผู้ใช้ไม่ถูกต้อง");
    return clean;
};

/** Unique even when two characters are made in the same millisecond */
const newId = () => `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

/* ------------------------------------ settings */

async function parseSettings(file) {
    const text = await readFile(file, "utf8");
    const value = JSON.parse(text);
    return value && typeof value === "object" ? value : {};
}

/**
 * Settings hold the phone key and the push keys, so a broken file must not quietly become {}:
 * that would hand out a new key and disconnect every phone. The last good copy is used instead.
 */
export async function loadSettings() {
    try {
        return await parseSettings(SETTINGS_FILE);
    } catch (err) {
        if (err?.code === "ENOENT") return {};
        try {
            return await parseSettings(SETTINGS_BACKUP);
        } catch {
            return {};
        }
    }
}

/**
 * @param {object | ((current: object) => object)} patch fields to set; a function gets the
 *   settings read inside the lock, for changes that build on what's already there
 */
export function saveSettings(patch) {
    return withFileLock(SETTINGS_FILE, async () => {
        const current = await loadSettings();
        const next = { ...current, ...(typeof patch === "function" ? patch(current) : patch) };
        await mkdir(DATA_DIR, { recursive: true });
        // Keep the previous good version next to it, in case this one is ever damaged
        if (Object.keys(current).length) await writeAtomic(SETTINGS_BACKUP, `${JSON.stringify(current, null, 4)}\n`);
        await writeAtomic(SETTINGS_FILE, `${JSON.stringify(next, null, 4)}\n`);
        return next;
    });
}

/* ------------------------------------ active character */

// A reply can take a minute. If you switch characters meanwhile, everything that reply
// writes must still land in the character (and the user) it belongs to, so work runs "pinned".
const pinned = new AsyncLocalStorage();

/** The user this piece of work is for ("" = no accounts: tests and the old layout) */
export const currentUser = () => pinned.getStore()?.user ?? "";

/** The character on screen for the current user */
export const getActiveId = () => activeByUser.get(currentUser()) ?? activeId;

/** The character this piece of work belongs to: the pinned one, or the one on screen */
export const currentId = () => pinned.getStore()?.bot ?? getActiveId();

/** One relationship: maps keyed by this keep each user's chat with her apart */
export const currentKey = () => (currentUser() ? `${currentId()}~${currentUser()}` : currentId());

/**
 * Runs fn with every file path fixed to one character and user, whatever happens to the active one meanwhile.
 * @template T
 * @param {() => Promise<T>} fn
 * @param {string} [id] defaults to the character active right now
 * @param {string} [user] defaults to the current user
 * @returns {Promise<T>}
 */
export const pinProfile = (fn, id = currentId(), user = currentUser()) => pinned.run({ bot: id, user }, fn);

/** For a user: work runs as them, on the character they have on screen */
export const asUser = (user, fn) => pinned.run({ bot: activeByUser.get(user) ?? activeId, user }, fn);

export const setActiveFor = (user, id) => {
    if (user && id) activeByUser.set(user, id);
};

/** Her own folder */
export const botDir = (id = currentId()) => path.join(PERSONAS_DIR, id || "_none");
/** The current relationship's folder: history/, uploads/, pending.json, memory… */
export const activeDir = () => (currentUser() ? path.join(botDir(), "chats", currentUser()) : botDir());
export const chatDirOf = (id, user) => path.join(botDir(id), "chats", user);
export const fileOf = (name) => path.join(BOT_MD.has(name) ? botDir() : activeDir(), `${name}.md`);
export const dataFileOf = (name) => path.join(BOT_DATA.has(name) ? botDir() : activeDir(), `${name}.json`);

/** Creates any missing md file from the templates, so a half-copied folder still works */
async function fillMissing(dir, names = MD_FILES) {
    await mkdir(dir, { recursive: true });
    if (names.some((n) => !BOT_MD.has(n))) await mkdir(path.join(dir, "history"), { recursive: true });
    for (const name of names) {
        const file = path.join(dir, `${name}.md`);
        if (!(await exists(file))) await writeFile(file, await readText(path.join(TEMPLATE_DIR, `${name}.md`)));
    }
}

const CHAT_MD = MD_FILES.filter((n) => !BOT_MD.has(n));

/** Her files, and the current user's chat with her, all there */
async function fillCurrent() {
    if (!currentUser()) return fillMissing(botDir());
    await fillMissing(botDir(), [ ...BOT_MD ]);
    await fillMissing(activeDir(), CHAT_MD);
}

/**
 * A user's own chat with her: made from the templates the first time they talk.
 * @param {string} id character
 * @param {string} user
 * @param {{ relation?: string }} [options] relation: how this user and she know each other (relation.md)
 */
export async function ensureChat(id, user, { relation = "" } = {}) {
    const dir = chatDirOf(safeId(id), safeUser(user));
    const isNew = !(await exists(dir));
    await fillMissing(dir, CHAT_MD);
    if (isNew && relation) await writeFile(path.join(dir, "relation.md"), relation);
    return isNew;
}

/** Everyone who has a chat with her */
export async function chatUsers(id) {
    try {
        return (await readdir(path.join(botDir(safeId(id)), "chats"), { withFileTypes: true }))
            .filter((e) => e.isDirectory() && USER_ID.test(e.name))
            .map((e) => e.name);
    } catch {
        return [];
    }
}

/* ------------------------------------ owner and visibility */

const metaFile = (id) => path.join(botDir(safeId(id)), "owner.json");

/**
 * Who made her and whether others can find her.
 * @returns {Promise<{ owner: string, isPublic: boolean, createdAt: number }>}
 */
export async function botMeta(id) {
    try {
        const value = JSON.parse(await readFile(metaFile(id), "utf8"));
        return { owner: String(value?.owner ?? ""), isPublic: value?.isPublic === true, createdAt: Number(value?.createdAt ?? 0) };
    } catch {
        return { owner: "", isPublic: false, createdAt: 0 };
    }
}

export function setBotMeta(id, patch) {
    const file = metaFile(id);
    return withFileLock(file, async () => {
        const next = { ...(await botMeta(id)), ...patch };
        await writeAtomic(file, `${JSON.stringify(next, null, 1)}\n`);
        return next;
    });
}

/** The current user made the character this work is pinned to (no accounts: everyone is) */
export async function isOwnerNow() {
    if (!currentUser()) return true;
    return (await botMeta(currentId())).owner === currentUser();
}

/**
 * Moves the old single-character layout (data/*.md) into data/personas/mali/.
 * Runs once; afterwards data/ only holds shared things.
 */
async function migrateLegacy() {
    if (!(await exists(path.join(DATA_DIR, "persona.md")))) return null;
    const id = (await exists(path.join(PERSONAS_DIR, "mali"))) ? newId() : "mali";
    const dir = path.join(PERSONAS_DIR, id);
    await mkdir(dir, { recursive: true });

    for (const name of [ ...MD_FILES.map((n) => `${n}.md`), "memory.backup.md", "history" ]) {
        const from = path.join(DATA_DIR, name);
        if (await exists(from)) await rename(from, path.join(dir, name));
    }
    await fillMissing(dir);
    return id;
}

/**
 * Picks the character to talk to at startup: migrated, saved, or the first one found.
 * @returns {Promise<string>} active id
 */
export async function initProfiles() {
    await mkdir(PERSONAS_DIR, { recursive: true });
    const migrated = await migrateLegacy();
    const ids = (await listProfiles()).map((p) => p.id);
    const saved = (await loadSettings())?.activePersona;

    if (migrated) activeId = migrated;
    else if (ids.includes(saved)) activeId = saved;
    else if (ids.length) activeId = ids[0];
    else activeId = await createProfile({ name: "เพื่อนใหม่" });

    // A character that belongs to someone keeps her chats under chats/ (see adoptLegacy)
    await fillMissing(botDir(activeId), (await exists(path.join(botDir(activeId), "owner.json"))) ? [ ...BOT_MD ] : MD_FILES);
    await saveSettings({ activePersona: activeId });
    return activeId;
}

/**
 * Every character with its display name, read from the "ชื่อ:" line.
 * @returns {Promise<{ id: string, name: string }[]>}
 */
export async function listProfiles() {
    let entries = [];
    try {
        entries = await readdir(PERSONAS_DIR, { withFileTypes: true });
    } catch {
        return [];
    }
    const rows = await Promise.all(entries
        .filter((e) => e.isDirectory() && /^[a-z0-9-]+$/.test(e.name))
        .map(async (e) => ({ id: e.name, name: nameOf(await readText(path.join(PERSONAS_DIR, e.name, "persona.md"))) })));
    return rows.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Makes a new character folder.
 * @param {{ name?: string, copyFrom?: string }} options copyFrom keeps identity, style and lessons of that character
 * @returns {Promise<string>} new id
 */
export async function createProfile({ name = "", copyFrom = "", owner = currentUser(), isPublic = false } = {}) {
    const id = newId();
    const dir = path.join(PERSONAS_DIR, id);
    await mkdir(dir, { recursive: true });
    if (owner) await writeFile(path.join(dir, "owner.json"), `${JSON.stringify({ owner, isPublic: isPublic === true, createdAt: Date.now() }, null, 1)}\n`);

    if (copyFrom) {
        const source = path.join(PERSONAS_DIR, safeId(copyFrom));
        for (const file of IDENTITY_FILES) {
            const text = await readText(path.join(source, `${file}.md`));
            if (text) await writeFile(path.join(dir, `${file}.md`), text);
        }
    }
    if (owner) {
        await fillMissing(dir, [ ...BOT_MD ]);
        await ensureChat(id, owner);
    } else {
        await fillMissing(dir);
    }

    const cleanName = String(name ?? "").trim().replace(/[\r\n]+/g, " ").slice(0, 40);
    if (cleanName) {
        const file = path.join(dir, "persona.md");
        const text = await readText(file);
        await writeFile(file, /ชื่อ\s*[:：]/.test(text) ? text.replace(/(ชื่อ\s*[:：]\s*).*/, `$1${cleanName}`) : `- ชื่อ: ${cleanName}\n${text}`);
    }
    return id;
}

export async function switchProfile(id) {
    const clean = safeId(id);
    if (!(await exists(path.join(PERSONAS_DIR, clean)))) throw new Error("ไม่พบตัวละครนี้");
    // With accounts, each user switches only their own screen (users.json keeps it)
    if (currentUser()) {
        activeByUser.set(currentUser(), clean);
        await pinProfile(fillCurrent, clean);
        return clean;
    }
    activeId = clean;
    await fillMissing(path.join(PERSONAS_DIR, clean));
    await saveSettings({ activePersona: clean });
    return clean;
}

/** Fills in anything missing for the current character and user (a chat opened for the first time) */
export const prepareCurrent = () => fillCurrent();

/** Moves a character to data/.trash so a mistaken delete can still be recovered by hand */
export async function deleteProfile(id) {
    const clean = safeId(id);
    if (clean === getActiveId()) throw new Error("ลบตัวละครที่กำลังคุยอยู่ไม่ได้ สลับไปตัวอื่นก่อน");
    await mkdir(TRASH_DIR, { recursive: true });
    await rename(path.join(PERSONAS_DIR, clean), path.join(TRASH_DIR, `${clean}-${stamp()}`));
}

/* ------------------------------------ snapshots */

const snapRoot = () => (currentUser() ? path.join(SNAP_DIR, currentId(), "users", currentUser()) : path.join(SNAP_DIR, currentId()));
// Snapshot folders start with their date; "users" (and anything else) isn't one
const SNAP_ID = /^\d{4}-\d{2}-\d{2}/;

/**
 * Copies a history folder. Archived days never change once archived, so they are hard-linked
 * instead of copied: 30 snapshots then cost about one copy of the archive, not thirty.
 */
async function copyHistory(from, to) {
    await mkdir(to, { recursive: true });
    for (const e of await readdir(from, { withFileTypes: true }).catch(() => [])) {
        const src = path.join(from, e.name);
        const dst = path.join(to, e.name);
        if (e.isDirectory() && e.name === "archive") {
            await mkdir(dst, { recursive: true });
            for (const f of await readdir(src).catch(() => [])) {
                await link(path.join(src, f), path.join(dst, f)).catch(() => copyFile(path.join(src, f), path.join(dst, f)));
            }
        } else if (e.isDirectory()) {
            await cp(src, dst, { recursive: true });
        } else {
            await copyFile(src, dst);
        }
    }
}

/**
 * Copies the active character's md files and chat history (not uploaded pictures).
 * @param {string} [label]
 * @param {{ keep?: string }} [options] keep: a snapshot id that must survive the clean-up
 * @returns {Promise<string>} snapshot id
 */
export async function snapshot(label = "", { keep = "" } = {}) {
    const id = `${stamp()}-${Math.random().toString(36).slice(2, 5)}`;
    const dir = path.join(snapRoot(), id);
    await mkdir(dir, { recursive: true });
    for (const name of MD_FILES) {
        const from = fileOf(name);
        if (await exists(from)) await cp(from, path.join(dir, `${name}.md`));
    }
    for (const name of DATA_FILES) {
        const from = dataFileOf(name);
        if (await exists(from)) await cp(from, path.join(dir, `${name}.json`));
    }
    if (await exists(path.join(activeDir(), "history"))) {
        await copyHistory(path.join(activeDir(), "history"), path.join(dir, "history"));
    }
    await writeFile(path.join(dir, "_label.txt"), String(label).slice(0, 200));

    const old = (await listSnapshots()).map((s) => s.id).filter((s) => s !== keep).slice(KEEP_SNAPSHOTS);
    for (const o of old) await rm(path.join(snapRoot(), o), { recursive: true, force: true });
    return id;
}

export async function listSnapshots() {
    try {
        const ids = (await readdir(snapRoot(), { withFileTypes: true })).filter((e) => e.isDirectory() && SNAP_ID.test(e.name)).map((e) => e.name);
        const rows = await Promise.all(ids.map(async (id) => ({ id, label: await readText(path.join(snapRoot(), id, "_label.txt")) })));
        return rows.sort((a, b) => b.id.localeCompare(a.id));
    } catch {
        return [];
    }
}

/** One automatic snapshot per character per day, taken on the first message of the day */
export async function dailySnapshot() {
    const done = (await listSnapshots()).some((s) => s.id.startsWith(today()) && s.label === "อัตโนมัติรายวัน");
    if (!done) await snapshot("อัตโนมัติรายวัน");
}

/**
 * Puts the character's memories back to that snapshot. Takes a snapshot of the current state first.
 * @returns {Promise<string>} id of the safety snapshot taken before restoring
 */
export async function restoreSnapshot(id) {
    const name = path.basename(String(id ?? ""));
    const dir = path.join(snapRoot(), name);
    if (!name || !(await exists(dir))) throw new Error("ไม่พบจุดสำรองนี้");
    // The safety copy must not push the one we're restoring out of the list
    const safety = await snapshot(`ก่อนย้อนกลับไป ${name}`, { keep: name });

    // Through the same file locks as every other writer, so "remember" or a hand edit
    // arriving mid-restore can't interleave with it
    for (const n of MD_FILES) {
        const from = path.join(dir, `${n}.md`);
        if (!(await exists(from))) continue;
        const text = await readFileText(from);
        await withFileLock(fileOf(n), () => writeAtomic(fileOf(n), text));
    }
    for (const n of DATA_FILES) {
        const from = path.join(dir, `${n}.json`);
        if (!(await exists(from))) continue;
        const text = await readFileText(from);
        const to = dataFileOf(n);
        await withFileLock(to, () => writeAtomic(to, text));
    }
    if (await exists(path.join(dir, "history"))) {
        // Today's log is the only history file anything else writes to
        const todayLog = path.join(activeDir(), "history", `${today()}.md`);
        await withFileLock(todayLog, async () => {
            await rm(path.join(activeDir(), "history"), { recursive: true, force: true });
            await cp(path.join(dir, "history"), path.join(activeDir(), "history"), { recursive: true });
        });
    }
    return safety;
}

/* ------------------------------------ moving to accounts */

const RELATION_HEADING = /^##\s*ความสัมพันธ์กับผู้ใช้\s*$/m;

/** Takes the "ความสัมพันธ์กับผู้ใช้" section out of persona.md: it was about one user only */
export function splitRelation(persona) {
    const text = String(persona ?? "");
    const m = RELATION_HEADING.exec(text);
    if (!m) return { persona: text, relation: "" };
    const rest = text.slice(m.index + m[0].length);
    const next = rest.search(/^##\s/m);
    const body = next < 0 ? rest : rest.slice(0, next);
    return {
        persona: `${text.slice(0, m.index)}${next < 0 ? "" : rest.slice(next)}`.replace(/\n{3,}/g, "\n\n").trimEnd() + "\n",
        relation: `## ความสัมพันธ์กับผู้ใช้คนนี้\n${body.trim()}\n`,
    };
}

const LEGACY_RELATION = [
    "## ความสัมพันธ์กับผู้ใช้คนนี้",
    "- รู้จักกันมาตั้งแต่ก่อนแล้ว คนนี้คือคนที่คุณคุยด้วยในแชทนี้มาตลอด (ดูความจำ ไดอารี่ และประวัติแชท)",
    "",
].join("\n");

// Files and folders of a relationship that the old layout kept in the character's own folder
const CHAT_THINGS = [ ...CHAT_MD.map((n) => `${n}.md`), "memory.backup.md", "history", "uploads", "pending.json", "usage.json", "coach.json" ];

/**
 * The first account takes over everything from before accounts: each character becomes theirs,
 * her chat with "you" becomes their chat, and her backups move with it. Runs once per character.
 * @returns {Promise<string[]>} characters moved
 */
export async function adoptLegacy(user) {
    const owner = safeUser(user);
    const moved = [];
    for (const { id } of await listProfiles()) {
        const dir = botDir(id);
        if (await exists(path.join(dir, "owner.json"))) continue;
        const chat = chatDirOf(id, owner);
        await mkdir(chat, { recursive: true });
        for (const name of CHAT_THINGS) {
            const from = path.join(dir, name);
            if ((await exists(from)) && !(await exists(path.join(chat, name)))) await rename(from, path.join(chat, name));
        }
        const personaFile = path.join(dir, "persona.md");
        const { persona, relation } = splitRelation(await readText(personaFile));
        if (relation) {
            await copyFile(personaFile, path.join(dir, "persona.before-accounts.md")).catch(() => {});
            await writeAtomic(path.join(chat, "relation.md"), relation);
            await writeAtomic(personaFile, persona);
        } else if (!(await exists(path.join(chat, "relation.md"))) || (await readText(path.join(chat, "relation.md"))) === (await readText(path.join(TEMPLATE_DIR, "relation.md")))) {
            // Not "just found you in the app": this is the person she's been talking to all along
            await writeAtomic(path.join(chat, "relation.md"), LEGACY_RELATION);
        }
        // Backups of this chat now live under the user
        const snaps = path.join(SNAP_DIR, id);
        for (const e of await readdir(snaps, { withFileTypes: true }).catch(() => [])) {
            if (!e.isDirectory() || !SNAP_ID.test(e.name)) continue;
            await mkdir(path.join(snaps, "users", owner), { recursive: true });
            await rename(path.join(snaps, e.name), path.join(snaps, "users", owner, e.name)).catch(() => {});
        }
        await writeFile(path.join(dir, "owner.json"), `${JSON.stringify({ owner, isPublic: false, createdAt: Date.now() }, null, 1)}\n`);
        await fillMissing(dir, [ ...BOT_MD ]);
        await fillMissing(chat, CHAT_MD);
        moved.push(id);
    }
    return moved;
}

export { DATA_DIR, PERSONAS_DIR, MD_FILES, DATA_FILES, BOT_MD, USER_ID };
