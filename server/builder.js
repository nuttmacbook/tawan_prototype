import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { PERSONAS_DIR, createProfile } from "./profiles.js";
import { withFileLock, writeAtomic } from "./fsutil.js";
import { parseActivities } from "./pacing.js";
import { redact } from "./store.js";

/* ------------------------------------ a new character from a form */

// "+ ตัวละครใหม่" used to make an empty character you then edited file by file. Now you fill in
// who she is (name, age, personality, how she talks, how you know each other, what she already
// knows about you) and the files are written for you, in the exact formats the rest of the app reads.
// Optionally the brain fills in the details (habits, daily life, opinions, example chats).

const TEMPLATE_DIR = fileURLToPath(new URL("./templates/", import.meta.url));
const MIN_AGE = 18;

const RELATIONS = {
    // chat: how this chat started, when the form doesn't say. Without it her first message has no
    // reason to exist, and she opened with "อ้าว พี่" as if you'd just written to her
    stranger: { label: "เพิ่งรู้จักกัน", closeness: 5, chat: "เพิ่งได้ช่องทางแชทกัน ยังไม่เคยคุยในแชทนี้มาก่อน" },
    friend:   { label: "เพื่อน", closeness: 30, chat: "เพิ่งแลกช่องทางแชทกัน นี่เป็นครั้งแรกที่คุยกันในแชท" },
    close:    { label: "เพื่อนสนิท", closeness: 60, chat: "คุยแชทกันเป็นประจำอยู่แล้ว" },
    family:   { label: "สนิทมากเหมือนคนในครอบครัว", closeness: 85, chat: "คุยแชทกันเป็นประจำอยู่แล้ว" },
};

