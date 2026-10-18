import { FILES, safeRead } from "./store.js";
import { withFileLock, writeAtomic } from "./fsutil.js";

/* ------------------------------------ config */

const DECAY_PER_HOUR = 1;          // mood points that drift back to normal each hour
const LONELY_AFTER_HOURS = 6;      // away longer than this starts to make the persona lonely
const LONELY_PER_HOURS = 12;       // +1 loneliness per this many hours away
const LONELY_CAP = 8;
const CLOSENESS_PER_MESSAGE = 0.3;
const MAX_MESSAGES_COUNTED = 3;    // a burst of ten one-word messages shouldn't buy ten times the closeness
const MAX_MOOD_STEP = 3;           // one message can't swing a mood more than this
const MAX_CLOSENESS_STEP = 5;

const DEFAULT_MOODS = [
    { name: "ดีใจ",     value: 6, base: 6 },
    { name: "เหงา",     value: 3, base: 3 },
    { name: "งอน",      value: 0, base: 0 },
    { name: "เหนื่อย",   value: 3, base: 3 },
    { name: "ตื่นเต้น",  value: 5, base: 5 },
    { name: "กังวล",    value: 1, base: 1 },
];

const STAGES = [
    { min: 0,  label: "เพิ่งรู้จักกัน", how: "สุภาพ เป็นมิตร ยังเกรงใจ ถามเพื่อทำความรู้จัก แซวเบามาก" },
    { min: 20, label: "เพื่อน",        how: "เป็นกันเอง แซวได้ เริ่มเล่าเรื่องตัวเอง" },
    { min: 50, label: "เพื่อนสนิท",     how: "สบาย ๆ แซวแรงขึ้น มีมุกภายใน งอนได้ เปิดใจเรื่องส่วนตัว" },
    { min: 80, label: "สนิทมาก",       how: "เหมือนคนในครอบครัว รู้ใจ พูดตรง ห่วงใยลึกซึ้ง" },
];

/* ------------------------------------ helpers */

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const round1 = (n) => Math.round(n * 10) / 10;

/** Parses a stored local time; returns null for "-" or anything unreadable */
const parseTime = (s) => {
    const t = new Date(String(s ?? "").trim()).getTime();
    return Number.isFinite(t) ? t : null;
};

/**
 * Turns a gap in ms into Thai words like "3 ชั่วโมง".
 * @param {number | null} ms
 */
export const humanGap = (ms) => {
    if (ms == null) return "ไม่เคยคุยกันมาก่อน";
    const min = Math.round(ms / 60000);
    if (min < 2) return "เมื่อกี้";
    if (min < 60) return `${min} นาที`;
    const hr = Math.round(min / 60);
    if (hr < 24) return `${hr} ชั่วโมง`;
    return `${Math.round(hr / 24)} วัน`;
};

/** "3 ชั่วโมงก่อน", but just "เมื่อกี้" for very short gaps */
export const agoText = (ms) => {
    const gap = humanGap(ms);
    return ms == null || gap === "เมื่อกี้" ? gap : `${gap}ก่อน`;
};

export const timeOfDay =(date = new Date()) => {
    const h = date.getHours();
    if (h < 5) return "ดึกมาก";
    if (h < 11) return "เช้า";
    if (h < 13) return "เที่ยง";
    if (h < 17) return "บ่าย";
    if (h < 20) return "เย็น";
    return "กลางคืน";
};

export const stageOf = (closeness) => [ ...STAGES ].reverse().find((s) => closeness >= s.min) ?? STAGES[0];

/* ------------------------------------ read / write */

/**
 * Reads state.md. Unknown or broken lines fall back to defaults instead of throwing.
 * @returns {Promise<{ moods: {name: string, value: number, base: number}[], closeness: number, messages: number, lastSeen: number | null, moodUpdated: number | null }>}
 */
export async function loadState() {
    const text = await safeRead(FILES.state);
    const moods = [];
    const rel = {};

    for (const line of text.split("\n")) {
        const mood = line.match(/^- (.+?):\s*(-?\d+(?:\.\d+)?)\s*\(ปกติ\s*(-?\d+(?:\.\d+)?)\)/);
        if (mood) {
            moods.push({ name: mood[1].trim(), value: clamp(Number(mood[2]), 0, 10), base: clamp(Number(mood[3]), 0, 10) });
            continue;
        }
        const kv = line.match(/^- (.+?):\s*(.+)$/);
        if (kv) rel[kv[1].trim()] = kv[2].trim();
    }

    return {
        moods: moods.length ? moods : DEFAULT_MOODS.map((m) => ({ ...m })),
        closeness: clamp(Number(rel["ความสนิท"] ?? 5) || 0, 0, 100),
        messages: Number(rel["จำนวนข้อความ"] ?? 0) || 0,
        lastSeen: parseTime(rel["คุยครั้งล่าสุด"]),
        moodUpdated: parseTime(rel["อัปเดตอารมณ์ล่าสุด"]),
    };
}

const fmtTime = (t) => (t == null ? "-" : new Date(t).toLocaleString("sv-SE").replace(" ", "T"));

