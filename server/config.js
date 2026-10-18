import { loadSettings, saveSettings } from "./profiles.js";

/* ------------------------------------ app settings you can change from the page */

// Each one used to live only in .env, so changing it meant editing a file and restarting.
// Now the page saves them in settings.json; .env (or the default here) is only the starting value.
export const FIELDS = {
    idleMinutes:     { type: "number", env: "IDLE_MINUTES",     def: 15,   min: 0,    max: 240,    label: "เงียบกี่นาทีแล้วเธอทักมา (0 = ไม่ทัก)" },
    awayPingHours:   { type: "number", env: "AWAY_PING_HOURS",  def: 4,    min: 0,    max: 72,     label: "ปิดแชทไปกี่ชั่วโมงแล้วเธออาจทักมาเอง (0 = ไม่ทัก)" },
    awayPerDay:      { type: "number", env: "AWAY_PER_DAY",     def: 2,    min: 0,    max: 10,     label: "ทักตอนปิดแชทได้วันละกี่ครั้ง" },
    memoryBudget:    { type: "number", env: "MEMORY_BUDGET",    def: 3500, min: 1000, max: 30000,  label: "ความจำยาวเกินกี่ตัวอักษรแล้วส่งเฉพาะที่เกี่ยวข้อง" },
    teachingsBudget: { type: "number", env: "TEACHINGS_BUDGET", def: 2500, min: 1000, max: 30000,  label: "สิ่งที่สอนยาวเกินกี่ตัวอักษรแล้วส่งเฉพาะที่เกี่ยวข้อง" },
    autoTidyChars:   { type: "number", env: "AUTO_TIDY_CHARS",  def: 8000, min: 0,    max: 200000, label: "ความจำยาวเกินกี่ตัวอักษรแล้วจัดระเบียบเองวันละครั้ง (0 = ไม่จัด)" },
    pushPreview:     { type: "bool",   env: "PUSH_PREVIEW",     def: true,                         label: "แสดงข้อความในแจ้งเตือน (ปิด = ขึ้นแค่ว่ามีข้อความ)" },
};

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/** A raw value (from .env, settings or the page) made safe for one field, or undefined if unusable */
function clean(field, raw) {
    if (raw == null || raw === "") return undefined;
    if (field.type === "bool") {
        if (typeof raw === "boolean") return raw;
        if (/^(1|true|yes|ใช่|เปิด)$/i.test(String(raw))) return true;
        if (/^(0|false|no|ไม่|ปิด)$/i.test(String(raw))) return false;
        return undefined;
    }
    const n = Number(raw);
    return Number.isFinite(n) ? clamp(Math.round(n), field.min, field.max) : undefined;
}

const defaults = () =>
    Object.fromEntries(Object.entries(FIELDS).map(([ key, f ]) => [ key, clean(f, process.env[f.env]) ?? f.def ]));

// Read on every reply and every minute by the scheduler; a short cache keeps that off the disk
let cache = null;
let version = 0;
const CACHE_MS = 2000;

/** Current settings: what the page saved, otherwise .env, otherwise the default */
export async function getConfig() {
    if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
    // A read that started before a save must not put the old values back in the cache
    const started = version;
    const saved = (await loadSettings())?.config ?? {};
    const value = defaults();
    for (const [ key, f ] of Object.entries(FIELDS)) {
        const v = clean(f, saved[key]);
        if (v !== undefined) value[key] = v;
    }
    if (started === version) cache = { at: Date.now(), value };
    return value;
}

/**
 * Saves the fields the page sent; unknown keys and unusable values are ignored.
 * @returns {Promise<object>} the settings now in effect
 */
export async function setConfig(patch) {
    const changes = {};
    for (const [ key, f ] of Object.entries(FIELDS)) {
        const v = clean(f, patch?.[key]);
        if (v !== undefined) changes[key] = v;
    }
    await saveSettings((current) => ({ config: { ...(current?.config ?? {}), ...changes } }));
    version++;
    cache = null;
    return getConfig();
}

/** Labels and limits for the settings form */
export const describeConfig = () =>
    Object.entries(FIELDS).map(([ key, f ]) => ({ key, type: f.type, label: f.label, min: f.min, max: f.max, def: f.def }));
