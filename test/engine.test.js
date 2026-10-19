// The chat rhythm from src/engine.js, run with a fake clock: minutes of chatting take milliseconds,
// and every step is checked without a browser.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createEngine } from "../src/engine.js";

/** A clock that only moves when the test says so */
function fakeClock() {
    let now = 1_000_000;
    let seq = 0;
    const queue = [];
    const add = (at, fn) => {
        const timer = { at, fn, id: seq++ };
        queue.push(timer);
        return timer;
    };
    const timers = {
        now: () => now,
        random: () => 0.5,
        sleep: (ms) => new Promise((resolve) => add(now + Math.max(0, ms), resolve)),
        setTimeout: (fn, ms) => add(now + ms, fn),
        clearTimeout: (timer) => {
            const i = queue.indexOf(timer);
            if (i >= 0) queue.splice(i, 1);
        },
    };
    const flush = async () => {
        for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
    };
    /** Runs everything due in the next `ms` milliseconds of fake time */
    async function run(ms) {
        const end = now + ms;
        await flush();
        for (;;) {
            queue.sort((a, b) => a.at - b.at || a.id - b.id);
            const next = queue[0];
            if (!next || next.at > end) break;
            queue.shift();
            now = next.at;
            next.fn();
            await flush();
        }
        now = end;
        await flush();
    }
    return { timers, run };
}

const PLAN = { readMs: 1000, laterMs: 0, activity: "", thinkMs: 500, typingCps: 10, pauseMs: [ 400, 400 ], reasons: [] };

/**
 * An engine wired to a fake server and a page that only records what it was asked to do.
 * @param {{ replies?: object[], plan?: object, brainMs?: number, settings?: object }} options
 */
function setup({ replies = [], plan = PLAN, brainMs = 2000, settings = {} } = {}) {
    const clock = fakeClock();
    const log = [];
    const calls = { chat: [], cut: [], read: [], nudge: 0 };
    const queue = [ ...replies ];
    let shown = 0;

    const api = {
        pacing: async () => plan,
        read: async (ids) => calls.read.push(ids),
        cut: async (n, bubbles) => calls.cut.push({ n, bubbles }),
        greet: async () => ({ bubbles: [] }),
        nudge: async () => {
            calls.nudge++;
            return { bubbles: [ "ทักนะ" ] };
        },
        chat: async (ids) => {
            calls.chat.push(ids);
            await clock.timers.sleep(brainMs);
            const next = queue.shift() ?? { bubbles: [ "โอเค" ] };
            if (next instanceof Error) throw next;
            return next;
        },
    };
    const ui = {
        append: (kind, data) => log.push([ kind, data ]),
        setTyping: (on) => log.push([ "typing", on ]),
        setPresence: () => {},
        setReceipts: (ids, text) => log.push([ "receipt", ids.join(","), text ]),
        showReaction: () => {},
        markFailed: (batch) => log.push([ "failed", batch.map((m) => m.id).join(",") ]),
        markSeen: () => {},
        notify: (text) => log.push([ "notify", text ]),
        isReducedMotion: () => false,
        renderStatus: () => {},
        showBubble: (text) => {
            log.push([ "bubble", text ]);
            return `b${shown++}`;
        },
        unsendBubble: (id) => log.push([ "unsend", id ]),
    };
    const engine = createEngine({
        api,
        ui,
        timers: clock.timers,
        settings: () => ({ clientId: "c1", idleMinutes: 0, rethinkOnInterrupt: false, showNotes: false, ...settings }),
    });
    const bubbles = () => log.filter(([ k ]) => k === "bubble").map(([ , text ]) => text);
    return { engine, clock, log, calls, bubbles };
}

test("a burst of messages is read and answered as one", async () => {
    const { engine, clock, calls } = setup();
    engine.add({ id: "a", text: "หวัดดี" });
    await clock.run(300);
    engine.add({ id: "b", text: "ทำไรอยู่" });
    await clock.run(20000);
    assert.deepEqual(calls.chat, [ [ "a", "b" ] ]);
});

