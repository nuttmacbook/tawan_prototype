import { readFile } from "node:fs/promises";
import path from "node:path";
import { chatUsers, chatDirOf, currentId, currentUser, pinProfile } from "./profiles.js";
import { loadState, stageOf, agoText } from "./mood.js";
import { getUser, listUsers, publicUser } from "./users.js";

/* ------------------------------------ the other people she chats with */

// She talks with several users, each in their own chat. Like a real friend she knows they are
// different people, and when one asks "do you know B? how's B lately?" she can answer from
// what she knows of B. Testers agreed their chats may be shared, so for now this is everything
// she remembers about them (trimmed); a privacy setting per user comes later.

const MAX_PEOPLE = 6;
const PER_PERSON = 700;
const FACTS = 10;
const JOURNAL_LINES = 4;

const read = (file) => readFile(file, "utf8").catch(() => "");

/** Fact lines from memory.md, the ones about who they are first */
export function factsOf(memory, limit = FACTS) {
    const sections = [];
    let current = null;
    for (const line of String(memory ?? "").split("\n")) {
        const h = line.match(/^##\s+(.+)/);
        if (h) {
            current = { title: h[1].trim(), facts: [] };
            sections.push(current);
        } else if (current && /^\s*-\s+\S/.test(line)) {
            current.facts.push(line.replace(/^\s*-\s+(\[\d{4}-\d{2}-\d{2}\]\s*)?/, "").trim());
        }
    }
    const isCore = (s) => /เกี่ยวกับผู้ใช้|ชื่อเรียก|งาน|ครอบครัว|ความชอบ/.test(s.title);
    return [ ...sections.filter(isCore), ...sections.filter((s) => !isCore(s)) ]
        .flatMap((s) => s.facts.map((f) => `${f}`))
        .slice(0, limit);
}

/** The last few lines of their journal: what happened between you two lately */
export const recentOf = (journal, limit = JOURNAL_LINES) =>
    String(journal ?? "").split("\n").filter((l) => /^\s*-\s+\S/.test(l)).slice(-limit).map((l) => l.replace(/^\s*-\s+/, "").trim());

/**
 * Everyone else who chats with the current character, as she knows them.
 * @returns {Promise<string>} "" when nobody else talks to her
 */
export async function othersNote() {
    const bot = currentId();
    const me = currentUser();
    if (!me) return "";
    const ids = (await chatUsers(bot)).filter((id) => id !== me);
    if (!ids.length) return "";
    const viewer = await getUser(me);
    const users = new Map((await listUsers()).map((u) => [ u.id, u ]));

    const rows = [];
    for (const id of ids) {
        const u = users.get(id);
        if (!u) continue;
        const dir = chatDirOf(bot, id);
        const [ memory, journal, state ] = await Promise.all([
            read(path.join(dir, "memory.md")),
            read(path.join(dir, "journal.md")),
            pinProfile(() => loadState(), bot, id).catch(() => null),
        ]);
        // Never talked yet: nothing to say about them
        if (!state?.lastSeen && !factsOf(memory).length) continue;
        const facts = factsOf(memory);
        const recent = recentOf(journal);
        const lines = [
            `- ${u.name} (@${u.handle}) · ${stageOf(state?.closeness ?? 0).label} · คุยกันล่าสุด ${state?.lastSeen ? agoText(Date.now() - state.lastSeen) : "ยังไม่เคย"}` +
                (viewer?.friends?.includes(id) ? " · เป็นเพื่อนกับผู้ใช้คนนี้ในแอป" : ""),
            facts.length ? `  รู้เกี่ยวกับเขา: ${facts.join(" · ")}` : "",
            recent.length ? `  ช่วงนี้: ${recent.join(" · ")}` : "",
        ].filter(Boolean).join("\n");
        rows.push({ at: Number(state?.lastSeen ?? 0), text: lines.slice(0, PER_PERSON) });
    }
    return rows.sort((a, b) => b.at - a.at).slice(0, MAX_PEOPLE).map((r) => r.text).join("\n");
}

/** Who she's talking to right now, by the name they use in the app */
export async function thisUserNote() {
    const u = publicUser(await getUser(currentUser()));
    return u ? `ชื่อในแอป: ${u.name} (@${u.handle})` : "";
}
