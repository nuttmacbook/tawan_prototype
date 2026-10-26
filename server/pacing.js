import { loadState } from "./mood.js";
import { loadTexts } from "./store.js";
import { currentId, currentKey } from "./profiles.js";
import { todayActivities, dayKind } from "./world.js";

/* ------------------------------------ config */

// Every timing rule lives here so it can be tuned (also from editlogic mode)
// The activity name for a message she read and simply forgot to answer (brain.js words her apology)
export const FORGOT = "อ่านแล้วลืมตอบ";
const SERIOUS = /เศร้า|ร้องไห้|ไม่ไหว|อยากตาย|ไม่อยากอยู่|ทำร้ายตัวเอง|เครียดมาก|ป่วย|โรงพยาบาล|ด่วน|ช่วยด้วย/;

const PACING = {
    forgetChance: 0.04,       // now and then she reads, means to answer, and forgets for a while
    forgetMinutes: [ 20, 60 ],
    readCps: 18,              // how fast she reads the user's messages (characters per second)
    typingCps: 6,             // default typing speed, overridden by "ความเร็วพิมพ์" in persona.md
    inChatWindowMs: 120000,   // replied or read within this window = still holding the phone
    readInChatMs: [ 800, 3500 ],
    readAwayMs: [ 8000, 40000 ],
    readAsleepMs: [ 45000, 120000 ],
    thinkMs: [ 500, 2200 ],
    pauseBetweenMs: [ 350, 1400 ],
    jitter: 0.25,             // ±25% randomness so it never feels mechanical
    maxReadMs: 150000,
    wakeHour: 10,             // defaults when persona.md has no "เวลาตื่น"/"เวลานอน"
    sleepHour: 2,
    busyInChatScale: 0.35,    // mid-conversation she's less likely to wander off
    maxBusyMs: 25 * 60000,
};

/**
 * Things she might be doing when your message arrives, by hour of day.
 * phoneAway: true  → she doesn't see it until she's done ("ส่งแล้ว" stays)
 * phoneAway: false → she glances and reads it, but replies when she's free ("อ่านแล้ว" with no reply yet)
 */
const ACTIVITIES = [
    { name: "อาบน้ำอยู่",          hours: [ [ 10, 24 ] ],          chance: 0.05, minutes: [ 8, 20 ],  phoneAway: true },
    { name: "กินข้าวอยู่",          hours: [ [ 11, 13 ], [ 18, 20 ] ], chance: 0.22, minutes: [ 5, 15 ],  phoneAway: false },
    { name: "ทำงานลูกค้าอยู่",      hours: [ [ 12, 18 ] ],          chance: 0.18, minutes: [ 3, 15 ],  phoneAway: false },
    { name: "โฟกัสทำเกมอยู่",       hours: [ [ 20, 24 ], [ 0, 1 ] ], chance: 0.2,  minutes: [ 5, 25 ],  phoneAway: false },
    { name: "ไปตลาดนัดหน้าซอย",     hours: [ [ 17, 19 ] ],          chance: 0.12, minutes: [ 10, 25 ], phoneAway: true },
    { name: "เล่นกับขนมปังอยู่",     hours: [ [ 10, 24 ], [ 0, 2 ] ], chance: 0.05, minutes: [ 2, 5 ],   phoneAway: true },
];

/**
 * Reads "## กิจกรรมระหว่างวัน" from persona.md:
 * "- อาบน้ำอยู่ | 10-24 | 5% | 8-20 | ไม่เห็นมือถือ"
 * Falls back to ACTIVITIES when the section is missing, so older persona files keep working.
 */
