// Runs without npm packages or Claude: only the parts that don't need a brain.
// The data folder is a fresh temp copy, so your real characters are never touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.PERSONA_DATA_DIR = await mkdtemp(path.join(os.tmpdir(), "persona-test-"));

const fsutil = await import("../server/fsutil.js");
const gate = await import("../server/gate.js");
const profiles = await import("../server/profiles.js");
await profiles.initProfiles();
const store = await import("../server/store.js");
const mood = await import("../server/mood.js");
const { humanize } = await import("../server/humanize.js");
const { parseActivities, isAsleepAt } = await import("../server/pacing.js");

/* ------------------------------------ files */

test("updateText: 50 changes at once all land", async () => {
    const file = path.join(process.env.PERSONA_DATA_DIR, "count.txt");
    await Promise.all(Array.from({ length: 50 }, () => fsutil.updateText(file, (t) => String(Number(t || 0) + 1))));
    assert.equal(await readFile(file, "utf8"), "50");
});

test("pending: a message sent while an older one is removed is kept", async () => {
    await store.addPending({ id: "a1", text: "หนึ่ง" });
    await Promise.all([ store.removePending([ "a1" ]), store.addPending({ id: "a2", text: "สอง" }) ]);
    assert.deepEqual((await store.loadPending()).map((m) => m.id), [ "a2" ]);
    await store.removePending([ "a2" ]);
});

test("pending: sending the same id twice keeps one copy", async () => {
    await Promise.all([ store.addPending({ id: "b1", text: "x" }), store.addPending({ id: "b1", text: "x" }) ]);
    assert.equal((await store.loadPending()).filter((m) => m.id === "b1").length, 1);
    await store.removePending([ "b1" ]);
});

test("settings: a damaged settings.json falls back to the last good copy", async () => {
    await profiles.saveSettings({ lanKey: "first" });
    await profiles.saveSettings({ lanKey: "second" });
    await writeFile(path.join(process.env.PERSONA_DATA_DIR, "settings.json"), "{ broken");
    assert.equal((await profiles.loadSettings()).lanKey, "first");
});

test("pinProfile: work keeps its character after a switch", async () => {
    const first = profiles.getActiveId();
    const other = await profiles.createProfile({ name: "อีกตัว" });
    await profiles.pinProfile(async () => {
        await profiles.switchProfile(other);
        assert.equal(profiles.currentId(), first);
        assert.ok(profiles.fileOf("memory").includes(first));
    });
    assert.equal(profiles.currentId(), other);
    await profiles.switchProfile(first);
});

test("snapshots: restoring the oldest one still works", async () => {
    for (let i = 0; i < 31; i++) await profiles.snapshot(`s${i}`);
    const list = await profiles.listSnapshots();
    const oldest = list.at(-1).id;
    await profiles.restoreSnapshot(oldest);
    assert.ok((await profiles.listSnapshots()).some((s) => s.id === oldest));
});

test("bubblesForLog: a ' / ' inside a bubble doesn't split it on reload", () => {
    assert.equal(store.bubblesForLog([ "a / b", "c" ]), "a ／ b\nc");
});

/* ------------------------------------ mood */

test("mood: an update first lets the hours since the last one calm her down", async () => {
    const state = await mood.loadState();
    state.moods = [ { name: "งอน", value: 8, base: 0 }, { name: "ดีใจ", value: 5, base: 5 } ];
    state.moodUpdated = Date.now() - 10 * 3600000;
    await mood.saveState(state);
    await mood.adjustMood({ "ดีใจ": 1 });
    const after = await mood.loadState();
    assert.equal(after.moods.find((m) => m.name === "งอน").value, 0);
    assert.equal(after.moods.find((m) => m.name === "ดีใจ").value, 6);
});

test("mood: a burst of messages adds closeness for at most three", async () => {
    const before = (await mood.loadState()).closeness;
    await mood.markUserMessage(Date.now(), 10);
    assert.equal(Math.round(((await mood.loadState()).closeness - before) * 10) / 10, 0.9);
});

/* ------------------------------------ requests */

const req = (headers, remote = "127.0.0.1") => ({ headers, socket: { remoteAddress: remote } });