test("an important message stops her after the bubble she's typing", async () => {
    const reply = { bubbles: [ "วันนี้ไปตลาดมา", "เจอขนมครกเจ้าเดิม", "อร่อยมาก" ] };
    const { engine, clock, calls, bubbles } = setup({ replies: [ reply, { bubbles: [ "ว่างดิ" ] } ] });
    engine.add({ id: "a", text: "ไปไหนมา" });
    // Read 1s + think 0.5s + brain 2s: her first bubble appears at 3.5s, and by 4.5s she's typing the second
    await clock.run(4500);
    assert.deepEqual(bubbles(), [ "วันนี้ไปตลาดมา" ]);

    engine.add({ id: "b", text: "เดี๋ยว พรุ่งนี้ว่างป่ะ" });
    await clock.run(30000);
    // She finishes the second bubble, then stops: the third is never sent
    assert.deepEqual(calls.cut, [ { n: 2, bubbles: reply.bubbles } ]);
    assert.deepEqual(bubbles(), [ "วันนี้ไปตลาดมา", "เจอขนมครกเจ้าเดิม", "ว่างดิ" ]);
    assert.deepEqual(calls.chat, [ [ "a" ], [ "b" ] ]);
});

test("a laugh doesn't stop her; she finishes, then answers it", async () => {
    const reply = { bubbles: [ "หนึ่ง", "สอง", "สาม" ] };
    const { engine, clock, calls, bubbles } = setup({ replies: [ reply ] });
    engine.add({ id: "a", text: "เล่ามา" });
    await clock.run(4500);
    engine.add({ id: "b", text: "555" });
    await clock.run(30000);
    assert.deepEqual(calls.cut, []);
    assert.deepEqual(bubbles().slice(0, 3), [ "หนึ่ง", "สอง", "สาม" ]);
    assert.deepEqual(calls.chat, [ [ "a" ], [ "b" ] ]);
});

test("a message sent while she types shows อ่านแล้ว only when she looks between bubbles", async () => {
    const { engine, clock, log } = setup({ replies: [ { bubbles: [ "หนึ่ง", "สอง" ] } ] });
    engine.add({ id: "a", text: "เล่ามา" });
    await clock.run(3600);
    engine.add({ id: "b", text: "อือ" });
    const readAt = () => log.findIndex(([ k, id, text ]) => k === "receipt" && id === "b" && text === "อ่านแล้ว");
    assert.equal(readAt(), -1);
    await clock.run(30000);
    const firstBubble = log.findIndex(([ k ]) => k === "bubble");
    assert.ok(readAt() > firstBubble);
});

test("a typo she takes back: shown, unsent, then the right one", async () => {
    const { engine, clock, log, bubbles } = setup({ replies: [ { bubbles: [ "ไปตลด", "ไปตลาด" ], unsend: [ 0 ] } ] });
    engine.add({ id: "a", text: "ไปไหน" });
    await clock.run(30000);
    assert.deepEqual(bubbles(), [ "ไปตลด", "ไปตลาด" ]);
    assert.ok(log.some(([ k, id ]) => k === "unsend" && id === "b0"));
    assert.equal(log.some(([ k, text ]) => k === "notify" && text === "ไปตลด"), false);
});

test("hesitating: the dots go away and come back before her first bubble", async () => {
    const { engine, clock, log } = setup({ replies: [ { bubbles: [ "อืม" ], hesitate: true } ] });
    engine.add({ id: "a", text: "คิดว่าไง" });
    await clock.run(30000);
    const typing = log.filter(([ k ]) => k === "typing" || k === "bubble").map(([ k, v ]) => (k === "bubble" ? "B" : v ? "on" : "off"));
    // on (waiting for the brain) → off (stops) → on (types again) → bubble
    assert.deepEqual(typing.slice(0, 4), [ "on", "off", "on", "off" ]);
    assert.equal(typing[4], "B");
});

