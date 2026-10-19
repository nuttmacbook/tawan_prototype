// Closer to a real friend: the shape of a turn, special days, odd days and goals, the coach,
// and noticing late nights. No brain and no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.PERSONA_DATA_DIR = await mkdtemp(path.join(os.tmpdir(), "persona-closer-"));

const profiles = await import("../server/profiles.js");
await profiles.initProfiles();
const store = await import("../server/store.js");
const { rhythmFor, capBubbles, isQuestion } = await import("../server/humanize.js");
const { cleanDate, upcomingDays, noteDate } = await import("../server/life.js");
const world = await import("../server/world.js");
const coach = await import("../server/coach.js");
const { careNote, recordUse, loadUsage } = await import("../server/usage.js");

/* ------------------------------------ the shape of a turn (from the real chat of 2026-10-18) */

const u = (text) => ({ role: "user", text });
const a = (...bubbles) => ({ role: "assistant", text: bubbles.join("\n\n") });

test("isQuestion: Thai particles, not 'ไม่เป็นไร'", () => {
    assert.deepEqual([ "กินไรยัง", "งานหนักขนาดนั้นเลยหรอ", "ไปไหนมา", "ไม่เป็นไร", "ไปนอนก่อนเหอะ" ].map(isQuestion), [ true, true, true, false, false ]);
});

test("rhythm: a question she already asked is listed so she doesn't ask it again", () => {
    const r = rhythmFor([ u("ใช่เลยวันธรรมดาแทบไม่ได้นอน"), a("อ้าว", "วันธรรมดาแทบไม่ได้นอนเลยหรอ"), u("ทำไมยังไม่ได้นอน วันนี้ทำอะไรมาบ้างเล่าหน่อย") ]);
    assert.match(r.note, /วันธรรมดาแทบไม่ได้นอนเลยหรอ/);
});

test("rhythm: a one-word message gets at most two bubbles", () => {
    const r = rhythmFor([ a("เล่าให้ฟังนะ"), u("โอเค") ]);
    assert.equal(r.maxBubbles, 2);
    assert.match(r.note, /สั้นมาก/);
    assert.equal(rhythmFor([ u("วันนี้ไปทำงานมา เหนื่อยมากเลย หัวหน้าให้งานเพิ่มอีกสามอย่าง ไม่รู้จะทำทันไหม") ]).maxBubbles, 4);
});

test("rhythm: after two replies ending in a question, this one shouldn't", () => {
    const r = rhythmFor([ u("หวัดดี"), a("หวัดดี", "ทำไรอยู่"), u("ดูหนัง"), a("เรื่องไรอ่ะ"), u("หนังผี") ]);
    assert.match(r.note, /ไม่ต้องถาม/);
});

test("rhythm: after goodnight, one short bubble and no second goodbye", () => {
    const r = rhythmFor([ u("ไปนอนละ"), a("จ้า", "ฝันดีน้า"), u("คับผท") ]);
    assert.equal(r.maxBubbles, 1);
    assert.match(r.note, /ห้ามบอกลาซ้ำ/);
});

test("rhythm: a turn the app started (greeting) isn't treated as a short message", () => {
    const r = rhythmFor([ u("[ระบบ: ผู้ใช้เพิ่งเปิดหน้าแชท]") ]);
    assert.equal(r.maxBubbles, 3);
    assert.equal(r.note, "");
});

test("capBubbles: extras join the last one, nothing is lost", () => {
    assert.deepEqual(capBubbles([ "a", "b", "c", "d" ], 2), [ "a", "b c d" ]);
    assert.deepEqual(capBubbles([ "a" ], 2), [ "a" ]);
});

/* ------------------------------------ special days */

test("cleanDate: yearly and one-off dates, nothing else", () => {
    assert.equal(cleanDate("3-14"), "03-14");
    assert.equal(cleanDate("2026-11-2"), "2026-11-02");
    assert.equal(cleanDate("14 มีนา"), "");
    assert.equal(cleanDate("13-40"), "");
});

test("upcomingDays: birthdays, one-off days and how long you've talked", () => {
    const text = "# วันสำคัญ\n- 10-20 | วันเกิดผู้ใช้\n- 2025-10-19 | ปีที่แล้ว\n- 2026-10-19 | สัมภาษณ์งาน";
    const now = new Date("2026-10-19T10:00:00");
    assert.deepEqual(upcomingDays(text, { now, firstChat: "2026-07-11" }), [ "พรุ่งนี้: วันเกิดผู้ใช้", "วันนี้: สัมภาษณ์งาน", "วันนี้: คุยกันมาครบ 100 วัน (เริ่มคุยวันที่ 2026-07-11)" ]);
    assert.deepEqual(upcomingDays(text, { now: new Date("2027-07-11T09:00:00"), firstChat: "2026-07-11" }), [ "วันนี้: คุยกันมาครบ 1 ปี" ]);
});