test("isOwnPage: only JSON from the app's own page", () => {
    const host = "127.0.0.1:3939";
    assert.equal(gate.isOwnPage(req({ host, "content-type": "application/json", origin: "http://127.0.0.1:3939" })), true);
    assert.equal(gate.isOwnPage(req({ host, "content-type": "application/json" })), true);
    assert.equal(gate.isOwnPage(req({ host, "content-type": "text/plain" })), false);
    assert.equal(gate.isOwnPage(req({ host, "content-type": "application/json", origin: "https://evil.example" })), false);
    assert.equal(gate.isOwnPage(req({ host, "content-type": "application/json", origin: "null" })), false);
    assert.equal(gate.isOwnPage(req({ host, "content-type": "application/json", "sec-fetch-site": "cross-site" })), false);
});

test("host check: other names pointed at this computer are refused", () => {
    const check = gate.makeHostCheck({ isLan: true, isQuickTunnel: true, lanNames: () => [ "192.168.1.5" ] });
    assert.equal(check(req({ host: "localhost:3939" })), true);
    assert.equal(check(req({ host: "[::1]:3939" })), true);
    assert.equal(check(req({ host: "192.168.1.5:3939" })), true);
    assert.equal(check(req({ host: "abc.trycloudflare.com" })), true);
    assert.equal(check(req({ host: "evil.example:3939" })), false);
    assert.equal(gate.makeHostCheck({})(req({ host: "abc.trycloudflare.com" })), false);
});

test("clientIp: forwarding headers count only through the local tunnel", () => {
    assert.equal(gate.clientIp(req({ "x-forwarded-for": "1.2.3.4" }, "192.168.1.9")), "192.168.1.9");
    assert.equal(gate.clientIp(req({ "cf-connecting-ip": "5.6.7.8" }, "127.0.0.1")), "5.6.7.8");
});

/* ------------------------------------ chat text */

test("humanize: ไหม becomes มั้ย, but ผ้าไหม stays silk", () => {
    const style = "- พิมพ์ผิดแล้วแก้: ไม่\n- ตัดเครื่องหมายคำถามท้าย: ไม่";
    assert.deepEqual(humanize([ "ไปกินข้าวไหม" ], style), [ "ไปกินข้าวมั้ย" ]);
    assert.deepEqual(humanize([ "ชอบผ้าไหม" ], style), [ "ชอบผ้าไหม" ]);
});

test("activities: a range across midnight works", () => {
    const [ a ] = parseActivities("## กิจกรรมระหว่างวัน\n- เล่นเกม | 22-2 | 10% | 5-10 | อ่านแต่ยังไม่ตอบ\n");
    assert.deepEqual(a.hours, [ [ 22, 24 ], [ 0, 2 ] ]);
});

test("sleep: the same hour for bed and waking means no sleep, not all-day sleep", () => {
    assert.equal(isAsleepAt(15, { sleepHour: 8, wakeHour: 8 }), false);
    assert.equal(isAsleepAt(3, { sleepHour: 2, wakeHour: 10 }), true);
});

/* ------------------------------------ history */

test("unsend: finds a message logged yesterday (answered after midnight)", async () => {
    const yesterday = new Date(Date.now() - 86400000).toLocaleDateString("sv-SE");
    await mkdir(store.historyDir(), { recursive: true });
    await writeFile(path.join(store.historyDir(), `${yesterday}.md`), "# x\n\n[23:59] **ผู้ใช้**: ฝันดี\n");
    assert.equal(await store.unsendFromHistory("ฝันดี", "23:59"), true);
});

/* ------------------------------------ reactions */

test("reactions: saved in the day's log and read back on the right bubble", async () => {
    const day = new Date().toLocaleDateString("sv-SE");
    await writeFile(path.join(store.historyDir(), `${day}.md`), "# x\n\n[10:00] **ผู้ใช้**: ไปไหนมา\n\n[10:01] *ตะวัน*: ตลาดมา / ซื้อขนมด้วย\n\n");
    // The page showed her bubble a minute after the logged time
    assert.equal(await store.logReaction({ by: "user", name: "ผู้ใช้", emoji: "😂", targetTime: "10:02", targetText: "ซื้อขนมด้วย" }), true);
    assert.equal(await store.logReaction({ by: "user", name: "ผู้ใช้", emoji: "❤️", targetTime: "10:02", targetText: "ซื้อขนมด้วย" }), true);
    assert.equal(await store.logReaction({ by: "agent", name: "ตะวัน", emoji: "👍", targetTime: "10:00", targetText: "ไปไหนมา" }), true);
    assert.equal(await store.logReaction({ by: "user", name: "ผู้ใช้", emoji: "😮", targetTime: "10:01", targetText: "ไม่มีข้อความนี้" }), false);

    const entries = await store.todayEntries();
    assert.deepEqual(entries.map((e) => e.reactions), [ [ "👍" ], [ "", "❤️" ] ]);
    assert.equal(entries.length, 2);
});

