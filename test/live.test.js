// Live updates (server/live.js): numbered per character, missed ones can be fetched again,
// and a stream gets each one as it happens.
import "./quiet.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";

process.env.PERSONA_DATA_DIR = await mkdtemp(path.join(os.tmpdir(), "persona-live-"));
const profiles = await import("../server/profiles.js");
await profiles.initProfiles();
const live = await import("../server/live.js");

test("publish numbers events and eventsSince returns only the missed ones", () => {
    const start = live.latestSeq();
    const a = live.publish({ type: "say", bubbles: [ "หวัดดี" ] });
    const b = live.publish({ type: "reply", bubbles: [ "โอเค" ], replyTo: [ "m1" ], reaction: "❤️" });
    assert.equal(b, a + 1);
    const { boot, events } = live.eventsSince(start);
    assert.equal(boot, live.BOOT);
    assert.deepEqual(events.map((e) => e.seq), [ a, b ]);
    assert.deepEqual(events[1].replyTo, [ "m1" ]);
    assert.deepEqual(live.eventsSince(b).events, []);
    // A page that knows a higher number than the server (server restarted) gets nothing wrong
    assert.deepEqual(live.eventsSince(b + 50).events, []);
});

test("each character has its own numbers", async () => {
    const other = await profiles.createProfile({ name: "อีกคน" });
    const seq = await profiles.pinProfile(async () => live.publish({ bubbles: [ "x" ] }), other);
    assert.equal(seq, 1);
});

test("a stream receives events as they're published, and stops when closed", () => {
    const req = new EventEmitter();
    const written = [];
    const res = { writeHead: () => {}, write: (s) => written.push(s), on: () => {} };
    live.stream(req, res);
    live.publish({ bubbles: [ "ส่งมาสด ๆ" ] });
    assert.ok(written.some((s) => s.startsWith("data: ") && s.includes("ส่งมาสด ๆ")));
    req.emit("close");
    const count = written.length;
    live.publish({ bubbles: [ "หลังปิด" ] });
    assert.equal(written.length, count);
});