test("phone down: she shows as offline until she reads", async () => {
    const { engine, clock } = setup({ plan: { ...PLAN, readMs: 60000, phoneAway: true, activity: "อาบน้ำอยู่" } });
    engine.add({ id: "a", text: "อยู่ไหม" });
    await clock.run(1000);
    assert.equal(engine.isOffline(), true);
    await clock.run(70000);
    assert.equal(engine.isOffline(), false);
});

test("a failed reply marks the message and doesn't leave her stuck", async () => {
    const { engine, clock, log, calls } = setup({ replies: [ new Error("สมองล่ม"), { bubbles: [ "มาแล้ว" ] } ] });
    engine.add({ id: "a", text: "หวัดดี" });
    await clock.run(10000);
    assert.ok(log.some(([ k, ids ]) => k === "failed" && ids === "a"));
    assert.equal(engine.isBusy(), false);
    engine.add({ id: "b", text: "ยังอยู่มั้ย" });
    await clock.run(10000);
    assert.deepEqual(calls.chat, [ [ "a" ], [ "b" ] ]);
});

test("a message sent while she nudges you gets answered after", async () => {
    const { engine, clock, calls } = setup({ settings: { idleMinutes: 1 } });
    engine.armIdle();
    await clock.run(60000 + 100);
    engine.add({ id: "a", text: "อยู่นี่" });
    await clock.run(30000);
    assert.equal(calls.nudge, 1);
    assert.deepEqual(calls.chat, [ [ "a" ] ]);
});

test("rethink (when turned on) drops a reply only once in a row", async () => {
    const { engine, clock, calls, bubbles } = setup({
        settings: { rethinkOnInterrupt: true },
        replies: [ { bubbles: [ "เก่า" ] }, { bubbles: [ "ใหม่" ] } ],
    });
    engine.add({ id: "a", text: "หวัดดี" });
    // During the brain wait, before any bubble shows
    await clock.run(2000);
    engine.add({ id: "b", text: "ขอถามหน่อยได้ไหม" });
    await clock.run(30000);
    assert.deepEqual(calls.cut, [ { n: 0, bubbles: [ "เก่า" ] } ]);
    assert.deepEqual(bubbles(), [ "ใหม่" ]);
});

test("afterthought: a few minutes after her reply she adds something, unless you wrote first", async () => {
    // Built by hand: the shared setup's api has no afterthought, so add one here
    const clock = fakeClock();
    const shown = [];
    let asked = 0;
    const make = () => createEngine({
        api: {
            pacing: async () => PLAN,
            read: async () => {},
            cut: async () => {},
            greet: async () => ({ bubbles: [] }),
            nudge: async () => ({ bubbles: [] }),
            chat: async () => ({ bubbles: [ "โอเค" ], afterthoughtInMs: 5 * 60000 }),
            afterthought: async () => {
                asked++;
                return { bubbles: [ "เห้ย ลืมบอก" ] };
            },
        },
        ui: {
            append: () => {}, setTyping: () => {}, setPresence: () => {}, setReceipts: () => {}, showReaction: () => {},
            markFailed: () => {}, markSeen: () => {}, notify: () => {}, isReducedMotion: () => false, renderStatus: () => {},
            showBubble: (text) => {
                shown.push(text);
                return `b${shown.length}`;
            },
            unsendBubble: () => {},
        },
        timers: clock.timers,
        settings: () => ({ clientId: "c1", idleMinutes: 0, rethinkOnInterrupt: false, showNotes: false }),
    });

    const quiet = make();
    quiet.add({ id: "a", text: "หวัดดี" });
    await clock.run(6 * 60000);
    assert.equal(asked, 1);
    assert.deepEqual(shown.slice(-1), [ "เห้ย ลืมบอก" ]);

    const busy = make();
    busy.add({ id: "b", text: "หวัดดี" });
    await clock.run(60000);
    busy.add({ id: "c", text: "ว่าไง" });
    await clock.run(60000);
    const before = asked;
    // The second reply plans its own afterthought; only that one may fire
    await clock.run(10 * 60000);
    assert.equal(asked - before, 1);
});
