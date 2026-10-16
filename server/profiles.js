import { mkdir, readFile, writeFile, readdir, rename, cp, rm, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

/* ------------------------------------ layout */

// data/
// ├── personas/<id>/      one folder per character: md files, history/, uploads/
// ├── .snapshots/<id>/    automatic and manual backups of a character's data
// ├── .trash/             deleted characters (moved, never erased)
// └── settings.json       brain, active character, phone key — shared by all characters
const DATA_DIR = fileURLToPath(new URL("../data/", import.meta.url));
const PERSONAS_DIR = path.join(DATA_DIR, "personas");
const SNAP_DIR = path.join(DATA_DIR, ".snapshots");
const TRASH_DIR = path.join(DATA_DIR, ".trash");
const TEMPLATE_DIR = fileURLToPath(new URL("./templates/", import.meta.url));
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");

const MD_FILES = [ "persona", "style", "teachings", "memory", "state", "threads", "diary", "journal" ];
// What a copied character keeps; everything about the relationship starts fresh
const IDENTITY_FILES = [ "persona", "style", "teachings" ];
const KEEP_SNAPSHOTS = 30;

let activeId = "";

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

/* ------------------------------------ settings */

export async function loadSettings() {
    try {
        return JSON.parse(await readFile(SETTINGS_FILE, "utf8")) ?? {};
    } catch {
        return {};
    }
}

export async function saveSettings(patch) {
    const next = { ...(await loadSettings()), ...patch };
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(SETTINGS_FILE, `${JSON.stringify(next, null, 4)}\n`);
    return next;
}

/* ------------------------------------ active character */

export const activeDir = () => path.join(PERSONAS_DIR, activeId || "_none");
export const getActiveId = () => activeId;
export const fileOf = (name) => path.join(activeDir(), `${name}.md`);

/** Creates any missing md file from the templates, so a half-copied folder still works */
async function fillMissing(dir) {
    await mkdir(path.join(dir, "history"), { recursive: true });
    for (const name of MD_FILES) {
        const file = path.join(dir, `${name}.md`);
        if (!(await exists(file))) await writeFile(file, await readText(path.join(TEMPLATE_DIR, `${name}.md`)));
    }
}

/**
 * Moves the old single-character layout (data/*.md) into data/personas/mali/.
 * Runs once; afterwards data/ only holds shared things.
 */
async function migrateLegacy() {
    if (!(await exists(path.join(DATA_DIR, "persona.md")))) return null;
    const id = (await exists(path.join(PERSONAS_DIR, "mali"))) ? `p${Date.now().toString(36)}` : "mali";
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

    await fillMissing(activeDir());
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
export async function createProfile({ name = "", copyFrom = "" } = {}) {
    const id = `p${Date.now().toString(36)}`;
    const dir = path.join(PERSONAS_DIR, id);
    await mkdir(dir, { recursive: true });

    if (copyFrom) {
        const source = path.join(PERSONAS_DIR, safeId(copyFrom));
        for (const file of IDENTITY_FILES) {
            const text = await readText(path.join(source, `${file}.md`));
            if (text) await writeFile(path.join(dir, `${file}.md`), text);
        }
    }
    await fillMissing(dir);

    const cleanName = String(name ?? "").trim().slice(0, 40);
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
    activeId = clean;
    await fillMissing(activeDir());
    await saveSettings({ activePersona: clean });
    return clean;
}

/** Moves a character to data/.trash so a mistaken delete can still be recovered by hand */
export async function deleteProfile(id) {
    const clean = safeId(id);
    if (clean === activeId) throw new Error("ลบตัวละครที่กำลังคุยอยู่ไม่ได้ สลับไปตัวอื่นก่อน");
    await mkdir(TRASH_DIR, { recursive: true });
    await rename(path.join(PERSONAS_DIR, clean), path.join(TRASH_DIR, `${clean}-${stamp()}`));
}

/* ------------------------------------ snapshots */

const snapRoot = () => path.join(SNAP_DIR, activeId);

/**
 * Copies the active character's md files and chat history (not uploaded pictures).
 * @returns {Promise<string>} snapshot id
 */
export async function snapshot(label = "") {
    const id = `${stamp()}-${Math.random().toString(36).slice(2, 5)}`;
    const dir = path.join(snapRoot(), id);
    await mkdir(dir, { recursive: true });
    for (const name of MD_FILES) {
        const from = fileOf(name);
        if (await exists(from)) await cp(from, path.join(dir, `${name}.md`));
    }
    if (await exists(path.join(activeDir(), "history"))) {
        await cp(path.join(activeDir(), "history"), path.join(dir, "history"), { recursive: true });
    }
    await writeFile(path.join(dir, "_label.txt"), String(label).slice(0, 200));

    const all = (await listSnapshots()).map((s) => s.id);
    for (const old of all.slice(KEEP_SNAPSHOTS)) await rm(path.join(snapRoot(), old), { recursive: true, force: true });
    return id;
}

export async function listSnapshots() {
    try {
        const ids = (await readdir(snapRoot(), { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
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
    const dir = path.join(snapRoot(), path.basename(String(id ?? "")));
    if (!(await exists(dir))) throw new Error("ไม่พบจุดสำรองนี้");
    const safety = await snapshot(`ก่อนย้อนกลับไป ${id}`);

    for (const name of MD_FILES) {
        const from = path.join(dir, `${name}.md`);
        if (await exists(from)) await cp(from, fileOf(name));
    }
    if (await exists(path.join(dir, "history"))) {
        await rm(path.join(activeDir(), "history"), { recursive: true, force: true });
        await cp(path.join(dir, "history"), path.join(activeDir(), "history"), { recursive: true });
    }
    return safety;
}

export { DATA_DIR, PERSONAS_DIR, MD_FILES };
