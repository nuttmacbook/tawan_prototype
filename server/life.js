import { readdir } from "node:fs/promises";
import path from "node:path";
import { updateText } from "./fsutil.js";
import { FILES, safeRead, today, appendToSection, lastSections, splitSections, joinSections, sectionTitle, remember, historyDir } from "./store.js";

/* ------------------------------------ threads (เรื่องค้าง) */

const THREADS_HEAD = [
    "# เรื่องค้าง",
    "",
    "> เรื่องที่ผู้ใช้เล่าไว้และควรถามต่อ agent เพิ่มและปิดเอง แก้ได้",
    "> รูปแบบ: - [ ] วันที่จด | ถามได้: วันที่ | เรื่อง",
    "",
].join("\n");

const THREAD_LINE = /^- \[ \] (\d{4}-\d{2}-\d{2}) \| ถามได้: (\d{4}-\d{2}-\d{2}) \| (.+)$/;

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s ?? ""));

/**
 * Open follow-ups. `isDue` means it's time to ask about it.
 * @returns {Promise<{ noted: string, askOn: string, about: string, isDue: boolean }[]>}
 */
export async function loadThreads() {
    const now = today();
    return (await safeRead(FILES.threads))
        .split("\n")
        .map((l) => l.match(THREAD_LINE))
        .filter(Boolean)
        .map(([ , noted, askOn, about ]) => ({ noted, askOn, about: about.trim(), isDue: askOn <= now }));
}

/**
 * @param {string} about what to follow up on, e.g. "พี่จะสอบคณิต"
 * @param {string} [askOn] YYYY-MM-DD; defaults to today
 */
export async function addThread(about, askOn) {
    const text = String(about ?? "").replace(/[\r\n]+/g, " ").trim();
    if (!text) return "ไม่มีเรื่องให้จด";
    const date = isDate(askOn) ? askOn : today();
    let isDuplicate = false;
    await updateText(FILES.threads, (current) => {
        isDuplicate = current.split("\n").some((l) => l.match(THREAD_LINE)?.[3]?.trim() === text);
        if (isDuplicate) return null;
        return `${(current || THREADS_HEAD).trimEnd()}\n- [ ] ${today()} | ถามได้: ${date} | ${text}\n`;
    });
    return isDuplicate ? `มีเรื่องค้างนี้อยู่แล้ว: ${text}` : `จดเรื่องค้าง: ${text} (ถามได้ ${date})`;
}

/**
 * Closes the first open thread matching the keyword and remembers how it turned out.
 * @param {string} keyword
 * @param {string} [outcome]
 */
export async function closeThread(keyword, outcome = "") {
    const word = String(keyword ?? "").trim();
    if (!word) return "ต้องบอกว่าปิดเรื่องไหน";

    let about = "";
    await updateText(FILES.threads, (current) => {
        const lines = current.split("\n");
        // Prefer the thread whose text matches exactly; otherwise the first one containing the keyword
        const open = lines.map((l, i) => ({ i, about: l.match(THREAD_LINE)?.[3]?.trim() })).filter((x) => x.about);
        const hit = open.find((x) => x.about === word) ?? open.find((x) => x.about.includes(word));
        if (!hit) return null;
        about = hit.about;
        lines.splice(hit.i, 1);
        return lines.join("\n");
    });
    if (!about) return `ไม่พบเรื่องค้างที่มีคำว่า "${word}"`;

    const result = String(outcome ?? "").trim();
    if (result) await remember("เหตุการณ์ในชีวิตผู้ใช้", `${about} → ${result}`);
    return `ปิดเรื่องค้าง: ${about}${result ? ` (${result})` : ""}`;
}

/* ------------------------------------ diary (ชีวิตของตัวละคร) */

const DIARY_HEAD = [
    "# ไดอารี่",
    "",
    "> ชีวิตของตัวละครเอง agent จดเองเพื่อเล่าได้ไม่ขัดกัน แก้หรือเขียนเพิ่มได้",
    "",
].join("\n");

export async function writeDiary(entry) {
    const text = String(entry ?? "").replace(/[\r\n]+/g, " ").trim();
    if (!text) return "ไม่มีอะไรให้จด";
    await appendToSection(FILES.diary, today(), `- ${text}`, { fallbackHead: DIARY_HEAD });
    return `จดไดอารี่: ${text}`;
}

