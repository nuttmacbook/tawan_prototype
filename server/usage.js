import { readFile } from "node:fs/promises";
import path from "node:path";
import { activeDir } from "./profiles.js";
import { withFileLock, writeAtomic } from "./fsutil.js";

/* ------------------------------------ looking out for you */

// A friend notices when you're up at 3am again, or have been on the phone all day.
// Only counts are kept (how many messages, how many after midnight), never what was said.

const KEEP_DAYS = 42;          // six weeks: enough to tell what a usual Monday looks like
const LATE_UNTIL = 5;          // messages from midnight to 5am count as a late night
const LATE_NIGHT_MSGS = 3;     // a few messages make it a late night, one doesn't
const HEAVY_DAY_MSGS = 200;

const usageFile = () => path.join(activeDir(), "usage.json");
const dayOf = (t) => new Date(t).toLocaleDateString("sv-SE");

export async function loadUsage() {
    try {
        const value = JSON.parse(await readFile(usageFile(), "utf8"));
        return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    } catch {
        return {};
    }
}

/** Counts messages you sent; a late night belongs to the day it started (2am Sunday is Saturday night) */
export function recordUse(count = 1, at = Date.now()) {
    const file = usageFile();
    return withFileLock(file, async () => {
        const usage = await loadUsage();
        const entry = (d) => (usage[d] = { messages: 0, late: 0, ...usage[d] });
        const day = entry(dayOf(at));
        const time = new Date(at);
        day.messages += count;
        // Which hours you write in, and when you first wrote that day: how she learns your routine
        day.hours = Array.from({ length: 24 }, (_, h) => Number(day.hours?.[h] ?? 0));
        day.hours[time.getHours()] += count;
        // Chatting past midnight isn't "first message of the day at 00:30"
        if (time.getHours() >= LATE_UNTIL) {
            const minute = time.getHours() * 60 + time.getMinutes();
            day.first = Math.min(Number(day.first ?? minute), minute);
        }
        if (new Date(at).getHours() < LATE_UNTIL) entry(dayOf(at - 86400000)).late += count;
        const keep = Object.keys(usage).sort().slice(-KEEP_DAYS);
        await writeAtomic(file, `${JSON.stringify(Object.fromEntries(keep.map((d) => [ d, usage[d] ])), null, 1)}\n`);
    });
}

/**
 * What she might gently say about how you're doing, or "".
 * @param {Record<string, { messages: number, late: number }>} usage
 * @param {Date} [now]
 */
export function careNote(usage, now = new Date()) {
    const u = usage ?? {};
    const hour = now.getHours();
    const tonight = dayOf(hour < LATE_UNTIL ? now.getTime() - 86400000 : now.getTime());
    const nights = Array.from({ length: 5 }, (_, i) => dayOf(new Date(`${tonight}T12:00:00`).getTime() - (i + 1) * 86400000));
    const lateNights = nights.filter((d) => Number(u[d]?.late ?? 0) >= LATE_NIGHT_MSGS).length;

    if (hour < LATE_UNTIL && lateNights >= 3) {
        return `ผู้ใช้นอนดึกแบบนี้มา ${lateNights} คืนจาก 5 คืนแล้ว ห่วงจริงจังขึ้นนิดนึง ชวนไปนอนแบบเพื่อนที่เป็นห่วง (ครั้งเดียวพอ ไม่บ่น ไม่ไล่)`;
    }
    const todayMsgs = Number(u[dayOf(now.getTime())]?.messages ?? 0);
    if (todayMsgs >= HEAVY_DAY_MSGS) {
        return `วันนี้ผู้ใช้คุยกับคุณเยอะมาก (${todayMsgs} ข้อความ) ถ้าจังหวะเหมาะ ชวนไปพัก ไปกินข้าว หรือไปเจอเพื่อนจริงบ้างแบบเพื่อน ไม่ทำให้รู้สึกผิด ไม่ไล่ (ครั้งเดียวพอ)`;
    }
    return "";
}

