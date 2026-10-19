import { mkdir, readFile, writeFile, readdir, rename, copyFile } from "node:fs/promises";
import path from "node:path";
import { DATA_DIR, activeDir, fileOf, loadSettings, saveSettings } from "./profiles.js";
import { withFileLock, writeAtomic, updateText } from "./fsutil.js";
import { normalize, similarity } from "./textmatch.js";

// Paths follow whichever character is active, so switching characters needs no restart
const FILES = new Proxy({}, { get: (_, name) => fileOf(String(name)) });
const historyDir = () => path.join(activeDir(), "history");
const archiveDir = () => path.join(historyDir(), "archive");
const uploadsDir = () => path.join(activeDir(), "uploads");

/* ------------------------------------ helpers */

/** Local date/time so files roll over at the user's midnight, not UTC */
const today = () => new Date().toLocaleDateString("sv-SE");
const clock = () => new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

/** "2026-10-14T05:20:00" without a zone, which Date parses back as local time */
const nowIso = () => new Date().toLocaleString("sv-SE").replace(" ", "T");

/** Missing files read as empty so a deleted md never crashes the chat */
async function safeRead(file) {
    try {
        return await readFile(file, "utf8");
    } catch {
        return "";
    }
}


/**
 * Splits a markdown file into its "## " sections so one section can be
 * replaced or extended without touching the rest of the user's edits.
 */