/* ------------------------------------ stopping mid-reply */

test("interrupt: questions and real news stop her, a laugh doesn't", async () => {
    const { shouldInterrupt } = await import("../src/interrupt.js");
    for (const t of [ "555", "5555+", "อือ", "โอเค", "😂", "จริงดิ", "ใช่" ]) assert.equal(shouldInterrupt(t), false, t);
    for (const t of [ "พรุ่งนี้ว่างป่ะ", "กินไรยัง?", "เดี๋ยวนะ", "วันนี้เหนื่อยมาก", "[รูป:abc.jpg]", "[ตอบกลับ \"x\"] อันนี้", "เมื่อกี้เจอแฟนเก่าที่ห้างอ่ะ" ]) {
        assert.equal(shouldInterrupt(t), true, t);
    }
});

test("replaceLoggedLine: a cut reply keeps only what was shown", async () => {
    const logged = await store.logTurn("agent", "ตะวัน", store.bubblesForLog([ "หนึ่ง", "สอง", "สาม" ]));
    assert.equal(await store.replaceLoggedLine(logged, logged.line.replace(" / สอง / สาม", "")), true);
    const last = (await store.todayEntries()).at(-1);
    assert.equal(last.text, "หนึ่ง");
    const gone = await store.logTurn("agent", "ตะวัน", "ทั้งหมด");
    await store.replaceLoggedLine(gone, null);
    assert.notEqual((await store.todayEntries()).at(-1).text, "ทั้งหมด");
});

/* ------------------------------------ settings page */

test("config: saved values win over defaults, and are kept in range", async () => {
    const config = await import("../server/config.js");
    const saved = await config.setConfig({ idleMinutes: 999, awayPingHours: "0", pushPreview: false, unknown: 5 });
    assert.equal(saved.idleMinutes, 240);
    assert.equal(saved.awayPingHours, 0);
    assert.equal(saved.pushPreview, false);
    assert.equal("unknown" in saved, false);
    assert.equal((await config.getConfig()).memoryBudget, 3500);
});

/* ------------------------------------ memory without duplicates */

test("remember: the same fact again updates it instead of adding a copy", async () => {
    const memoryFile = profiles.fileOf("memory");
    await writeFile(memoryFile, "# ความจำ\n\n## ความชอบ\n- [2026-01-01] ชอบกินชาบู\n- [2026-01-01] ชอบชาเขียว\n");
    assert.match(await store.remember("ความชอบ", "ชอบกินชาบู"), /อัปเดต/);
    assert.match(await store.remember("ความชอบ", "ชอบกินชาบูร้านใกล้บ้าน"), /อัปเดต/);
    assert.match(await store.remember("ความชอบ", "ชาบู"), /รู้อยู่แล้ว/);
    assert.match(await store.remember("ความชอบ", "ชอบกินส้มตำ"), /จำแล้ว/);
    const facts = (await readFile(memoryFile, "utf8")).split("\n").filter((l) => l.startsWith("- "));
    assert.deepEqual(facts.map((l) => l.replace(/^- \[[\d-]+\] /, "")), [ "ชอบชาเขียว", "ชอบกินชาบูร้านใกล้บ้าน", "ชอบกินส้มตำ" ]);
});

test("remember: a fact moved to a new topic leaves no empty heading behind", async () => {
    const memoryFile = profiles.fileOf("memory");
    await writeFile(memoryFile, "# ความจำ\n\n## ทั่วไป\n- [2026-01-01] ทำงานที่ขอนแก่น\n");
    await store.remember("งาน", "ทำงานที่ขอนแก่น");
    const text = await readFile(memoryFile, "utf8");
    assert.equal(text.includes("## ทั่วไป"), false);
    assert.match(text, /## งาน\n- \[[\d-]+\] ทำงานที่ขอนแก่น/);
});

test("remember: saying the opposite replaces the old fact", async () => {
    const memoryFile = profiles.fileOf("memory");
    await writeFile(memoryFile, "# ความจำ\n\n## เกี่ยวกับผู้ใช้\n- [2026-01-01] ไม่มีแมว\n");
    assert.match(await store.remember("เกี่ยวกับผู้ใช้", "มีแมว"), /อัปเดต/);
    const facts = (await readFile(memoryFile, "utf8")).split("\n").filter((l) => l.startsWith("- "));
    assert.equal(facts.length, 1);
    assert.match(facts[0], /\] มีแมว$/);
});
