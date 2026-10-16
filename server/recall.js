import { splitSections, sectionTitle } from "./store.js";

/* ------------------------------------ config */

// Below these sizes everything is sent as-is; above them only what matters right now
const MEMORY_BUDGET = Number(process.env.MEMORY_BUDGET ?? 3500) || 3500;
const TEACHINGS_BUDGET = Number(process.env.TEACHINGS_BUDGET ?? 2500) || 2500;

// Facts about who you are are always worth knowing, whatever the topic
const CORE_TOPICS = /เกี่ยวกับผู้ใช้|ชื่อเรียก|สิ่งที่ผู้ใช้ขอให้จำ/;
const CORE_SHARE = 0.45;

/* ------------------------------------ matching */

/**
 * Thai has no spaces between words, so relevance is measured with 3-letter chunks:
 * "ชาบู" and "ชวนกินชาบู" share "ชาบ" and "าบู" without needing a word splitter.
 */
const gramsOf = (text) => {
    const clean = String(text ?? "").toLowerCase().replace(/[\s\p{P}\p{S}\d]+/gu, "");
    const chars = Array.from(clean);
    const out = new Set();
    for (let i = 0; i + 3 <= chars.length; i++) out.add(chars.slice(i, i + 3).join(""));
    return out;
};

const overlap = (a, b) => {
    let n = 0;
    for (const g of a) if (b.has(g)) n++;
    return n;
};

/* ------------------------------------ memory */

/**
 * Picks the memory lines that matter for the current conversation, keeping file order and topics.
 * @param {string} memory full memory.md
 * @param {string} query recent conversation text
 * @returns {{ text: string, kept: number, total: number }}
 */
export function selectMemory(memory, query) {
    const text = String(memory ?? "");
    const doc = splitSections(text);
    const items = [];
    doc.sections.forEach((section, s) => {
        const topic = sectionTitle(section);
        section.split("\n").slice(1).forEach((line, i) => {
            if (line.startsWith("- ")) items.push({ topic, line, s, i, order: items.length, isCore: CORE_TOPICS.test(topic) });
        });
    });

    if (text.length <= MEMORY_BUDGET) return { text, kept: items.length, total: items.length };

    const q = gramsOf(query);
    const chosen = new Set();
    let used = 0;
    const take = (item, limit) => {
        if (chosen.has(item) || used + item.line.length + 1 > limit) return;
        chosen.add(item);
        used += item.line.length + 1;
    };

    // Newest core facts first, then whatever relates to what you're talking about, then the newest of the rest
    [ ...items ].filter((x) => x.isCore).reverse().forEach((x) => take(x, MEMORY_BUDGET * CORE_SHARE));
    items
        .map((x) => ({ x, score: overlap(gramsOf(`${x.topic} ${x.line}`), q) }))
        .filter((r) => r.score > 0)
        .sort((a, b) => b.score - a.score || b.x.order - a.x.order)
        .forEach((r) => take(r.x, MEMORY_BUDGET));
    [ ...items ].reverse().forEach((x) => take(x, MEMORY_BUDGET));

    const byTopic = new Map();
    for (const x of items.filter((it) => chosen.has(it))) {
        if (!byTopic.has(x.topic)) byTopic.set(x.topic, []);
        byTopic.get(x.topic).push(x.line);
    }
    const body = [ ...byTopic ].map(([ topic, lines ]) => `## ${topic}\n${lines.join("\n")}`).join("\n\n");
    const skipped = items.length - chosen.size;
    return {
        text: `${body}\n\n(ยังมีความจำอีก ${skipped} เรื่องที่ไม่เกี่ยวกับตอนนี้ ถ้าผู้ใช้ถามถึงเรื่องที่ไม่อยู่ในนี้ ให้บอกตามจริงว่าจำไม่ค่อยได้)`,
        kept: chosen.size,
        total: items.length,
    };
}

/* ------------------------------------ teachings */

/**
 * Picks the lessons whose trigger is closest to what's being said, plus the newest ones.
 * @returns {{ text: string, kept: number, total: number }}
 */
export function selectTeachings(teachings, query) {
    const text = String(teachings ?? "");
    const doc = splitSections(text);
    const total = doc.sections.length;
    if (text.length <= TEACHINGS_BUDGET) return { text, kept: total, total };

    const q = gramsOf(query);
    const ranked = doc.sections
        .map((section, order) => ({ section, order, score: overlap(gramsOf(sectionTitle(section)), q) * 3 + overlap(gramsOf(section), q) }))
        .sort((a, b) => b.score - a.score || b.order - a.order);

    const chosen = [];
    let used = 0;
    for (const r of ranked) {
        if (used + r.section.length > TEACHINGS_BUDGET) continue;
        chosen.push(r);
        used += r.section.length;
    }
    const body = chosen.sort((a, b) => a.order - b.order).map((r) => r.section.trimEnd()).join("\n\n");
    return { text: body, kept: chosen.length, total };
}

export { MEMORY_BUDGET, TEACHINGS_BUDGET };