// Words the system reads with a colon ("เวลาตื่น: 8") lose the colon inside free text, so "ทำกะดึก
// เวลาตื่น: 15" in a job description can't move her wake-up time
const SYSTEM_LABELS = /(ชื่อ|อายุ|เวลาตื่น|เวลานอน|ความเร็วพิมพ์|เมือง)\s*[:：]/g;
const defuse = (s) => String(s ?? "").replace(SYSTEM_LABELS, "$1 ");
const line = (v, max = 120) => defuse(String(v ?? "").replace(/[\r\n]+/g, " ").replace(/^#+\s*/, "").replace(/\|/g, "/").trim()).slice(0, max);
/** A multi-line field: no headings (a "## กิจกรรมระหว่างวัน" in the backstory would be read as hers) */
const paragraph = (v, max) =>
    String(v ?? "").replace(/\r/g, "").split("\n").map((l) => defuse(l.replace(/^\s*#+\s*/, "").replace(/\|/g, "/"))).join("\n").trim().slice(0, max);
const lines = (v, maxLines = 20, maxLen = 200) =>
    String(v ?? "").split(/\r?\n/).map((l) => line(l.replace(/^[-*•]\s*/, ""), maxLen)).filter(Boolean).slice(0, maxLines);
/** A whole number typed in a form field, or null when it isn't one */
const whole = (v) => {
    const s = String(v ?? "").trim();
    return /^\d{1,3}$/.test(s) ? Number(s) : null;
};
const int = (v, lo, hi, def) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) && String(v ?? "").trim() !== "" ? Math.min(hi, Math.max(lo, n)) : def;
};

/**
 * The form, checked: every field one clean line (or a list of lines), numbers in range.
 * @returns {object} spec
 * @throws when the name is missing or the age is under 18
 */
export function cleanSpec(raw = {}) {
    const name = line(raw.name, 40);
    if (!name) throw new Error("ต้องมีชื่อตัวละคร");
    // Characters in this app are adults, always. Anything that isn't a plain number ("16 ปี", "abc")
    // is refused rather than quietly turned into a default age
    const typed = String(raw.age ?? "").trim();
    const age = typed ? whole(typed) : 24;
    if (age == null || age < MIN_AGE || age > 99) throw new Error(`ตัวละครต้องอายุ ${MIN_AGE} ปีขึ้นไป (ใส่เป็นตัวเลข)`);
    const relation = RELATIONS[raw.relation] ? raw.relation : "stranger";
    return {
        name,
        age,
        gender: line(raw.gender, 30),
        job: line(raw.job, 120),
        livesIn: line(raw.livesIn, 120),
        city: line(raw.city, 40),
        likes: line(raw.likes, 300),
        dislikes: line(raw.dislikes, 300),
        personality: lines(raw.personality, 15, 200),
        backstory: paragraph(raw.backstory, 3000),
        selfRef: line(raw.selfRef, 30),
        callUser: line(raw.callUser, 30),
        particles: line(raw.particles, 120),
        // Same clean-up as pasted chat samples: no links, emails or phone numbers
        samples: lines(raw.samples, 30, 120).map((s) => redact(s).trim()).filter(Boolean),
        relation,
        howMet: line(raw.howMet, 200),
        firstChat: line(raw.firstChat, 200) || RELATIONS[relation].chat,
        closeness: int(raw.closeness, 0, 100, RELATIONS[relation].closeness),
        memories: lines(raw.memories, 30, 200),
        people: lines(raw.people, 15, 160),
        wake: int(raw.wake, 0, 23, 8),
        sleep: int(raw.sleep, 0, 23, 23),
        typing: int(raw.typing, 2, 14, 6),
        useAI: raw.useAI === true || raw.useAI === "on" || raw.useAI === "true",
    };
}

const DEFAULT_ACTIVITIES = [
    "- อาบน้ำอยู่ | 7-23 | 5% | 8-20 | ไม่เห็นมือถือ",
    "- กินข้าวอยู่ | 11-13,18-20 | 20% | 5-15 | อ่านแต่ยังไม่ตอบ",
    "- ทำงานอยู่ | 9-17 | 15% | 3-15 | อ่านแต่ยังไม่ตอบ",
];

/** persona.md in the template's layout: the lines the system reads keep their exact wording */
export function renderPersona(spec, extra = {}) {
    const field = (label, value) => `- ${label}: ${value ?? ""}`.trimEnd();
    const activities = extra.activities?.length ? extra.activities : DEFAULT_ACTIVITIES;
    const personality = [ ...spec.personality, ...(extra.personality ?? []) ];
    const section = (title, body) => (body ? `\n## ${title}\n${body}\n` : "");
    return [
        "# บุคลิกหลัก",
        "",
        "> ไฟล์นี้คือ \"ตัวตน\" ของตัวละคร แก้ได้ตลอด มีผลทันทีในข้อความถัดไป",
        "> บรรทัด \"ชื่อ\", \"เวลาตื่น\", \"เวลานอน\", \"ความเร็วพิมพ์\" และหัวข้อ \"กิจกรรมระหว่างวัน\" ระบบอ่านไปใช้ อย่าเปลี่ยนรูปแบบ",
        "",
        "## ตัวตน",
        field("ชื่อ", spec.name),
        field("อายุ", spec.age),
        spec.gender && field("เพศ", spec.gender),
        field("อาชีพ", spec.job),
        field("อยู่ที่", spec.livesIn),
        spec.city && field("เมือง", spec.city),
        field("ชอบ", spec.likes),
        field("ไม่ชอบ", spec.dislikes),
        section("เรื่องราวของเธอ", [ spec.backstory, extra.backstory ].filter(Boolean).join("\n\n")),
        section("ความสัมพันธ์กับผู้ใช้", [
            `- ตอนนี้เป็น: ${RELATIONS[spec.relation].label}`,
            spec.howMet && `- รู้จักกันจาก: ${spec.howMet}`,
            `- แชทนี้: ${spec.firstChat}`,
        ].filter(Boolean).join("\n")),
        "",
        "## จังหวะการตอบ",
        "> ระบบใช้ตัวเลขสามบรรทัดนี้กำหนดว่าตอบช้าหรือเร็ว (ร่วมกับอารมณ์และความสนิท)",
        field("เวลาตื่น", spec.wake),
        field("เวลานอน", spec.sleep),
        field("ความเร็วพิมพ์", `${spec.typing} (ตัวอักษรต่อวินาที)`),
        "",
        "## กิจกรรมระหว่างวัน",
        "> สิ่งที่ทำระหว่างวันซึ่งทำให้ตอบช้า รูปแบบ: ชื่อ | ช่วงเวลา | โอกาส | นานกี่นาที | ไม่เห็นมือถือ หรือ อ่านแต่ยังไม่ตอบ",
        "> ช่วงเวลาหลายช่วงคั่นด้วยจุลภาค เช่น 11-13,18-20 · โอกาสคือเปอร์เซ็นต์ที่จะเกิดเมื่อได้ข้อความในช่วงนั้น",
        ...activities,
        "",
        "## นิสัย",
        ...(personality.length ? personality.map((p) => `- ${p}`) : [ "- " ]),
        section("ชีวิตประจำวัน", extra.daily ?? ""),
        "",
        "## วิธีพูด",
        field("แทนตัวเองว่า", spec.selfRef || spec.name),
        field("เรียกผู้ใช้ว่า", spec.callUser),
        field("คำลงท้ายที่ใช้บ่อย", spec.particles),
        "",
        "## ขอบเขต",
        "- ถ้าไม่รู้ให้บอกตรง ๆ ไม่แต่งเรื่อง",
        "- ถ้าผู้ใช้ถามจริงจังว่าเป็น AI ไหม ให้ยอมรับอย่างเป็นธรรมชาติ",
        "",
    ].filter((l) => l !== false && l !== undefined && l !== null).join("\n").replace(/\n{3,}/g, "\n\n");
}

const today = () => new Date().toLocaleDateString("sv-SE");

/** memory.md: what she already knows about you, under the topic that never fades */
export const renderMemory = (spec, template) =>
    spec.memories.length
        ? `${template.trimEnd()}\n\n## เกี่ยวกับผู้ใช้\n${spec.memories.map((m) => `- [${today()}] ${m}`).join("\n")}\n`
        : template;

/** people.md: "มิ้นท์ - เพื่อนสนิทสมัยมหาลัย" becomes a person with a name that stays the same */
export function renderPeople(spec, template) {
    const people = spec.people
        .map((p) => p.split(/\s+[-–:]\s+|\s*[-–:]\s+/))
        .map(([ who, ...rest ]) => ({ who: line(who, 40), what: line(rest.join(" - "), 120) }))
        .filter((p) => p.who)
        // One section per name: notePerson only ever updates the first "## มิ้นท์"
        .reduce((all, p) => {
            const same = all.find((x) => x.who === p.who);
            if (same) same.what = [ same.what, p.what ].filter(Boolean).join(", ");
            else all.push(p);
            return all;
        }, []);
    if (!people.length) return template;
    return `${template.trimEnd()}\n\n${people.map((p) => `## ${p.who}${p.what ? `\n- เป็น: ${p.what}` : ""}`).join("\n\n")}\n`;
}

/** style.md: the template's examples speak in the new name, plus the lines you gave as her voice */
export function renderStyle(spec, template, extra = {}) {
    // Function replacers: a "$&" or "$'" typed in the form must stay text, not a replacement pattern
    let text = template.replaceAll("มะลิ", () => spec.name);
    if (spec.samples.length) {
        const samples = `${spec.samples.map((s) => `- ${s}`).join("\n")}\n`;
        text = text.replace(/## ตัวอย่างจากแชทจริง\n(?:>.*\n)*/, (head) => head + samples);
    }
    if (extra.examples?.length) {
        const block = extra.examples.map((e) => [ `### ${e.situation}`, e.bad && `❌ ${e.bad}`, ...e.good.map((g) => `✅ ${g}`) ].filter(Boolean).join("\n")).join("\n\n");
        text = text.replace("## ตัวอย่างจากแชทจริง", (head) => `${block}\n\n${head}`);
    }
    return text;
}

export const renderState = (spec, template) => template.replace(/- ความสนิท: \d+(\.\d+)?/, `- ความสนิท: ${spec.closeness}`);

/** opinions.md from the details the brain filled in */
export const renderOpinions = (template, opinions = []) =>
    opinions.length ? `${template.trimEnd()}\n\n${opinions.map((o) => `## ${o.about}\n- [${today()}] ${o.opinion}`).join("\n\n")}\n` : template;

/* ------------------------------------ the brain fills in details (optional) */

const FILL_SYSTEM = `คุณช่วยออกแบบตัวละครสมมติสำหรับแอปแชทแบบเพื่อน จากข้อมูลที่ผู้สร้างกรอก
เติมรายละเอียดให้มีชีวิต สอดคล้องกับข้อมูลทุกข้อ ห้ามขัดกับที่กรอกไว้

กติกา:
- ตัวละครเป็นผู้ใหญ่ (อายุตามที่กรอก ไม่ต่ำกว่า ${MIN_AGE}) เป็นคนสมมติ ไม่อิงคนจริงหรือดารา
- ไม่มีเนื้อหาทางเพศ ไม่หึงหวงหรือกีดกันความสัมพันธ์จริงของผู้ใช้
- ตัวอย่างแชทเป็นภาษาแชทไทยจริง สั้น ไม่สุภาพเกินไป ตามวิธีพูดที่กรอก
- กิจกรรมระหว่างวันต้องตรงรูปแบบ: "ชื่อ | ช่วงเวลา | โอกาส | นานกี่นาที | ไม่เห็นมือถือ หรือ อ่านแต่ยังไม่ตอบ" เช่น "ทำคอนเทนต์อยู่ | 13-17 | 15% | 5-20 | อ่านแต่ยังไม่ตอบ" และอยู่ในช่วงเวลาตื่น

ตอบเป็น JSON object เดียว ไม่มีข้อความอื่น:
{
  "personality": ["นิสัยเพิ่มเติม 4-8 ข้อ"],
  "backstory": "เรื่องราวเบื้องหลัง 1-2 ย่อหน้า (ถ้าผู้สร้างเขียนมาแล้ว ให้เสริม ไม่ซ้ำ)",
  "daily": "ชีวิตประจำวันสั้น ๆ 3-5 บรรทัด",
  "activities": ["กิจกรรมระหว่างวัน 3-6 บรรทัดตามรูปแบบ"],
  "opinions": [{ "about": "เรื่อง", "opinion": "ความเห็นของเธอ" }],
  "examples": [{ "situation": "สถานการณ์", "bad": "ตัวอย่างที่พิมพ์แบบ AI", "good": ["แบบที่เธอพิมพ์จริง", "bubble ถัดไป"] }]
}`;

const parseJson = (text) => {
    const s = String(text ?? "");
    const start = s.indexOf("{");
    const end = s.lastIndexOf("}");
    try {
        return start >= 0 && end > start ? JSON.parse(s.slice(start, end + 1)) : null;
    } catch {
        return null;
    }
};

const list = (v, max) => (Array.isArray(v) ? v.slice(0, max) : []);

/** What the brain filled in, checked: short lines, activities that the pacing parser accepts */
export function cleanExtra(raw) {
    if (!raw || typeof raw !== "object") return {};
    const activities = list(raw.activities, 6)
        .map((a) => `- ${String(a ?? "").replace(/^[-*]\s*/, "").replace(/[\r\n]+/g, " ").trim().slice(0, 120)}`)
        // Kept only if pacing.js reads it the same way it reads a hand-written line
        .filter((a) => parseActivities(`## กิจกรรมระหว่างวัน\n${a}\n`).length === 1);
    return {
        personality: list(raw.personality, 8).map((p) => line(p, 200)).filter(Boolean),
        backstory: paragraph(raw.backstory, 2000),
        daily: list(String(raw.daily ?? "").split("\n"), 6).map((l) => line(l.replace(/^[-*]\s*/, ""), 200)).filter(Boolean).map((l) => `- ${l}`).join("\n"),
        activities,
        opinions: list(raw.opinions, 6).map((o) => ({ about: line(o?.about, 40), opinion: line(o?.opinion, 160) })).filter((o) => o.about && o.opinion),
        examples: list(raw.examples, 6)
            .map((e) => ({ situation: line(e?.situation, 60), bad: line(e?.bad, 160), good: list(e?.good, 4).map((g) => line(g, 100)).filter(Boolean) }))
            .filter((e) => e.situation && e.good.length),
    };
}

async function fillIn(spec, ask) {
    const facts = { ...spec };
    delete facts.useAI;
    const text = await ask(FILL_SYSTEM, `<ข้อมูลที่ผู้สร้างกรอก>\n${JSON.stringify(facts, null, 1)}\n</ข้อมูลที่ผู้สร้างกรอก>\n\nตอบเป็น JSON ตามรูปแบบ`);
    return cleanExtra(parseJson(text));
}

/* ------------------------------------ build */

const template = (name) => readFile(path.join(TEMPLATE_DIR, `${name}.md`), "utf8").catch(() => "");

/** Every file the form decides, as name → text (also used for the preview) */
export async function renderAll(spec, extra = {}) {
    const [ style, memory, people, state, opinions ] = await Promise.all([ "style", "memory", "people", "state", "opinions" ].map(template));
    return {
        persona: renderPersona(spec, extra),
        style: renderStyle(spec, style, extra),
        memory: renderMemory(spec, memory),
        people: renderPeople(spec, people),
        state: renderState(spec, state),
        opinions: renderOpinions(opinions, extra.opinions),
    };
}

/**
 * Creates the character from the form. `ask` is the brain's plain completion, used only when
 * "ให้ AI ช่วยเติมรายละเอียด" is ticked; if it fails, the character is still made from the form.
 * @returns {Promise<{ id: string, name: string, filled: boolean }>}
 */
export async function buildCharacter(raw, ask) {
    const spec = cleanSpec(raw);
    let extra = {};
    if (spec.useAI && ask) extra = await fillIn(spec, ask).catch((err) => (console.error("  ⚠ เติมรายละเอียดตัวละครไม่สำเร็จ:", err?.message ?? err), {}));
    const files = await renderAll(spec, extra);
    const id = await createProfile({ name: spec.name });
    const dir = path.join(PERSONAS_DIR, id);
    for (const [ name, text ] of Object.entries(files)) {
        const file = path.join(dir, `${name}.md`);
        await withFileLock(file, () => writeAtomic(file, text));
    }
    const filled = Object.values(extra).some((v) => (Array.isArray(v) ? v.length : Boolean(v)));
    return { id, name: spec.name, filled };
}
