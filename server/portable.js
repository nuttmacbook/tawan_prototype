import { mkdir, readFile, writeFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { PERSONAS_DIR, MD_FILES, DATA_FILES, listProfiles, createProfile, loadSettings, saveSettings } from "./profiles.js";

/* ------------------------------------ format */

// One plain JSON file per character: easy to move, back up, or send to a friend.
const FORMAT = "persona-agent";
const VERSION = 1;
const IDENTITY_FILES = [ "persona", "style", "teachings" ];
// Written into every day folder this app makes, so clean-up never deletes a folder it didn't make
const BACKUP_MARK = ".persona-agent-backup";
const DAY_FILE = /^\d{4}-\d{2}-\d{2}\.md$/;
const UPLOAD_FILE = /^[a-z0-9]+\.(jpg|png|webp|gif)$/;
const MAX_IMPORT_BYTES = 60 * 1024 * 1024;

const readText = async (file) => {
    try {
        return await readFile(file, "utf8");
    } catch {
        return "";
    }
};

const listDir = async (dir) => {
    try {
        return await readdir(dir);
    } catch {
        return [];
    }
};

const nameOf = (persona) => String(persona ?? "").match(/ชื่อ\s*[:：]\s*(.+)/)?.[1]?.trim() || "ไม่มีชื่อ";
const safeFileName = (s) => String(s ?? "").replace(/[\\/:*?"<>|\s]+/g, "-").slice(0, 40) || "character";
const today = () => new Date().toLocaleDateString("sv-SE");

/* ------------------------------------ export */

/**
 * Packs one character into a portable object.
 * @param {string} id
 * @param {{ mode?: "full" | "identity", withImages?: boolean }} options
 *   full: everything (moving computers, backups) · identity: persona, style and lessons only (sharing)
 */
export async function exportProfile(id, { mode = "full", withImages = false } = {}) {
    const dir = path.join(PERSONAS_DIR, String(id ?? ""));
    if (!/^[a-z0-9-]+$/.test(String(id ?? "")) || !(await stat(dir).catch(() => null))) throw new Error("ไม่พบตัวละครนี้");

    const isFull = mode !== "identity";
    const files = {};
    for (const name of isFull ? MD_FILES : IDENTITY_FILES) files[name] = await readText(path.join(dir, `${name}.md`));

    const pack = { format: FORMAT, version: VERSION, mode: isFull ? "full" : "identity", name: nameOf(files.persona), exportedAt: new Date().toISOString(), files };
    if (!isFull) return pack;

    pack.history = {};
    for (const f of (await listDir(path.join(dir, "history"))).filter((x) => DAY_FILE.test(x))) {
        pack.history[f] = await readText(path.join(dir, "history", f));
    }
    for (const f of (await listDir(path.join(dir, "history", "archive"))).filter((x) => DAY_FILE.test(x))) {
        pack.history[`archive/${f}`] = await readText(path.join(dir, "history", "archive", f));
    }
    const pending = await readText(path.join(dir, "pending.json"));
    if (pending) pack.pending = pending;
    // City, story arcs and goals, coach suggestions, your routine: without these a moved
    // character would wake up in a new city with no goals
    pack.data = {};
    for (const name of DATA_FILES) {
        const text = await readText(path.join(dir, `${name}.json`));
        if (text) pack.data[name] = text;
    }

    if (withImages) {
        pack.uploads = {};
        for (const f of (await listDir(path.join(dir, "uploads"))).filter((x) => UPLOAD_FILE.test(x))) {
            pack.uploads[f] = (await readFile(path.join(dir, "uploads", f))).toString("base64");
        }
    }
    return pack;
}

export const exportFileName = (pack) => `${safeFileName(pack?.name)}-${today()}${pack?.mode === "identity" ? "-ตัวตน" : ""}.persona.json`;

/* ------------------------------------ import */

/**
 * Creates a new character from an exported file. Never overwrites an existing one,
 * and only writes known file names, so a crafted file can't place files elsewhere.
 * @param {object | string} input parsed object or JSON text
 * @returns {Promise<{ id: string, name: string }>}
 */
export async function importProfile(input) {
    const raw = typeof input === "string" ? input : JSON.stringify(input ?? {});
    if (raw.length > MAX_IMPORT_BYTES) throw new Error("ไฟล์ใหญ่เกินไป");

    let pack;
    try {
        pack = typeof input === "string" ? JSON.parse(input) : input;
    } catch {
        throw new Error("ไฟล์ไม่ใช่ไฟล์ตัวละคร");
    }
    if (pack?.format !== FORMAT || typeof pack?.files !== "object") throw new Error("ไฟล์ไม่ใช่ไฟล์ตัวละครของแอปนี้");
    if (Number(pack.version) > VERSION) throw new Error("ไฟล์มาจากแอปเวอร์ชันใหม่กว่า อัปเดตแอปก่อน");
    if (typeof pack.files.persona !== "string" || !pack.files.persona.trim()) throw new Error("ไฟล์ไม่มีตัวตนของตัวละคร");

    const id = await createProfile({});
    const dir = path.join(PERSONAS_DIR, id);

    for (const name of MD_FILES) {
        const text = pack.files[name];
        if (typeof text === "string" && text.trim()) await writeFile(path.join(dir, `${name}.md`), text);
    }

    for (const [ key, text ] of Object.entries(pack.history ?? {})) {
        const isArchive = key.startsWith("archive/");
        const file = isArchive ? key.slice(8) : key;
        if (!DAY_FILE.test(file) || typeof text !== "string") continue;
        const target = path.join(dir, "history", ...(isArchive ? [ "archive" ] : []));
        await mkdir(target, { recursive: true });
        await writeFile(path.join(target, file), text);
    }

    if (typeof pack.pending === "string") {
        try {
            if (Array.isArray(JSON.parse(pack.pending))) await writeFile(path.join(dir, "pending.json"), pack.pending);
        } catch {}
    }

    // Known names only, and each must be a JSON object, so a crafted file can't plant anything else
    for (const name of DATA_FILES) {
        const text = pack.data?.[name];
        if (typeof text !== "string") continue;
        try {
            const value = JSON.parse(text);
            if (value && typeof value === "object" && !Array.isArray(value)) await writeFile(path.join(dir, `${name}.json`), `${JSON.stringify(value, null, 1)}\n`);
        } catch {}
    }

    for (const [ file, b64 ] of Object.entries(pack.uploads ?? {})) {
        if (!UPLOAD_FILE.test(file) || typeof b64 !== "string") continue;
        await mkdir(path.join(dir, "uploads"), { recursive: true });
        await writeFile(path.join(dir, "uploads", file), Buffer.from(b64, "base64"));
    }

    return { id, name: nameOf(pack.files.persona) };
}

/* ------------------------------------ backup to an outside folder */

// Point BACKUP_DIR at a folder that Google Drive, OneDrive or Dropbox syncs,
// and every character is copied off this computer once a day.
const BACKUP_DIR = process.env.BACKUP_DIR ? path.resolve(process.env.BACKUP_DIR) : "";
const KEEP_DAYS = Number(process.env.BACKUP_KEEP ?? 14) || 14;

export const backupInfo = async () => ({
    dir: BACKUP_DIR,
    lastAt: (await loadSettings())?.lastOutsideBackup ?? "",
});

/**
 * Writes a full export of every character into BACKUP_DIR/<date>/, then deletes days beyond KEEP_DAYS.
 * Pictures are left out to keep the cloud folder small.
 * @returns {Promise<{ dir: string, count: number }>}
 */
export async function backupAll() {
    if (!BACKUP_DIR) throw new Error("ยังไม่ได้ตั้ง BACKUP_DIR ในไฟล์ .env");
    const dayDir = path.join(BACKUP_DIR, today());
    await mkdir(dayDir, { recursive: true });
    await writeFile(path.join(dayDir, BACKUP_MARK), "Made by persona-agent. Folders without this file are never deleted.\n");

    const profiles = await listProfiles();
    for (const p of profiles) {
        const pack = await exportProfile(p.id, { mode: "full" });
        await writeFile(path.join(dayDir, `${p.id}-${safeFileName(pack.name)}.persona.json`), JSON.stringify(pack));
    }

    const days = [];
    for (const d of (await listDir(BACKUP_DIR)).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x)).sort()) {
        if (await stat(path.join(BACKUP_DIR, d, BACKUP_MARK)).catch(() => null)) days.push(d);
    }
    for (const old of days.slice(0, Math.max(0, days.length - KEEP_DAYS))) {
        await rm(path.join(BACKUP_DIR, old), { recursive: true, force: true });
    }

    await saveSettings({ lastOutsideBackup: new Date().toISOString() });
    return { dir: dayDir, count: profiles.length };
}

/** Checks hourly; the first check of a new day makes that day's copy */
export function startBackupScheduler() {
    if (!BACKUP_DIR) return;
    const run = async () => {
        try {
            const last = String((await loadSettings())?.lastOutsideBackup ?? "");
            if (last && new Date(last).toLocaleDateString("sv-SE") === today()) return;
            const { dir, count } = await backupAll();
            console.log(`  💾 สำรองตัวละคร ${count} ตัวไปที่ ${dir}`);
        } catch (err) {
            console.error("  ⚠ สำรองไปโฟลเดอร์นอกไม่สำเร็จ:", err?.message ?? err);
        }
    };
    setTimeout(run, 30000);
    setInterval(run, 3600000);
}