test("noteDate: the same thing told again keeps one line with the new date", async () => {
    await noteDate({ what: "วันเกิดผู้ใช้", date: "03-14" });
    await noteDate({ what: "วันเกิดผู้ใช้", date: "3-15" });
    const text = await store.readEditable("dates");
    assert.equal(text.match(/^- .*วันเกิดผู้ใช้$/gm)?.length, 1);
    assert.match(text, /- 03-15 \| วันเกิดผู้ใช้/);
});

/* ------------------------------------ odd days and goals */

test("pickDayType: rare, and never two odd days in a row", () => {
    assert.equal(world.pickDayType({}, () => 0.5), "normal");
    assert.equal(world.pickDayType({}, () => 0.01), "busy");
    assert.equal(world.pickDayType({ days: [ { date: "2000-01-01", dayType: "away" } ] }, () => 0.01), "normal");
});

test("cleanFound + renderToday: goals and an odd day show in today.md", () => {
    const found = world.cleanFound({ goals: [ { title: "ช่องยูทูปถึงพันซับ", progress: 140, note: "ขึ้นมา 20" }, { progress: 3 } ], dayReason: "ลูกค้าเร่งงาน" });
    assert.deepEqual(found.goals, [ { title: "ช่องยูทูปถึงพันซับ", progress: 100, note: "ขึ้นมา 20", status: "done" } ]);
    const md = world.renderToday({ date: "2026-10-19", dayType: "busy", ...found }, "ตะวัน");
    assert.match(md, /ยุ่งทั้งวัน.*: ลูกค้าเร่งงาน/);
    assert.match(md, /ช่องยูทูปถึงพันซับ — สำเร็จแล้ว!/);
});

/* ------------------------------------ the coach */

test("coach: suggestions are checked, and accepting one makes a lesson", async () => {
    const list = coach.cleanSuggestions({ suggestions: [ { problem: "ถามซ้ำ", quote: "วันธรรมดาไม่ได้นอนหรอ", trigger: "ผู้ใช้ตอบคำถามแล้ว", response: "ต่อจากคำตอบ ไม่ถามซ้ำ" }, { problem: "ไม่มีบทเรียน" } ] }, "2026-10-18");
    assert.equal(list.length, 1);

    const dir = path.join(profiles.activeDir(), "history");
    await mkdir(dir, { recursive: true });
    const yesterday = new Date(Date.now() - 86400000).toLocaleDateString("sv-SE");
    await writeFile(path.join(dir, `${yesterday}.md`), Array.from({ length: 8 }, (_, i) => `[10:0${i}] **ผู้ใช้**: ข้อความ ${i}`).join("\n\n"));
    const fakeBrain = async () => JSON.stringify({ suggestions: [ { problem: "ตอบยาวเกิน", trigger: "ผู้ใช้ตอบสั้น", response: "ตอบสั้นตาม", example: "555 จริง" } ] });
    const result = await coach.reviewNow(fakeBrain);
    assert.deepEqual(result, { date: yesterday, added: 1 });
    const [ s ] = (await coach.loadCoach()).suggestions;
    assert.match(await coach.decide(s.id, true), /ผู้ใช้ตอบสั้น/);
    assert.equal((await coach.loadCoach()).suggestions.length, 0);
    assert.ok((await store.listTeachings()).some((t) => t.trigger === "ผู้ใช้ตอบสั้น"));
});

/* ------------------------------------ late nights */

test("usage: a third late night in five gets a caring note, a heavy day another", async () => {
    const at = (s) => new Date(s).getTime();
    for (const night of [ "2026-10-15", "2026-10-16", "2026-10-17" ]) {
        const next = new Date(at(`${night}T12:00:00`) + 86400000).toLocaleDateString("sv-SE");
        await recordUse(4, at(`${next}T02:30:00`));
    }
    const usage = await loadUsage();
    assert.equal(usage["2026-10-16"].late, 4);
    assert.match(careNote(usage, new Date("2026-10-19T02:00:00")), /3 คืนจาก 5/);
    assert.equal(careNote(usage, new Date("2026-10-19T15:00:00")), "");
    assert.match(careNote({ "2026-10-19": { messages: 250, late: 0 } }, new Date("2026-10-19T15:00:00")), /250 ข้อความ/);
});