export async function saveState(state) {
    const moodLines = state.moods.map((m) => `- ${m.name}: ${round1(m.value)} (ปกติ ${round1(m.base)})`);
    const text = [
        "# สถานะตอนนี้",
        "",
        "> ระบบอัปเดตไฟล์นี้เอง แก้ตัวเลขได้ตลอด ตัวเลขในวงเล็บคือค่าปกติที่อารมณ์จะค่อย ๆ กลับไปหา",
        "> เพิ่มอารมณ์ใหม่ได้ด้วยรูปแบบเดียวกัน เช่น \"- หึง: 0 (ปกติ 0)\"",
        "",
        "## อารมณ์ (0–10)",
        ...moodLines,
        "",
        "## ความสัมพันธ์",
        `- ความสนิท: ${round1(state.closeness)}`,
        `- จำนวนข้อความ: ${state.messages}`,
        `- คุยครั้งล่าสุด: ${fmtTime(state.lastSeen)}`,
        `- อัปเดตอารมณ์ล่าสุด: ${fmtTime(state.moodUpdated)}`,
        "",
    ].join("\n");
    await writeAtomic(FILES.state, text);
}

/** Load, change and save state.md as one step, so two updates can't overwrite each other */
const changeState = (fn) => withFileLock(FILES.state, async () => {
    const state = await loadState();
    const result = await fn(state);
    await saveState(state);
    return result;
});

/**
 * Moves moods back toward normal for the hours since they were last updated,
 * and grows loneliness for long absences. Changes `state` in place.
 */
function decay(state, now) {
    const hours = state.moodUpdated == null ? 0 : Math.max(0, (now - state.moodUpdated) / 3600000);
    if (hours > 0) {
        for (const m of state.moods) {
            const step = Math.min(Math.abs(m.value - m.base), hours * DECAY_PER_HOUR);
            m.value += m.value > m.base ? -step : step;
        }
        // Loneliness follows how long the user has been gone, not how long since the last mood change
        const away = state.lastSeen == null ? 0 : (now - state.lastSeen) / 3600000;
        const lonely = state.moods.find((m) => m.name === "เหงา");
        if (lonely && away > LONELY_AFTER_HOURS) {
            lonely.value = Math.max(lonely.value, Math.min(LONELY_CAP, lonely.base + Math.floor(away / LONELY_PER_HOURS)));
        }
    }
    state.moodUpdated = now;
}

/* ------------------------------------ changes */

/**
 * Lets moods drift back to normal over time, and grows loneliness while the user is away.
 * @returns {Promise<Awaited<ReturnType<typeof loadState>>>}
 */
export function passTime(now = Date.now()) {
    return changeState((state) => {
        decay(state, now);
        return state;
    });
}

/** ms since the user last spoke, without recording anything; null if never */
export async function gapSinceUser(now = Date.now()) {
    const state = await loadState();
    return state.lastSeen == null ? null : now - state.lastSeen;
}

/**
 * Records that the user just spoke: updates last-seen and nudges closeness up.
 * Called after a reply succeeds, so a failed reply that gets retried isn't counted twice.
 * @param {number} [now]
 * @param {number} [count] how many messages the user sent in this turn
 * @returns {Promise<number | null>} ms since the previous message, null if first ever
 */
export function markUserMessage(now = Date.now(), count = 1) {
    return changeState((state) => {
        const gap = state.lastSeen == null ? null : now - state.lastSeen;
        const n = Math.max(1, Number(count) || 1);
        state.lastSeen = now;
        state.messages += n;
        state.closeness = clamp(state.closeness + CLOSENESS_PER_MESSAGE * Math.min(n, MAX_MESSAGES_COUNTED), 0, 100);
        return gap;
    });
}

/**
 * Applies mood changes decided by the model. Steps are capped so one line can't flip the persona.
 * @param {Record<string, number>} changes e.g. { "ดีใจ": 2, "งอน": -1, "ความสนิท": 1 }
 * @returns {Promise<string>} short confirmation
 */
export function adjustMood(changes = {}) {
    return changeState((state) => applyMood(state, changes));
}

/** Names the model may invent for a feeling; anything else would end up as junk lines in state.md */
const MAX_MOODS = 12;

function applyMood(state, changes) {
    // Time passes first; otherwise this update would wipe out the hours that should have calmed her down
    decay(state, Date.now());
    const done = [];

    for (const [ name, raw ] of Object.entries(changes ?? {})) {
        const delta = Number(raw);
        if (!Number.isFinite(delta) || delta === 0) continue;

        if (name === "ความสนิท") {
            const step = clamp(delta, -MAX_CLOSENESS_STEP, MAX_CLOSENESS_STEP);
            state.closeness = clamp(state.closeness + step, 0, 100);
            done.push(`${name} ${step > 0 ? "+" : ""}${step}`);
            continue;
        }

        let mood = state.moods.find((m) => m.name === name);
        const cleanName = String(name).replace(/[\r\n:()]/g, " ").trim().slice(0, 20);
        if (!mood && (!cleanName || state.moods.length >= MAX_MOODS)) continue;
        if (!mood) {
            // The model may name a feeling we don't track yet; add it with a neutral baseline
            mood = { name: cleanName, value: 0, base: 0 };
            state.moods.push(mood);
        }
        const step = clamp(delta, -MAX_MOOD_STEP, MAX_MOOD_STEP);
        mood.value = clamp(mood.value + step, 0, 10);
        done.push(`${name} ${step > 0 ? "+" : ""}${step}`);
    }

    return done.length ? `อารมณ์: ${done.join(", ")}` : "อารมณ์ไม่เปลี่ยน";
}

/** One-line mood summary for the prompt and the /สถานะ command */
export const describeMood = (state) =>
    state.moods
        .slice()
        .sort((a, b) => b.value - a.value)
        .map((m) => `${m.name} ${round1(m.value)}/10`)
        .join(", ");
