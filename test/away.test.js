// When she texts first while you are gone, and how she follows up
import "./quiet.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Never touch the real data folder
process.env.PERSONA_DATA_DIR = await mkdtemp(path.join(os.tmpdir(), "persona-away-"));
const { pingDue } = await import("../server/away.js");
const { awayPingNote } = await import("../server/brain.js");

const H = 3600000;
const NOW = new Date("2026-10-26T12:00:00").getTime();
const base = { awayHours: 4, maxPerDay: 2, now: NOW };

test("first text after the quiet hours", () => {
    assert.equal(pingDue({ ...base, lastSeen: NOW - 3 * H }), null);
    const due = pingDue({ ...base, lastSeen: NOW - 5 * H });
    assert.equal(due?.unanswered, 0);
});

test("unanswered: follows up a day later, then once more, then waits", () => {
    const lastSeen = NOW - 72 * H;
    const one = { date: "2026-10-25", count: 1, lastAt: NOW - 10 * H, unanswered: 1 };
    assert.equal(pingDue({ ...base, lastSeen, log: one }), null, "too soon after the first");
    assert.equal(pingDue({ ...base, lastSeen, log: { ...one, lastAt: NOW - 21 * H } })?.unanswered, 1);

    const two = { date: "2026-10-25", count: 1, lastAt: NOW - 30 * H, unanswered: 2 };
    assert.equal(pingDue({ ...base, lastSeen, log: two }), null, "second follow-up waits longer");
    assert.equal(pingDue({ ...base, lastSeen, log: { ...two, lastAt: NOW - 45 * H } })?.unanswered, 2);

    const three = { date: "2026-10-24", count: 1, lastAt: NOW - 60 * H, unanswered: 3 };
    assert.equal(pingDue({ ...base, lastSeen, log: three }), null, "stops after three");
});

test("an older log without the counter counts as one unanswered text", () => {
    const due = pingDue({ ...base, lastSeen: NOW - 48 * H, log: { date: "2026-10-25", count: 1, lastAt: NOW - 24 * H } });
    assert.equal(due?.unanswered, 1);
});

test("you answered: the streak starts over", () => {
    const due = pingDue({ ...base, lastSeen: NOW - 6 * H, log: { date: "2026-10-25", count: 1, lastAt: NOW - 30 * H, unanswered: 3 } });
    assert.equal(due?.unanswered, 0);
});

test("daily cap and off switch still hold", () => {
    const lastSeen = NOW - 30 * H;
    assert.equal(pingDue({ ...base, lastSeen, log: { date: "2026-10-26", count: 2, lastAt: NOW - 25 * H, unanswered: 1 } }), null);
    assert.equal(pingDue({ ...base, awayHours: 0, lastSeen }), null);
    assert.equal(pingDue({ ...base, lastSeen: null }), null);
});

test("the follow-up note says her text is still unanswered", () => {
    assert.match(awayPingNote(5), /ไม่ได้เปิดแชท/);
    assert.match(awayPingNote(30, 1, 22 * H), /ยังไม่ได้รับคำตอบ/);
    assert.match(awayPingNote(60, 2, 40 * H), /3 วัน|2 วัน/);
    assert.match(awayPingNote(60, 2, 40 * H), /ห่วง/);
});