/* ------------------------------------ your routine, as she notices it */

const WEEKDAYS = [ "อาทิตย์", "จันทร์", "อังคาร", "พุธ", "พฤหัส", "ศุกร์", "เสาร์" ];
const weekdayOf = (date) => new Date(`${date}T12:00:00`).getDay();
const isWeekend = (date) => [ 0, 6 ].includes(weekdayOf(date));
const median = (list) => {
    const sorted = [ ...list ].sort((x, y) => x - y);
    return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
};
const clockOf = (minute) => {
    const r = (Math.round(minute / 15) * 15) % 1440;
    return `${String(Math.floor(r / 60)).padStart(2, "0")}:${String(r % 60).padStart(2, "0")}`;
};

/** The three hours you write most in, over a set of days */
function busiestWindow(days) {
    const total = Array.from({ length: 24 }, (_, h) => days.reduce((n, d) => n + Number(d.hours?.[h] ?? 0), 0));
    let best = 0;
    let bestSum = -1;
    for (let h = 0; h < 24; h++) {
        const sum = total[h] + total[(h + 1) % 24] + total[(h + 2) % 24];
        // Starts on an hour you actually write in, so "20–23" rather than an empty 19:00
        if (total[h] > 0 && sum > bestSum) [ best, bestSum ] = [ h, sum ];
    }
    return bestSum > 0 ? `${best}–${(best + 3) % 24} น.` : "";
}

/**
 * What a friend picks up from when you text: your usual first message on weekdays and weekends,
 * the hours you're most around, and today against that ("วันนี้ตื่นเช้าจัง").
 * Needs about a week of days before it says anything.
 * @returns {string}
 */
export function routineNote(usage, now = new Date()) {
    const todayDate = dayOf(now.getTime());
    const past = Object.entries(usage ?? {}).filter(([ d, v ]) => d < todayDate && Array.isArray(v?.hours) && v.messages > 0);
    if (past.length < 5) return "";
    const lines = [];
    const groups = [ [ "วันธรรมดา", past.filter(([ d ]) => !isWeekend(d)) ], [ "วันหยุด", past.filter(([ d ]) => isWeekend(d)) ] ];
    const usual = {};
    for (const [ label, days ] of groups) {
        if (days.length < 3) continue;
        usual[label] = median(days.map(([ , v ]) => Number(v.first)).filter(Number.isFinite));
        const window = busiestWindow(days.map(([ , v ]) => v));
        lines.push(`- ${label}: มักทักครั้งแรกราว ${clockOf(usual[label])} น.${window ? ` คุยกันเยอะช่วง ${window}` : ""}`);
    }

    const todayUse = usage?.[todayDate];
    const usualToday = usual[isWeekend(todayDate) ? "วันหยุด" : "วันธรรมดา"];
    if (Number.isFinite(todayUse?.first) && Number.isFinite(usualToday) && Math.abs(todayUse.first - usualToday) >= 120) {
        lines.push(`- วันนี้ทักครั้งแรก ${clockOf(todayUse.first)} น. ${todayUse.first < usualToday ? "เร็วกว่าปกติ" : "ช้ากว่าปกติ"}`);
    }
    // A weekday you've gone quiet on before: days with no messages at all count too
    const first = Object.keys(usage ?? {}).sort()[0];
    const average = past.reduce((n, [ , v ]) => n + v.messages, 0) / past.length;
    const sameDays = [];
    for (let n = 7; first && dayOf(now.getTime() - n * 86400000) >= first; n += 7) sameDays.push(dayOf(now.getTime() - n * 86400000));
    const quiet = sameDays.filter((d) => Number(usage?.[d]?.messages ?? 0) < average * 0.3).length;
    if (sameDays.length >= 3 && quiet >= Math.ceil(sameDays.length * 0.6)) lines.push(`- วัน${WEEKDAYS[now.getDay()]}ผู้ใช้มักเงียบกว่าวันอื่น`);
    return lines.join("\n");
}
