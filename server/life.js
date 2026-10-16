import { writeFile } from "node:fs/promises";
import { FILES, safeRead, today, appendToSection, lastSections, splitSections, sectionTitle, remember } from "./store.js";

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
    const text = String(about ?? "").trim();
    if (!text) return "ไม่มีเรื่องให้จด";
    const date = isDate(askOn) ? askOn : today();
    if ((await loadThreads()).some((t) => t.about === text)) return `มีเรื่องค้างนี้อยู่แล้ว: ${text}`;

    const current = (await safeRead(FILES.threads)) || THREADS_HEAD;
    await writeFile(FILES.threads, `${current.trimEnd()}\n- [ ] ${today()} | ถามได้: ${date} | ${text}\n`);
    return `จดเรื่องค้าง: ${text} (ถามได้ ${date})`;
}

/**
 * Closes the first open thread matching the keyword and remembers how it turned out.
 * @param {string} keyword
 * @param {string} [outcome]
 */
export async function closeThread(keyword, outcome = "") {
    const word = String(keyword ?? "").trim();
    if (!word) return "ต้องบอกว่าปิดเรื่องไหน";

    const lines = (await safeRead(FILES.threads)).split("\n");
    const index = lines.findIndex((l) => THREAD_LINE.test(l) && l.includes(word));
    if (index < 0) return `ไม่พบเรื่องค้างที่มีคำว่า "${word}"`;

    const about = lines[index].match(THREAD_LINE)?.[3]?.trim() ?? word;
    lines.splice(index, 1);
    await writeFile(FILES.threads, lines.join("\n"));

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
    const text = String(entry ?? "").trim();
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