/**
 * Last few days of the diary plus whether today already has an entry.
 * @returns {Promise<{ recent: string, hasToday: boolean }>}
 */
export async function loadDiary(days = 5) {
    const text = await safeRead(FILES.diary);
    const hasToday = splitSections(text).sections.some((s) => sectionTitle(s) === today());
    return { recent: lastSections(text, days), hasToday };
}

export const readThreadsFile = () => safeRead(FILES.threads);
export const readDiaryFile = () => safeRead(FILES.diary);

/* ------------------------------------ people in her life (คนรอบตัว) */

const PEOPLE_HEAD = [
    "# คนรอบตัว",
    "",
    "> คนในชีวิตของตัวละคร ระบบเพิ่มและอัปเดตเองเมื่อเธอเล่าถึงใคร แก้เองได้ · ชื่อของแต่ละคนต้องคงเดิมทุกครั้งที่เล่า",
    "",
].join("\n");
const MAX_NOTES_PER_PERSON = 6;
const oneLine = (v, max = 160) => String(v ?? "").replace(/[\r\n]+/g, " ").replace(/^#+\s*/, "").trim().slice(0, max);

/**
 * Adds someone she talks about, or updates them, so the same friend keeps the same name and story.
 * @param {{ name: string, relation?: string, trait?: string, update?: string }} person
 *   relation: "เพื่อนสนิท", "แม่" · trait: what they're like · update: what happened with them now
 */
export async function notePerson({ name, relation = "", trait = "", update = "" } = {}) {
    const who = oneLine(name, 40);
    if (!who) return "ต้องบอกชื่อ";
    const [ rel, kind, news ] = [ oneLine(relation, 60), oneLine(trait), oneLine(update) ];
    let isNew = false;
    await updateText(FILES.people, (text) => {
        const doc = splitSections(text || PEOPLE_HEAD);
        let index = doc.sections.findIndex((s) => sectionTitle(s) === who);
        isNew = index < 0;
        if (isNew) {
            doc.sections.push(`## ${who}`);
            index = doc.sections.length - 1;
        }
        const [ heading, ...lines ] = doc.sections[index].split("\n").filter((l) => l.trim());
        const keep = (prefix, value) => {
            const at = lines.findIndex((l) => l.startsWith(prefix));
            if (!value) return;
            if (at >= 0) lines[at] = `${prefix}${value}`;
            else lines.unshift(`${prefix}${value}`);
        };
        keep("- นิสัย: ", kind);
        keep("- เป็น: ", rel);
        const notes = lines.filter((l) => /^- \[\d{4}-\d{2}-\d{2}\]/.test(l));
        const facts = lines.filter((l) => !/^- \[\d{4}-\d{2}-\d{2}\]/.test(l));
        if (news) notes.push(`- [${today()}] ${news}`);
        doc.sections[index] = [ heading, ...facts, ...notes.slice(-MAX_NOTES_PER_PERSON) ].join("\n");
        return joinSections(doc);
    });
    return `${isNew ? "รู้จักคนใหม่" : "อัปเดตคนรอบตัว"}: ${who}`;
}

const PEOPLE_BUDGET = 2500;

/**
 * The people worth having in mind for this conversation: everyone while the file is short,
 * otherwise those just mentioned plus the ones with the newest news.
 */
export async function peopleFor(query) {
    const text = await safeRead(FILES.people);
    const doc = splitSections(text);
    if (!doc.sections.length) return "";
    const all = doc.sections.map((s) => s.trimEnd()).join("\n\n");
    if (all.length <= PEOPLE_BUDGET) return all;
    const q = String(query ?? "");
    const latest = (s) => (s.match(/\[(\d{4}-\d{2}-\d{2})\]/g) ?? []).sort().at(-1) ?? "";
    const ranked = doc.sections
        .map((s) => ({ s: s.trimEnd(), isMentioned: q.includes(sectionTitle(s)), at: latest(s) }))
        .sort((a, b) => Number(b.isMentioned) - Number(a.isMentioned) || b.at.localeCompare(a.at));
    const chosen = [];
    let used = 0;
    for (const r of ranked) {
        if (used + r.s.length > PEOPLE_BUDGET) continue;
        chosen.push(r.s);
        used += r.s.length;
    }
    return `${chosen.join("\n\n")}\n\n(ยังมีคนอื่นอีก ${doc.sections.length - chosen.length} คน ถ้าพูดถึงคนที่ไม่อยู่ในนี้ ใช้ชื่อเดิมที่เคยเล่า ไม่ต้องตั้งชื่อใหม่)`;
}

/* ------------------------------------ special days (dates.md) */

const DATES_HEAD = [
    "# วันสำคัญ",
    "",
    "> วันที่ตัวละครควรจำ ระบบเพิ่มเองเมื่อคุณเล่า (เช่น วันเกิด) แก้หรือเพิ่มเองได้",
    "> รูปแบบ: \"- 03-14 | วันเกิดผู้ใช้\" (เดือน-วัน = ทุกปี) หรือ \"- 2026-11-02 | สัมภาษณ์งานของผู้ใช้\" (ครั้งเดียว)",
    "",
].join("\n");
const DATE_LINE = /^- (\d{4}-)?(\d{2})-(\d{2}) \| (.+)$/;

/** "3/14", "14-03", "2026-03-14" → "03-14" or "2026-03-14"; anything unclear → "" */
export function cleanDate(raw) {
    const s = String(raw ?? "").trim();
    let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (m) return valid(m[2], m[3]) ? `${m[1]}-${pad(m[2])}-${pad(m[3])}` : "";
    m = s.match(/^(\d{1,2})-(\d{1,2})$/);
    if (m) return valid(m[1], m[2]) ? `${pad(m[1])}-${pad(m[2])}` : "";
    return "";
}
const pad = (n) => String(n).padStart(2, "0");
const valid = (mm, dd) => Number(mm) >= 1 && Number(mm) <= 12 && Number(dd) >= 1 && Number(dd) <= 31;

/**
 * Remembers a date worth greeting on. A yearly one (birthday) as "MM-DD", a one-off as "YYYY-MM-DD".
 * The same thing told again replaces its old date.
 */
export async function noteDate({ what, date } = {}) {
    const about = oneLine(what, 80).replace(/\|/g, "/");
    let when = cleanDate(date);
    // "2533-03-14" is a Buddhist-era year; a birthday told with the birth year, or any past year,
    // is a yearly day, not one that happened once
    const year = Number(when.slice(0, 4));
    if (when.length === 10 && year > 2400) when = `${year - 543}${when.slice(4)}`;
    if (when.length === 10 && (Number(when.slice(0, 4)) < new Date().getFullYear() || /วันเกิด|เกิด|ครบรอบ/.test(about))) when = when.slice(5);
    if (!about || !when) return "ต้องมีเรื่องและวันที่ (เดือน-วัน หรือ ปี-เดือน-วัน)";
    await updateText(FILES.dates, (text) => {
        const lines = String(text || DATES_HEAD).split("\n").filter((l) => !(DATE_LINE.test(l) && l.split("|")[1]?.trim() === about));
        return `${lines.join("\n").trimEnd()}\n- ${when} | ${about}\n`;
    });
    return `จำวันสำคัญ: ${when} ${about}`;
}

const dayStart = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

/**
 * Dates from dates.md coming up in the next few days, plus how long you've been talking.
 * @param {string} text dates.md
 * @param {{ now?: Date, firstChat?: string, days?: number }} [options] firstChat: YYYY-MM-DD of the first day you talked
 * @returns {string[]} lines like "วันนี้: วันเกิดผู้ใช้"
 */
export function upcomingDays(text, { now = new Date(), firstChat = "", days = 3 } = {}) {
    const base = dayStart(now);
    const label = (n) => (n === 0 ? "วันนี้" : n === 1 ? "พรุ่งนี้" : `อีก ${n} วัน`);
    const out = [];
    for (const l of String(text ?? "").split("\n")) {
        const m = l.trim().match(DATE_LINE);
        if (!m) continue;
        const [ , year, mm, dd, about ] = m;
        for (let n = 0; n <= days; n++) {
            // By calendar day, not 24-hour steps, which slip on daylight-saving days
            const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + n);
            const sameDay = d.getMonth() + 1 === Number(mm) && d.getDate() === Number(dd);
            if (sameDay && (!year || d.getFullYear() === Number(year.slice(0, 4)))) out.push(`${label(n)}: ${about.trim()}`);
        }
    }
    // Milestones only on the day itself; a yearly one on the same date as the first chat
    if (/^\d{4}-\d{2}-\d{2}$/.test(firstChat)) {
        const first = new Date(`${firstChat}T00:00:00`);
        const since = Math.round((base - dayStart(first)) / 86400000);
        const years = base.getFullYear() - first.getFullYear();
        if ([ 30, 100, 200, 500, 1000 ].includes(since)) out.push(`วันนี้: คุยกันมาครบ ${since} วัน (เริ่มคุยวันที่ ${firstChat})`);
        else if (years > 0 && base.getMonth() === first.getMonth() && base.getDate() === first.getDate()) out.push(`วันนี้: คุยกันมาครบ ${years} ปี`);
    }
    return out;
}