const splitSections = (text) => {
    const parts = String(text ?? "").split(/^(?=## )/m);
    const head = parts[0]?.startsWith("## ") ? "" : parts.shift() ?? "";
    return { head, sections: parts };
};

const joinSections = ({ head, sections }) => {
    const body = sections.map((s) => s.trimEnd()).join("\n\n");
    return `${head.trimEnd()}\n\n${body}\n`;
};

const sectionTitle = (section) => section.split("\n")[0].replace(/^## /, "").trim();

/**
 * Appends a line under a "## title" heading, creating the heading when missing.
 * @returns {Promise<void>}
 */
async function appendToSection(file, title, line, { fallbackHead = "" } = {}) {
    await updateText(file, (text) => {
        const doc = splitSections(text || fallbackHead);
        const index = doc.sections.findIndex((s) => sectionTitle(s) === title);
        if (index >= 0) {
            doc.sections[index] = `${doc.sections[index].trimEnd()}\n${line}`;
        } else {
            doc.sections.push(`## ${title}\n${line}`);
        }
        return joinSections(doc);
    });
}

/** Keeps the head plus the last N sections, which is how diary/journal stay small in the prompt */
const lastSections = (text, count) => {
    const doc = splitSections(text);
    return joinSections({ head: "", sections: doc.sections.slice(-count) }).trim();
};

/* ------------------------------------ memory */

/**
 * Adds one fact under a topic heading in memory.md.
 * @param {string} topic e.g. "เกี่ยวกับผู้ใช้"
 * @param {string} fact
 * @returns {Promise<string>} short confirmation
 */
export async function remember(topic, fact) {
    // One line each: a newline would start a fake heading or bullet in memory.md
    const cleanTopic = String(topic ?? "").replace(/[\r\n]+/g, " ").replace(/^#+\s*/, "").trim() || "ทั่วไป";
    const cleanFact = String(fact ?? "").replace(/[\r\n]+/g, " ").trim();
    if (!cleanFact) return "ไม่มีข้อมูลให้จำ";

    let outcome = "new";
    await updateText(FILES.memory, (text) => {
        const lines = text.split("\n");
        const match = findSameFact(lines, cleanFact, cleanTopic);
        outcome = match.kind;
        if (match.kind === "known") return null;
        // The newer wording wins: it's either more detailed or the same fact said again with today's date
        const kept = lines.filter((_, i) => !match.indexes.includes(i));
        const doc = splitSections(kept.join("\n"));
        const line = `- [${today()}] ${cleanFact}`;
        const index = doc.sections.findIndex((x) => sectionTitle(x) === cleanTopic);
        if (index >= 0) doc.sections[index] = `${doc.sections[index].trimEnd()}\n${line}`;
        else doc.sections.push(`## ${cleanTopic}\n${line}`);
        // A topic left with no facts after the move goes away
        doc.sections = doc.sections.filter((x) => x.split("\n").slice(1).some((l) => l.trim()));
        return joinSections(doc);
    });
    if (outcome === "known") return `รู้อยู่แล้ว: ${cleanFact}`;
    return `${outcome === "replace" ? "อัปเดตความจำ" : "จำแล้ว"} (${cleanTopic}): ${cleanFact}`;
}

const isNegative = (text) => /ไม่|เลิก|ห้าม|ยังไม่/.test(String(text ?? ""));

// Close enough to be the same fact in other words; kept high so two different likes stay two lines
const SAME_FACT = 0.85;

// Containment only counts when the shorter text is most of the longer one:
// "ชอบแมว" inside "แฟนชอบแมว" is about someone else, not the same fact
const MIN_CONTAINED_SHARE = 0.6;

const digitsOf = (text) => (String(text ?? "").match(/\d+/g) ?? []).join(",");

/** Every number in the shorter text appears whole in the longer one ("วันที่ 1" is not part of "วันที่ 12") */
const numbersFit = (shorter, longer) => {
    const have = new Set(String(longer ?? "").match(/\d+/g) ?? []);
    return (String(shorter ?? "").match(/\d+/g) ?? []).every((n) => have.has(n));
};

/**
 * Looks for this fact among the remembered ones, so she doesn't write "ชอบชาบู" five times.
 * Only the same topic is compared, except a word-for-word repeat, which moves the fact to the new topic.
 * @returns {{ kind: "new" | "known" | "replace", indexes: number[] }}
 *   known: an existing line already says all of it · replace: these lines say less or the same, differently
 */
function findSameFact(lines, fact, topic) {
    const plain = normalize(fact);
    const indexes = [];
    let section = "";
    for (const [ i, line ] of lines.entries()) {
        if (line.startsWith("## ")) section = line.slice(3).trim();
        if (!line.startsWith("- ")) continue;
        const old = line.replace(/^- (\[\d{4}-\d{2}-\d{2}\]\s*)?/, "");
        const oldPlain = normalize(old);
        if (!oldPlain) continue;
        if (oldPlain === plain) {
            indexes.push(i);
            continue;
        }
        if (section !== topic) continue;
        const [ shorter, longer ] = oldPlain.length < plain.length ? [ oldPlain, plain ] : [ plain, oldPlain ];
        const [ shortText, longText ] = oldPlain.length < plain.length ? [ old, fact ] : [ fact, old ];
        // Same start = the same fact told in more detail ("ชอบกินชาบู" → "ชอบกินชาบูร้านใกล้บ้าน");
        // anywhere else it must be most of the text, so "ชอบแมว" in "แฟนชอบแมว" doesn't count
        const contains = numbersFit(shortText, longText)
            && (longer.startsWith(shorter) || (longer.includes(shorter) && Array.from(shorter).length / Array.from(longer).length >= MIN_CONTAINED_SHARE));
        // "มีแมว" sits inside "ไม่มีแมว", but it's the opposite: the newer one is what's true now
        if (contains && isNegative(old) !== isNegative(fact)) {
            indexes.push(i);
            continue;
        }
        if (contains && oldPlain.includes(plain)) return { kind: "known", indexes: [] };
        // Same wording but different numbers ("สอบวันที่ 5" / "สอบวันที่ 12") are different facts
        if (contains || (similarity(old, fact) >= SAME_FACT && digitsOf(old) === digitsOf(fact))) indexes.push(i);
    }
    return { kind: indexes.length ? "replace" : "new", indexes };
}

/**
 * Removes every memory line containing the keyword.
 * @param {string} keyword
 * @returns {Promise<number>} how many lines were removed
 */
export async function forget(keyword) {
    const word = String(keyword ?? "").trim();
    // A one-letter keyword would wipe half the file
    if (Array.from(word).length < 2) return 0;

    let removed = 0;
    await updateText(FILES.memory, (text) => {
        const lines = text.split("\n");
        // Only bullet lines are facts; headings and notes stay so the file keeps its shape
        const kept = lines.filter((l) => !(l.startsWith("- ") && l.includes(word)));
        removed = lines.length - kept.length;
        return removed > 0 ? kept.join("\n") : null;
    });
    return removed;
}

/**
 * Replaces memory.md with a compacted version, keeping a backup of the old one.
 * @param {string} text new full file content
 * @returns {Promise<string>} backup path
 */
export async function replaceMemory(text) {
    const backup = path.join(activeDir(), "memory.backup.md");
    await withFileLock(FILES.memory, async () => {
        await copyFile(FILES.memory, backup).catch(() => {});
        await writeAtomic(FILES.memory, `${String(text ?? "").trim()}\n`);
    });
    return backup;
}

/**
 * Writes the new memory only if the file still reads `expected`, as one locked step,
 * so a fact remembered while a long tidy-up was running is never overwritten.
 * @returns {Promise<boolean>} true when written
 */
export async function replaceMemoryIf(expected, text) {
    const backup = path.join(activeDir(), "memory.backup.md");
    return withFileLock(FILES.memory, async () => {
        if ((await safeRead(FILES.memory)) !== expected) return false;
        await copyFile(FILES.memory, backup).catch(() => {});
        await writeAtomic(FILES.memory, `${String(text ?? "").trim()}\n`);
        return true;
    });
}

/* ------------------------------------ teachings */

/**
 * Trigger text of a teachings section, without the wrapping quotes.
 * Hand-written headings like "ฝันดี" หรือ "ไปนอนแล้ว" keep their inner quotes.
 */
const triggerOf = (section) => {
    const raw = String(section ?? "").split("\n")[0].match(/^## เมื่อได้ยิน:\s*(.+)$/)?.[1]?.trim() ?? "";
    return /^"[^"]*"$/.test(raw) ? raw.slice(1, -1) : raw;
};

/**
 * Saves how the persona should react to a phrase. Teaching the same trigger again overwrites it.
 * @param {{ trigger: string, feeling?: string, response?: string, example?: string }} lesson
 * @returns {Promise<string>} short confirmation
 */
export async function teach({ trigger, feeling = "", response = "", example = "" } = {}) {
    const oneLine = (v) => String(v ?? "").replace(/[\r\n]+/g, " ").trim();
    [ trigger, feeling, response, example ] = [ trigger, feeling, response, example ].map(oneLine);
    const cleanTrigger = String(trigger ?? "").trim();
    if (!cleanTrigger) return "ต้องบอกประโยคที่จะสอนด้วย";

    // A trigger that already has quotes inside ("a" หรือ "b") is written as-is
    const heading = cleanTrigger.includes('"') ? cleanTrigger : `"${cleanTrigger}"`;
    const lines = [
        `## เมื่อได้ยิน: ${heading}`,
        String(feeling ?? "").trim()  && `- ความรู้สึก: ${String(feeling).trim()}`,
        String(response ?? "").trim() && `- ตอบแบบ: ${String(response).trim()}`,
        String(example ?? "").trim()  && `- ตัวอย่าง: ${String(example).trim()}`,
        `- สอนเมื่อ: ${today()}`,
    ].filter(Boolean);

    let isUpdate = false;
    await updateText(FILES.teachings, (text) => {
        const doc = splitSections(text);
        const index = doc.sections.findIndex((s) => triggerOf(s) === cleanTrigger);
        isUpdate = index >= 0;
        if (isUpdate) {
            doc.sections[index] = lines.join("\n");
        } else {
            doc.sections.push(lines.join("\n"));
        }
        return joinSections(doc);
    });
    return `${isUpdate ? "อัปเดต" : "เรียนรู้"}แล้ว: "${cleanTrigger}"`;
}

/**
 * Parses teachings.md into objects for the Teach tab.
 * @returns {Promise<{ trigger: string, feeling: string, response: string, example: string, date: string }[]>}
 */
export async function listTeachings() {
    const { sections } = splitSections(await safeRead(FILES.teachings));
    return sections
        .map((s) => {
            const lines = s.split("\n");
            const field = (label) => lines.find((l) => l.startsWith(`- ${label}:`))?.slice(label.length + 3).trim() ?? "";
            return {
                trigger: triggerOf(s),
                feeling: field("ความรู้สึก"),
                response: field("ตอบแบบ"),
                example: field("ตัวอย่าง"),
                date: field("สอนเมื่อ"),
            };
        })
        .filter((t) => t.trigger);
}

/**
 * Removes a teaching by its trigger text.
 * @returns {Promise<boolean>} true when something was removed
 */
export async function deleteTeaching(trigger) {
    const target = String(trigger ?? "").trim();
    let removed = false;
    await updateText(FILES.teachings, (text) => {
        const doc = splitSections(text);
        const before = doc.sections.length;
        doc.sections = doc.sections.filter((s) => triggerOf(s) !== target);
        removed = doc.sections.length !== before;
        return removed ? joinSections(doc) : null;
    });
    return removed;
}

/* ------------------------------------ chat style */

const STYLE_HEAD = "# สไตล์การพิมพ์\n";
const MAX_CORRECTIONS = 40;
const MAX_SAMPLES = 80;

/** Removes things that shouldn't end up in a prompt file: links, phone numbers, emails */
const redact = (s) =>
    String(s ?? "")
        .replace(/https?:\/\/\S+/g, "[ลิงก์]")
        .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "[อีเมล]")
        .replace(/(?:\+?66|0)[\d\s-]{8,11}\d/g, "[เบอร์]");

/**
 * Saves "she said X, a real person would say Y" under "## แก้จากแชท", newest last.
 * @param {{ before: string, after: string, context?: string }} pair after may hold several bubbles split by newlines
 */
export async function addStyleCorrection({ before, after, context = "" } = {}) {
    const bad = String(before ?? "").trim();
    const good = String(after ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
    if (!bad || !good.length) throw new Error("ต้องมีทั้งข้อความเดิมและข้อความที่ควรพิมพ์");

    const entry = [
        context.trim() ? `- ผู้ใช้พิมพ์: "${redact(context.trim()).slice(0, 120)}"` : "- (ต่อจากบทสนทนา)",
        `  ❌ ${bad.replace(/\n+/g, " / ")}`,
        ...good.map((g) => `  ✅ ${g}`),
    ].join("\n");

    let count = 0;
    await updateText(FILES.style, (text) => {
        const doc = splitSections(text || STYLE_HEAD);
        let index = doc.sections.findIndex((x) => sectionTitle(x) === "แก้จากแชท");
        if (index < 0) {
            doc.sections.push("## แก้จากแชท");
            index = doc.sections.length - 1;
        }

        // Keep the heading and its note, then the newest pairs only so the prompt doesn't balloon
        const [ heading, ...rest ] = doc.sections[index].split("\n");
        const notes = rest.filter((l) => l.startsWith(">"));
        const pairs = rest.filter((l) => !l.startsWith(">")).join("\n").split(/\n(?=- )/).map((x) => x.trim()).filter(Boolean);
        pairs.push(entry);
        doc.sections[index] = [ heading, ...notes, ...pairs.slice(-MAX_CORRECTIONS) ].join("\n");
        count = Math.min(pairs.length, MAX_CORRECTIONS);
        return joinSections(doc);
    });
    return count;
}

/**
 * Adds real chat lines as tone samples. Understands LINE's exported .txt (time, name, message by tabs).
 * @param {string} raw pasted text
 * @param {{ speaker?: string }} [options] keep only this speaker's lines when the paste has names
 * @returns {Promise<number>} lines added
 */
export async function addStyleSamples(raw, { speaker = "" } = {}) {
    const wanted = String(speaker ?? "").trim();
    const lines = String(raw ?? "")
        .split(/\r?\n/)
        .map((line) => {
            const cols = line.split("\t");
            if (cols.length >= 3) {
                if (wanted && cols[1].trim() !== wanted) return "";
                return cols.slice(2).join(" ");
            }
            // A plain paste may still look like "name: message"
            const m = line.match(/^([^:：]{1,20})[:：]\s*(.+)$/);
            if (m && wanted) return m[1].trim() === wanted ? m[2] : "";
            return line;
        })
        .map((l) => redact(l).trim())
        // System lines from LINE exports and media placeholders carry no style
        .filter((l) => l.length >= 1 && l.length <= 80 && !/^\[(รูป|สติกเกอร์|Photo|Sticker|วิดีโอ|Video|ไฟล์|File)\]$/i.test(l))
        .filter((l) => !/^\d{4}[./-]\d{2}[./-]\d{2}|^\d{2}:\d{2}$|^(วัน|Mon|Tue|Wed|Thu|Fri|Sat|Sun)/.test(l));

    if (!lines.length) return 0;

    let added = 0;
    await updateText(FILES.style, (text) => {
        const doc = splitSections(text || STYLE_HEAD);
        let index = doc.sections.findIndex((x) => sectionTitle(x) === "ตัวอย่างจากแชทจริง");
        if (index < 0) {
            doc.sections.push("## ตัวอย่างจากแชทจริง");
            index = doc.sections.length - 1;
        }
        const [ heading, ...rest ] = doc.sections[index].split("\n");
        const notes = rest.filter((l) => l.startsWith(">"));
        const existing = rest.filter((l) => l.startsWith("- ")).map((l) => l.slice(2));
        const merged = [ ...new Set([ ...existing, ...lines ]) ].slice(-MAX_SAMPLES);
        doc.sections[index] = [ heading, ...notes, ...merged.map((l) => `- ${l}`) ].join("\n");
        added = new Set(lines.filter((l) => !existing.includes(l))).size;
        return joinSections(doc);
    });
    return added;
}

/* ------------------------------------ editable files */

const EDITABLE = [ "persona", "style", "teachings", "memory", "state", "threads", "diary", "journal", "people", "today", "dates", "opinions" ];

/** Only the known md files can be read or written from the web page */
export async function readEditable(name) {
    if (!EDITABLE.includes(name)) throw new Error("ไม่รู้จักไฟล์นี้");
    return safeRead(FILES[name]);
}

export async function writeEditable(name, text) {
    if (!EDITABLE.includes(name)) throw new Error("ไม่รู้จักไฟล์นี้");
    await withFileLock(FILES[name], () => writeAtomic(FILES[name], `${String(text ?? "").trimEnd()}\n`));
}

export { loadSettings, saveSettings };

/* ------------------------------------ history */

/**
 * Today's log as chat entries, so a page refresh shows the conversation again.
 * @returns {Promise<{ who: "user" | "agent", time: string, text: string }[]>}
 */
export async function todayEntries(limit = 120) {
    return parseEntries(await safeRead(path.join(historyDir(), `${today()}.md`))).slice(-limit);
}

/* ------------------------------------ history log */

/**
 * Appends one line of the conversation to today's log file.
 * @param {"user" | "agent"} who
 * @param {string} name display name in the log
 * @param {string} text
 */
export async function logTurn(who, name, text, at = Date.now()) {
    await mkdir(historyDir(), { recursive: true });
    const date = today();
    const file = path.join(historyDir(), `${date}.md`);
    const label = who === "user" ? `**${name}**` : `*${name}*`;
    // User messages keep the time they were sent, not the time she got around to reading them
    const time = new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
    const line = `[${time}] ${label}: ${String(text ?? "").replace(/\n+/g, " / ")}`;
    await updateText(file, (current) => `${current || `# บทสนทนา ${date}\n\n`}${line}\n\n`);
    return { date, line };
}

/**
 * Rewrites one line logTurn wrote, e.g. when she stopped typing and some bubbles were never sent.
 * @param {{ date: string, line: string }} logged what logTurn returned
 * @param {string | null} replacement the new line, or null to remove it
 * @returns {Promise<boolean>} true when the line was found
 */
export async function replaceLoggedLine(logged, replacement) {
    if (!logged?.date || !logged?.line) return false;
    let found = false;
    await updateText(path.join(historyDir(), `${logged.date}.md`), (current) => {
        const lines = current.split("\n");
        const index = lines.lastIndexOf(logged.line);
        if (index < 0) return null;
        found = true;
        if (replacement == null) {
            // Take the blank line after it too, so the log keeps one empty line between entries
            lines.splice(index, lines[index + 1] === "" ? 2 : 1);
        } else {
            lines[index] = replacement;
        }
        return lines.join("\n");
    });
    return found;
}

/**
 * Her bubbles as one log line. " / " separates bubbles in the log, so a " / " inside a bubble
 * becomes a full-width slash; otherwise a refresh would split one bubble into two.
 * @param {string[]} bubbles
 */
export const bubblesForLog = (bubbles) =>
    (Array.isArray(bubbles) ? bubbles : [ bubbles ])
        .map((b) => String(b ?? "").replace(/\s*\n+\s*/g, " ").replace(/ \/ /g, " ／ "))
        .join("\n");

/* ------------------------------------ older days */

const DAY_FILE = /^\d{4}-\d{2}-\d{2}\.md$/;

const MESSAGE_LINE = /^\[(\d{2}:\d{2})\] (\*\*|\*)(.+?)\2: (.*)$/;
// "[07:05] รีแอค ❤️ โดย **ผู้ใช้** ที่ข้อความ [07:04] "ไปไหนมา"": kept in the day's log so a reaction
// survives a refresh, travels with exports and snapshots, and she reads it as part of the chat
const REACTION_LINE = /^\[(\d{2}:\d{2})\] รีแอค (\S+) โดย (\*\*|\*)(.+?)\3 ที่ข้อความ \[(\d{2}:\d{2})\] "(.*)"$/;

/** The bubbles a log entry is drawn as: her lines hold several bubbles split by " / ", yours are one */
const bubblesOf = (entry) => (entry.who === "agent" ? String(entry.text).split(" / ") : [ entry.text ]);

/**
 * Chat entries from a day's log, each with the reactions on it:
 * `reactions[i]` is the emoji on bubble i (latest reaction wins).
 */
const parseEntries = (text) => {
    const entries = [];
    for (const line of String(text ?? "").split("\n")) {
        const m = line.match(MESSAGE_LINE);
        if (m) {
            entries.push({ who: m[2] === "**" ? "user" : "agent", time: m[1], text: m[4], reactions: [] });
            continue;
        }
        const r = line.match(REACTION_LINE);
        if (!r) continue;
        // A reaction by the user lands on her message, and hers on the user's
        const targetWho = r[3] === "**" ? "agent" : "user";
        for (let i = entries.length - 1; i >= 0; i--) {
            const e = entries[i];
            if (e.who !== targetWho || e.time !== r[5]) continue;
            const index = bubblesOf(e).indexOf(r[6]);
            if (index < 0) continue;
            e.reactions[index] = r[2];
            break;
        }
    }
    // No holes: bubbles without a reaction get "" so the list reads the same in JSON and in code
    return entries.map((e) => ({ ...e, reactions: Array.from(e.reactions, (x) => x ?? "") }));
};

/** How one bubble is written in the log, so a reaction can find it again */
const logTextOf = (who, text) =>
    who === "agent"
        ? bubblesForLog([ text ])
        : String(text ?? "").replace(/\n+/g, " / ");

/**
 * Saves a reaction into the log of the day its message is in.
 * @param {{ by: "user" | "agent", name: string, emoji: string, targetTime: string, targetText: string, date?: string }} reaction
 *   date: the day of the message; without it, today and then yesterday are tried
 * @returns {Promise<boolean>} false when the message isn't in any log (nothing is saved then)
 */
export async function logReaction({ by, name, emoji, targetTime, targetText, date = "" }) {
    const e = String(emoji ?? "").trim().replace(/\s+/g, "").slice(0, 8);
    const time = String(targetTime ?? "");
    if (!e || !/^\d{2}:\d{2}$/.test(time)) return false;
    const targetWho = by === "user" ? "agent" : "user";
    const text = logTextOf(targetWho, targetText).trim();
    if (!text) return false;

    const yesterday = new Date(Date.now() - 86400000).toLocaleDateString("sv-SE");
    const days = /^\d{4}-\d{2}-\d{2}$/.test(String(date)) ? [ date ] : [ today(), yesterday ];
    const label = by === "user" ? `**${name}**` : `*${String(name).replace(/\*/g, "")}*`;

    for (const day of days) {
        // Older days may already be archived
        for (const file of [ path.join(historyDir(), `${day}.md`), path.join(archiveDir(), `${day}.md`) ]) {
            let saved = false;
            await updateText(file, (current) => {
                const target = findTarget(parseEntries(current), targetWho, time, text);
                if (!target) return null;
                saved = true;
                // The log's own time for that message, so reading it back is an exact match
                return `${current.trimEnd()}\n\n[${clock()}] รีแอค ${e} โดย ${label} ที่ข้อความ [${target.time}] "${text}"\n\n`;
            });
            if (saved) return true;
        }
    }
    return false;
}

const minutesOf = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const NEAR_MINUTES = 10;

/**
 * The message a reaction is for. The page shows her bubbles at the time they appeared,
 * which can be a minute or two after the time in the log, so a close time with the same text counts.
 */
function findTarget(entries, who, time, text) {
    const same = entries.filter((x) => x.who === who && bubblesOf(x).includes(text));
    return same.findLast((x) => x.time === time)
        ?? same.findLast((x) => Math.abs(minutesOf(x.time) - minutesOf(time)) <= NEAR_MINUTES)
        ?? null;
}

/**
 * The closest day before `before` that has messages, from today's folder or the archive.
 * @returns {Promise<{ date: string | null, entries: { who: string, time: string, text: string }[] }>}
 */
export async function previousDay(before) {
    const limit = /^\d{4}-\d{2}-\d{2}$/.test(String(before ?? "")) ? before : today();
    const found = [];
    for (const dir of [ historyDir(), archiveDir() ]) {
        try {
            for (const f of await readdir(dir)) if (DAY_FILE.test(f) && f.slice(0, 10) < limit) found.push({ date: f.slice(0, 10), file: path.join(dir, f) });
        } catch {}
    }
    const latest = found.sort((a, b) => b.date.localeCompare(a.date))[0];
    if (!latest) return { date: null, entries: [] };
    return { date: latest.date, entries: parseEntries(await safeRead(latest.file)) };
}

/**
 * Replaces one of today's logged user messages with an "unsent" marker.
 * Matches on time and text because log lines carry no ids.
 * @returns {Promise<boolean>} true when a line was changed
 */
export async function unsendFromHistory(text, time) {
    const body = String(text ?? "").replace(/\n+/g, " / ");
    // A message sent just before midnight may have been answered (and logged) just after it
    const yesterday = new Date(Date.now() - 86400000).toLocaleDateString("sv-SE");
    for (const day of [ today(), yesterday ]) {
        let changed = false;
        await updateText(path.join(historyDir(), `${day}.md`), (current) => {
            const lines = current.split("\n");
            for (let i = lines.length - 1; i >= 0; i--) {
                const m = lines[i].match(/^\[(\d{2}:\d{2})\] \*\*(.+?)\*\*: (.*)$/);
                if (m && m[3] === body && (!time || m[1] === time)) {
                    lines[i] = `[${m[1]}] **${m[2]}**: ${UNSENT}`;
                    changed = true;
                    return lines.join("\n");
                }
            }
            return null;
        });
        if (changed) return true;
    }
    return false;
}

const UNSENT = "[ยกเลิกข้อความ]";

/* ------------------------------------ messages waiting for her */

// Saved the moment you press send, so a refresh, a closed tab or a restart never loses them.
// They move into the history log once she actually reads and answers.
const pendingFile = () => path.join(activeDir(), "pending.json");

/** @returns {Promise<{ id: string, text: string, sentAt: number, readAt: number }[]>} */
export async function loadPending() {
    try {
        const list = JSON.parse(await readFile(pendingFile(), "utf8"));
        return Array.isArray(list) ? list.filter((m) => m?.id && typeof m.text === "string") : [];
    } catch {
        return [];
    }
}

/**
 * Every change to the waiting list goes through here, one at a time, so a message sent
 * while she is answering can't be lost when her answer removes the older ones.
 * @param {(list: object[]) => any} change edits the list in place; return false to skip saving
 */
function changePending(change) {
    const file = pendingFile();
    return withFileLock(file, async () => {
        const list = await loadPending();
        const result = await change(list);
        if (result !== false) await writeAtomic(file, `${JSON.stringify(list, null, 1)}\n`);
        return result;
    });
}

export async function addPending({ id, text }) {
    const cleanId = String(id ?? "").replace(/[^\w-]/g, "").slice(0, 40);
    const cleanText = String(text ?? "").trim().slice(0, 4000);
    if (!cleanId || !cleanText) throw new Error("ข้อความว่าง");
    await changePending((list) => {
        // Retrying a send must not duplicate the message
        if (list.some((m) => m.id === cleanId)) return false;
        list.push({ id: cleanId, text: cleanText, sentAt: Date.now(), readAt: 0 });
    });
}

export async function markPendingRead(ids) {
    const wanted = new Set((ids ?? []).map(String));
    await changePending((list) => {
        let changed = false;
        for (const m of list) {
            if (wanted.has(m.id) && !m.readAt) {
                m.readAt = Date.now();
                changed = true;
            }
        }
        return changed;
    });
}

/** Pending messages for these ids, in the order they were sent */
export async function takePending(ids) {
    const wanted = new Set((ids ?? []).map(String));
    return (await loadPending()).filter((m) => wanted.has(m.id));
}

/**
 * Takes back a message she hasn't answered yet.
 * @returns {Promise<{ found: boolean, wasRead: boolean, text: string }>}
 */
export function unsendPending(id) {
    return changePending((list) => {
        const index = list.findIndex((m) => m.id === String(id ?? ""));
        if (index < 0) return false;
        const [ item ] = list.splice(index, 1);
        return { found: true, wasRead: Boolean(item.readAt), text: item.text };
    }).then((r) => r || { found: false, wasRead: false, text: "" });
}

/** Editing is only allowed before she reads it, like fixing a typo before the other side sees it */
export async function editPending(id, text) {
    const clean = String(text ?? "").trim().slice(0, 4000);
    if (!clean) throw new Error("ข้อความว่าง");
    await changePending((list) => {
        const item = list.find((m) => m.id === String(id ?? ""));
        if (!item) throw new Error("ข้อความนี้ถูกตอบไปแล้ว แก้ไม่ได้");
        if (item.readAt) throw new Error("เธออ่านแล้ว แก้ไม่ได้ ยกเลิกส่งได้อย่างเดียว");
        item.text = clean;
        item.isEdited = true;
    });
}

export async function removePending(ids) {
    const gone = new Set((ids ?? []).map(String));
    await changePending((list) => {
        const kept = list.filter((m) => !gone.has(m.id));
        if (kept.length === list.length) return false;
        list.splice(0, list.length, ...kept);
    });
}

/** Tail of the latest history file, so the agent picks up where the last run stopped */
export async function loadRecentHistory(maxChars = 3000) {
    try {
        const files = (await readdir(historyDir())).filter((f) => f.endsWith(".md")).sort();
        const latest = files.at(-1);
        if (!latest) return "";
        const text = await safeRead(path.join(historyDir(), latest));
        return text.length > maxChars ? "…" + text.slice(-maxChars) : text;
    } catch {
        return "";
    }
}

/**
 * History files from earlier days that haven't been summarized into the journal yet.
 * @returns {Promise<{ date: string, file: string }[]>}
 */
export async function pastHistoryFiles() {
    try {
        const names = await readdir(historyDir());
        return names
            .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f) && f.slice(0, 10) < today())
            .sort()
            .map((f) => ({ date: f.slice(0, 10), file: path.join(historyDir(), f) }));
    } catch {
        return [];
    }
}

/** Moves a summarized day out of the way; the raw log is kept, only the prompt stops reading it */
export async function archiveHistory(file) {
    await mkdir(archiveDir(), { recursive: true });
    // Locked like every write to a day log, so a take-back can't re-create the file after it moved
    await withFileLock(file, () => rename(file, path.join(archiveDir(), path.basename(file))));
}

/* ------------------------------------ search */

/**
 * Finds messages containing the query in this character's chat logs, newest first.
 * @returns {Promise<{ date: string, time: string, who: "user" | "agent", text: string }[]>}
 */
export async function searchHistory(query, limit = 80) {
    const q = String(query ?? "").trim().toLowerCase();
    if (!q) return [];
    const dirs = [ historyDir(), archiveDir() ];
    const results = [];
    for (const dir of dirs) {
        let names = [];
        try {
            names = (await readdir(dir)).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f));
        } catch {
            continue;
        }
        for (const name of names) {
            const text = await safeRead(path.join(dir, name));
            for (const line of text.split("\n")) {
                const m = line.match(/^\[(\d{2}:\d{2})\] (\*\*|\*)(.+?)\2: (.*)$/);
                if (m && m[4].toLowerCase().includes(q)) {
                    results.push({ date: name.slice(0, 10), time: m[1], who: m[2] === "**" ? "user" : "agent", text: m[4] });
                }
            }
        }
    }
    return results.sort((a, b) => `${b.date}${b.time}`.localeCompare(`${a.date}${a.time}`)).slice(0, limit);
}

/* ------------------------------------ uploads */

const IMAGE_TYPES = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

/**
 * Saves a picture the user sent (a data: URL from the page) into this character's uploads/.
 * @returns {Promise<string>} file name to put in the message as [รูป:name]
 */
export async function saveUpload(dataUrl) {
    const m = String(dataUrl ?? "").match(/^data:(image\/[a-z+]+);base64,(.+)$/);
    const ext = IMAGE_TYPES[m?.[1]];
    if (!ext) throw new Error("รองรับเฉพาะรูป jpg, png, webp, gif");
    const bytes = Buffer.from(m[2], "base64");
    if (bytes.length > MAX_UPLOAD_BYTES) throw new Error("รูปใหญ่เกิน 8MB");

    await mkdir(uploadsDir(), { recursive: true });
    const name = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}.${ext}`;
    await writeFile(path.join(uploadsDir(), name), bytes);
    return name;
}

/** Only plain generated names are served, so a request can't walk out of uploads/ */
export async function readUpload(name) {
    const clean = String(name ?? "");
    if (!/^[a-z0-9]+\.(jpg|png|webp|gif)$/.test(clean)) throw new Error("ไม่พบรูป");
    return { bytes: await readFile(path.join(uploadsDir(), clean)), ext: clean.split(".").pop() };
}

/* ------------------------------------ journal */

const JOURNAL_HEAD = "# บันทึกความทรงจำ\n\n> สรุปของแต่ละวันจากมุมมองของตัวละคร ระบบเขียนเองเมื่อขึ้นวันใหม่ แก้ได้\n";

export async function appendJournal(date, summary) {
    await updateText(FILES.journal, (text) => {
        const doc = splitSections(text || JOURNAL_HEAD);
        doc.sections = doc.sections.filter((s) => sectionTitle(s) !== date);
        doc.sections.push(`## ${date}\n${String(summary ?? "").trim()}`);
        return joinSections(doc);
    });
}

/* ------------------------------------ read all */

/**
 * Reads the md files the persona is built from. Called each turn so manual edits apply immediately.
 */
export async function loadTexts() {
    const [ persona, teachings, memory, journal, style ] = await Promise.all([
        safeRead(FILES.persona),
        safeRead(FILES.teachings),
        safeRead(FILES.memory),
        safeRead(FILES.journal),
        safeRead(FILES.style),
    ]);
    return { persona, teachings, memory, journal: lastSections(journal, 7), style };
}

export const readMemoryFile = () => safeRead(FILES.memory);
export const readTeachingsFile = () => safeRead(FILES.teachings);

export {
    FILES,
    DATA_DIR,
    historyDir,
    uploadsDir,
    today,
    nowIso,
    safeRead,
    splitSections,
    joinSections,
    sectionTitle,
    appendToSection,
    lastSections,
};