export function parseActivities(persona) {
    const section = String(persona ?? "").split(/^## /m).find((s) => s.startsWith("กิจกรรมระหว่างวัน"));
    if (!section) return ACTIVITIES;

    const rows = section.split("\n")
        .filter((l) => l.startsWith("- ") && l.includes("|"))
        .map((l) => {
            const [ name, hours, chance, minutes, phone = "" ] = l.slice(2).split("|").map((x) => x.trim());
            // "22-2" crosses midnight: it becomes 22-24 plus 0-2
            const ranges = String(hours ?? "").split(",")
                .map((r) => r.split("-").map((x) => Number(x.trim())))
                .filter(([ a, b ]) => Number.isFinite(a) && Number.isFinite(b) && a >= 0 && b <= 24 && a !== b)
                .flatMap(([ a, b ]) => (b > a ? [ [ a, b ] ] : [ [ a, 24 ], [ 0, b ] ]))
                .filter(([ a, b ]) => b > a);
            const [ lo, hi = lo ] = String(minutes ?? "").split("-").map(Number);
            const pct = Number(String(chance ?? "").replace("%", ""));
            if (!name || !ranges.length || !Number.isFinite(lo) || !Number.isFinite(pct)) return null;
            return {
                name,
                hours: ranges,
                chance: Math.min(1, Math.max(0, pct / 100)),
                minutes: [ lo, Math.max(lo, hi) ],
                phoneAway: /ไม่เห็น/.test(phone),
            };
        })
        .filter(Boolean);
    return rows;
}

/** What each character is doing right now; lives for this server run so later messages wait for the same activity */
const doing = new Map();

const inHours = (hour, ranges) => ranges.some(([ from, to ]) => hour >= from && hour < to);

/**
 * Keeps the ongoing activity, or maybe starts a new one.
 * @returns {{ name: string, until: number, phoneAway: boolean } | null}
 */
function activityAt(now, { hour, isInChat, isAsleep, lonely, activities }) {
    const id = currentId();
    const current = doing.get(id);
    if (current && now < current.until) return current;
    doing.delete(id);
    if (isAsleep) return null;

    // Lonely means she keeps the phone close; chatting means she's less likely to wander off
    const scale = (isInChat ? PACING.busyInChatScale : 1) * (lonely >= 6 ? 0.5 : 1);
    for (const a of activities.filter((x) => inHours(hour, x.hours))) {
        if (Math.random() < a.chance * scale) {
            const ms = Math.min(PACING.maxBusyMs, between(a.minutes) * 60000);
            const next = { name: a.name, until: now + ms, phoneAway: a.phoneAway };
            doing.set(id, next);
            return next;
        }
    }
    return null;
}

const rolled = new Map();
/** True the first time this exact batch of messages is planned (per character, for 6 hours) */
function firstRoll(texts) {
    // Per chat: two people sending the same words each get their own roll
    const key = `${currentKey()}\u0000${texts.join("\u0000")}`;
    const now = Date.now();
    for (const [ k, at ] of rolled) if (now - at > 6 * 3600000) rolled.delete(k);
    if (rolled.has(key)) return false;
    rolled.set(key, now);
    return true;
}

/** Today's plan from the morning look-up comes first, then her usual habits from persona.md */
const planned = async (persona) => [ ...(await todayActivities().catch(() => [])), ...parseActivities(persona) ];

/* ------------------------------------ helpers */

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const between = ([ lo, hi ]) => lo + Math.random() * (hi - lo);
const jitter = (n) => n * (1 + (Math.random() * 2 - 1) * PACING.jitter);
const moodOf = (state, name) => Number(state?.moods?.find((m) => m.name === name)?.value ?? 0);

/** Reads "- เวลาตื่น: 10", "- เวลานอน: 2", "- ความเร็วพิมพ์: 6" from persona.md */
export const personaHabits = (persona) => {
    const num = (label) => {
        const v = Number(String(persona ?? "").match(new RegExp(`${label}\\s*[:：]\\s*(\\d+(?:\\.\\d+)?)`))?.[1]);
        return Number.isFinite(v) ? v : null;
    };
    return {
        wakeHour: num("เวลาตื่น") ?? PACING.wakeHour,
        sleepHour: num("เวลานอน") ?? PACING.sleepHour,
        typingCps: num("ความเร็วพิมพ์") ?? PACING.typingCps,
    };
};

/**
 * True between bedtime and wake-up, handling bedtimes after midnight and before it.
 * The same hour for both means no sleep at all, not "asleep all day".
 */
export const isAsleepAt = (hour, { sleepHour, wakeHour }) => {
    if (sleepHour === wakeHour) return false;
    return sleepHour < wakeHour ? hour >= sleepHour && hour < wakeHour : hour >= sleepHour || hour < wakeHour;
};

/* ------------------------------------ plan */

/**
 * Decides how long she takes to see, think about and type a reply, like a real person would.
 * @param {{ texts?: string[], lastAgentAt?: number, lastReadAt?: number, now?: number }} input
 * @returns {Promise<{ readMs: number, laterMs: number, activity: string, thinkMs: number, typingCps: number, pauseMs: [number, number], isInChat: boolean, isAsleep: boolean, reasons: string[] }>}
 */
export async function planReply({ texts = [], lastAgentAt = 0, lastReadAt = 0, now = Date.now() } = {}) {
    const [ state, { persona } ] = await Promise.all([ loadState(), loadTexts() ]);
    const habits = personaHabits(persona);
    const reasons = [];
    const hour = new Date(now).getHours();
    const chars = texts.join("").length;

    const isInChat = now - Math.max(lastAgentAt, lastReadAt) < PACING.inChatWindowMs;
    const isAsleep = !isInChat && isAsleepAt(hour, habits);
    const isJustWoke = !isAsleep && hour >= habits.wakeHour && hour < habits.wakeHour + 1;

    // Where her phone is decides the base wait before "อ่านแล้ว"
    let readMs;
    if (isInChat) {
        readMs = between(PACING.readInChatMs);
        reasons.push("ยังอยู่ในแชท");
    } else if (isAsleep) {
        readMs = between(PACING.readAsleepMs);
        reasons.push(`ช่วงนอน (${habits.sleepHour}:00–${habits.wakeHour}:00)`);
    } else {
        readMs = between(PACING.readAwayMs);
        reasons.push("วางมือถืออยู่");
    }

    let typingCps = habits.typingCps;
    let thinkMs = between(PACING.thinkMs);

    const happy = Math.max(moodOf(state, "ดีใจ"), moodOf(state, "ตื่นเต้น"));
    const lonely = moodOf(state, "เหงา");
    const sulky = moodOf(state, "งอน");
    const tired = moodOf(state, "เหนื่อย");

    if (lonely >= 6) {
        readMs *= 0.5;
        reasons.push(`เหงา ${lonely} → รีบอ่าน`);
    }
    if (sulky >= 4) {
        readMs *= 1 + sulky * 0.3;
        thinkMs *= 1.5;
        reasons.push(`งอน ${sulky} → ทิ้งไว้ก่อน`);
    }
    if (happy >= 7) {
        typingCps *= 1.25;
        reasons.push(`อารมณ์ดี ${happy} → พิมพ์ไว`);
    }
    if (tired >= 6 || isJustWoke) {
        typingCps *= 0.75;
        readMs *= 1.3;
        reasons.push(isJustWoke ? "เพิ่งตื่น" : `เหนื่อย ${tired}`);
    }

    // A busy, away or sick day (picked by the morning look-up) slows her down all day
    const kind = await dayKind().catch(() => "normal");
    if (kind === "moody") {
        readMs *= 1.3;
        reasons.push("วันนี้อารมณ์ไม่ค่อยดี");
    } else if (kind === "busy" || kind === "away") {
        readMs *= 2.5;
        reasons.push(kind === "away" ? "วันนี้ไม่อยู่บ้าน" : "วันนี้ยุ่งทั้งวัน");
    } else if (kind === "sick") {
        readMs *= 1.5;
        typingCps *= 0.8;
        reasons.push("วันนี้ไม่สบาย");
    }

    // Close friends get answered sooner
    const closeness = Number(state?.closeness ?? 0);
    readMs *= 1.3 - (clamp(closeness, 0, 100) / 100) * 0.6;
    readMs += (chars / PACING.readCps) * 1000;
    readMs = clamp(jitter(readMs), 500, PACING.maxReadMs);

    // Greeting and nudge plans (no texts) are her own choice to talk, so no activity applies
    let busy = texts.length ? activityAt(now, { hour, isInChat, isAsleep, lonely, activities: await planned(persona) }) : null;
    // Forgetting ends the moment you're talking again or need her
    if (busy?.name === FORGOT && (isInChat || SERIOUS.test(texts.join(" ")))) {
        doing.delete(currentId());
        busy = null;
    }
    // Not while you're talking back and forth, and never when you sound like you need her.
    // One roll per batch: the closed-chat scheduler asks every minute, and rolling each time
    // would make a message that waits an hour almost sure to be "forgotten"
    if (!busy && texts.length && !isInChat && !isAsleep && !SERIOUS.test(texts.join(" ")) && firstRoll(texts) && Math.random() < PACING.forgetChance) {
        busy = { name: FORGOT, until: now + between(PACING.forgetMinutes) * 60000, phoneAway: false };
        doing.set(currentId(), busy);
    }
    let laterMs = 0;
    if (busy?.phoneAway) {
        readMs = Math.max(readMs, busy.until - now + between([ 1000, 6000 ]));
        reasons.push(`${busy.name} → ยังไม่อ่าน`);
    } else if (busy) {
        laterMs = Math.max(0, busy.until - now - readMs);
        reasons.push(`${busy.name} → อ่านแล้วตอบทีหลัง`);
    }

    return {
        readMs: Math.round(readMs),
        laterMs: Math.round(laterMs),
        activity: busy?.name ?? "",
        // Phone down (shower, market): the page shows her as offline until she's back
        phoneAway: Boolean(busy?.phoneAway),
        thinkMs: Math.round(clamp(jitter(thinkMs), 300, 8000)),
        typingCps: Math.round(clamp(jitter(typingCps), 2.5, 14) * 10) / 10,
        pauseMs: PACING.pauseBetweenMs,
        isInChat,
        isAsleep,
        reasons,
    };
}

/** Debug: ends whatever she's doing so the next message is handled normally */
export const clearActivity = () => {
    doing.delete(currentId());
};

export { PACING, ACTIVITIES };
