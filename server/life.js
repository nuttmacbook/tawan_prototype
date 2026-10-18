import { updateText } from "./fsutil.js";
import { FILES, safeRead, today, appendToSection, lastSections, splitSections, joinSections, sectionTitle, remember } from "./store.js";

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