/** The first day in the chat logs (today's folder or the archive) */
export async function firstChatDay() {
    const dates = [];
    for (const dir of [ historyDir(), path.join(historyDir(), "archive") ]) {
        for (const f of await readdir(dir).catch(() => [])) if (/^\d{4}-\d{2}-\d{2}\.md$/.test(f)) dates.push(f.slice(0, 10));
    }
    return dates.sort()[0] ?? "";
}

export const datesNote = async () => upcomingDays(await safeRead(FILES.dates), { firstChat: await firstChatDay() });

/* ------------------------------------ her opinions (opinions.md) */

const OPINIONS_HEAD = [
    "# ความเห็นของเธอ",
    "",
    "> สิ่งที่ตัวละครเคยบอกว่าชอบ ไม่ชอบ หรือคิดยังไง ระบบจดเองเพื่อไม่ให้พูดขัดกับตัวเอง แก้เองได้",
    "",
].join("\n");
const MAX_VIEWS = 3;
const OPINIONS_BUDGET = 1500;

/**
 * What she thinks about something, so she doesn't love durian on Monday and hate it on Tuesday.
 * Saying the same thing again changes nothing; a new view is added under the old one (she changed her mind).
 */
export async function noteOpinion({ about, opinion } = {}) {
    const topic = oneLine(about, 40);
    const view = oneLine(opinion);
    if (!topic || !view) return "ต้องบอกเรื่องและความเห็น";
    let outcome = "new";
    await updateText(FILES.opinions, (text) => {
        const doc = splitSections(text || OPINIONS_HEAD);
        const index = doc.sections.findIndex((s) => sectionTitle(s) === topic);
        if (index < 0) {
            doc.sections.push(`## ${topic}\n- [${today()}] ${view}`);
            return joinSections(doc);
        }
        const [ heading, ...lines ] = doc.sections[index].split("\n").filter((l) => l.trim());
        const latest = lines.at(-1)?.replace(/^- \[\d{4}-\d{2}-\d{2}\]\s*/, "") ?? "";
        if (latest === view) {
            outcome = "same";
            return null;
        }
        outcome = "changed";
        doc.sections[index] = [ heading, ...[ ...lines, `- [${today()}] ${view}` ].slice(-MAX_VIEWS) ].join("\n");
        return joinSections(doc);
    });
    return outcome === "same" ? `ความเห็นเดิม: ${topic}` : outcome === "changed" ? `เปลี่ยนความเห็น: ${topic}` : `จดความเห็น: ${topic}`;
}

/** Her views that matter now: ones the chat mentions first, then the newest */
export async function opinionsFor(query) {
    const doc = splitSections(await safeRead(FILES.opinions));
    if (!doc.sections.length) return "";
    const q = String(query ?? "");
    const latest = (s) => (s.match(/\[(\d{4}-\d{2}-\d{2})\]/g) ?? []).sort().at(-1) ?? "";
    const ranked = doc.sections
        .map((s) => ({ s: s.trimEnd(), hit: q.includes(sectionTitle(s)), at: latest(s) }))
        .sort((a, b) => Number(b.hit) - Number(a.hit) || b.at.localeCompare(a.at));
    const chosen = [];
    let used = 0;
    for (const r of ranked) {
        if (used + r.s.length > OPINIONS_BUDGET) continue;
        chosen.push(r.s);
        used += r.s.length;
    }
    return chosen.join("\n\n");
}
