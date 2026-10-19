import { readFile } from "node:fs/promises";
import path from "node:path";
import { activeDir } from "./profiles.js";
import { withFileLock, writeAtomic } from "./fsutil.js";

/* ------------------------------------ looking out for you */

// A friend notices when you're up at 3am again, or have been on the phone all day.
// Only counts are kept (how many messages, how many after midnight), never what was said.

const KEEP_DAYS = 14;
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
        entry(dayOf(at)).messages += count;
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
