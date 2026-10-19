import { splitSections, sectionTitle } from "./store.js";
import { gramsOf, overlap } from "./textmatch.js";

/* ------------------------------------ config */

// Below these sizes everything is sent as-is; above them only what matters right now
// Defaults only; the live values come from the settings page (server/config.js) through the budget argument
const MEMORY_BUDGET = 3500;
const TEACHINGS_BUDGET = 2500;

// Facts about who you are are always worth knowing, whatever the topic
const CORE_TOPICS = /เกี่ยวกับผู้ใช้|ชื่อเรียก|สิ่งที่ผู้ใช้ขอให้จำ/;
const CORE_SHARE = 0.45;

/* ------------------------------------ memory */

// Never fade: who you are, what she calls you, what you asked her to remember, your inside jokes
const KEEP_TOPICS = /เกี่ยวกับผู้ใช้|ชื่อเรียก|สิ่งที่ผู้ใช้ขอให้จำ|มุกภายใน|คำแนะนำจากผู้ใช้|ดูด้วยกัน/;
const dayOf = (line) => line.match(/^- \[(\d{4}-\d{2}-\d{2})\]/)?.[1] ?? "";

/**
 * Picks the memory lines that matter for the current conversation, keeping file order and topics.
 * @param {string} memory full memory.md
 * @param {string} query recent conversation text
 * @param {number} [budget] characters
 * @param {{ fadeDays?: number, now?: number }} [options] fadeDays: small facts older than this
 *   are only recalled when the conversation touches them, the way people forget details (0 = never)
 * @returns {{ text: string, kept: number, total: number }}
 */
export function selectMemory(memory, query, budget = MEMORY_BUDGET, { fadeDays = 0, now = Date.now() } = {}) {
    const text = String(memory ?? "");
    const doc = splitSections(text);
    const items = [];
    doc.sections.forEach((section, s) => {
        const topic = sectionTitle(section);
        section.split("\n").slice(1).forEach((line, i) => {
            if (line.startsWith("- ")) items.push({ topic, line, s, i, order: items.length, isCore: CORE_TOPICS.test(topic) });
        });
    });

    const q = gramsOf(query);
    // Old everyday details fade unless something in the chat brings them back
    const cutoff = fadeDays > 0 ? new Date(now - fadeDays * 86400000).toLocaleDateString("sv-SE") : "";
    const isFaded = (x) => cutoff && !KEEP_TOPICS.test(x.topic) && dayOf(x.line) && dayOf(x.line) < cutoff
        && overlap(gramsOf(`${x.topic} ${x.line}`), q) === 0;
    const faded = items.filter(isFaded);
    if (text.length <= budget && !faded.length) return { text, kept: items.length, total: items.length };
    if (text.length <= budget) {
        const keep = new Set(items.filter((x) => !isFaded(x)));
        return rebuild(items, keep, faded.length);
    }

    const chosen = new Set();
    let used = 0;
    const take = (item, limit) => {
        if (chosen.has(item) || isFaded(item) || used + item.line.length + 1 > limit) return;
        chosen.add(item);
        used += item.line.length + 1;
    };

    // Newest core facts first, then whatever relates to what you're talking about, then the newest of the rest
    [ ...items ].filter((x) => x.isCore).reverse().forEach((x) => take(x, budget * CORE_SHARE));
    items
        .map((x) => ({ x, score: overlap(gramsOf(`${x.topic} ${x.line}`), q) }))
        .filter((r) => r.score > 0)
        .sort((a, b) => b.score - a.score || b.x.order - a.x.order)
        .forEach((r) => take(r.x, budget));
    [ ...items ].reverse().forEach((x) => take(x, budget));

    return rebuild(items, chosen, items.length - chosen.size);
}

/** The chosen memory lines back in file order under their topics, with a note about the rest */
function rebuild(items, chosen, skipped) {
    const byTopic = new Map();
    for (const x of items.filter((it) => chosen.has(it))) {
        if (!byTopic.has(x.topic)) byTopic.set(x.topic, []);
        byTopic.get(x.topic).push(x.line);
    }
    const body = [ ...byTopic ].map(([ topic, lines ]) => `## ${topic}\n${lines.join("\n")}`).join("\n\n");
    return {
        text: `${body}\n\n(ยังมีความจำอีก ${skipped} เรื่องที่ไม่เกี่ยวกับตอนนี้หรือนานจนเลือนแล้ว ถ้าผู้ใช้ถามถึงเรื่องที่ไม่อยู่ในนี้ ให้ตอบแบบคนที่จำได้ลาง ๆ หรือบอกตามจริงว่าจำไม่ค่อยได้ ห้ามแต่งรายละเอียด)`,
        kept: chosen.size,
        total: items.length,
    };
}

/* ------------------------------------ teachings */

/**
 * Picks the lessons whose trigger is closest to what's being said, plus the newest ones.
 * @returns {{ text: string, kept: number, total: number }}
 */
export function selectTeachings(teachings, query, budget = TEACHINGS_BUDGET) {
    const text = String(teachings ?? "");
    const doc = splitSections(text);
    const total = doc.sections.length;
    if (text.length <= budget) return { text, kept: total, total };

    const q = gramsOf(query);
    const ranked = doc.sections
        .map((section, order) => ({ section, order, score: overlap(gramsOf(sectionTitle(section)), q) * 3 + overlap(gramsOf(section), q) }))
        .sort((a, b) => b.score - a.score || b.order - a.order);

    const chosen = [];
    let used = 0;
    for (const r of ranked) {
        if (used + r.section.length > budget) continue;
        chosen.push(r);
        used += r.section.length;
    }
    const body = chosen.sort((a, b) => a.order - b.order).map((r) => r.section.trimEnd()).join("\n\n");
    return { text: body, kept: chosen.length, total };
}

export { MEMORY_BUDGET, TEACHINGS_BUDGET };

/* ------------------------------------ bringing up the past */

/**
 * One older thing she might bring up by herself ("จำได้ป่ะ ที่พี่เคยบอกว่า…"): a dated fact from
 * a few days to a few months ago. Names and nicknames aren't news, so they're left out.
 * @returns {string} "หัวข้อ: fact (date)" or ""
 */
export function pickCallback(memory, { now = Date.now(), rand = Math.random } = {}) {
    const doc = splitSections(String(memory ?? ""));
    const from = new Date(now - 180 * 86400000).toLocaleDateString("sv-SE");
    const to = new Date(now - 4 * 86400000).toLocaleDateString("sv-SE");
    const items = [];
    for (const section of doc.sections) {
        const topic = sectionTitle(section);
        if (/ชื่อเรียก/.test(topic)) continue;
        for (const line of section.split("\n").slice(1)) {
            const day = dayOf(line);
            if (day && day >= from && day <= to) items.push({ topic, line, day, weight: /มุกภายใน/.test(topic) ? 2 : 1 });
        }
    }
    if (!items.length) return "";
    const pool = items.flatMap((x) => Array(x.weight).fill(x));
    const pick = pool[Math.floor(rand() * pool.length)];
    return `${pick.topic}: ${pick.line.replace(/^- \[\d{4}-\d{2}-\d{2}\]\s*/, "")} (${pick.day})`;
}
