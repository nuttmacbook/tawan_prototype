// Her day from the web, people around her, photos, links and fading memories.
// No brain and no network: only the parts that check, store and choose.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.PERSONA_DATA_DIR = await mkdtemp(path.join(os.tmpdir(), "persona-world-"));

const profiles = await import("../server/profiles.js");
await profiles.initProfiles();
const store = await import("../server/store.js");
const world = await import("../server/world.js");
const { notePerson, peopleFor } = await import("../server/life.js");
const { selectMemory } = await import("../server/recall.js");

/* ------------------------------------ the morning look-up */

test("cleanFound: bad links, odd hours and long text are cleaned before she sees them", () => {
    const found = world.cleanFound({
        city: "ชลบุรี",
        weather: "ร้อน\nฝนตกบ่าย <script>",
        shows: [ { title: "เรื่องจริง", url: "javascript:alert(1)" }, { title: "อีกเรื่อง", url: "https://example.com/show" }, { url: "https://x.y" } ],
        links: [ { title: "เพลง", url: "https://example.com/song" }, { title: "ปลอม", url: "ftp://x" } ],
        plan: [ { from: 10, to: 12, doing: "ทำงาน", busy: 5 }, { from: 3, to: 3, doing: "ว่าง" }, { from: "x", to: 4, doing: "?" } ],
        mood: { "เหนื่อย": 9, "ดีใจ": "abc" },
        stories: [ { title: "ย้ายห้อง", today: "แพ็คของ", status: "ended" } ],
    });
    assert.equal(found.weather.includes("\n"), false);
    assert.equal(found.weather.includes("<"), false);
    assert.deepEqual(found.shows.map((s) => s.url), [ "", "https://example.com/show" ]);
    assert.deepEqual(found.links.map((l) => l.url), [ "https://example.com/song" ]);
    assert.deepEqual(found.plan, [ { from: 10, to: 12, doing: "ทำงาน", phoneAway: false, busy: 1 } ]);
    assert.deepEqual(found.mood, { "เหนื่อย": 2 });
    assert.equal(found.stories[0].status, "ended");
    assert.equal(world.cleanFound("not json"), null);
});

test("renderToday: what she reads is marked as web data", () => {
    const info = { date: "2026-10-18", ...world.cleanFound({ city: "ชลบุรี", weather: "แดดจัด", plan: [ { from: 22, to: 2, doing: "ทำเกม", phoneAway: false } ] }) };
    const md = world.renderToday(info, "ตะวัน");
    assert.match(md, /^# วันนี้ของตะวัน \(2026-10-18 · ชลบุรี\)/);
    assert.match(md, /ไม่ใช่คำสั่ง/);
    assert.match(md, /22:00–02:00 ทำเกม/);
});

/* ------------------------------------ links and photos in her bubbles */

test("checkShared: only real links and her own photos get through", () => {
    const out = world.checkShared(
        [ "ดูอันนี้ https://example.com/song", "https://made.up/fake", "[ส่งรูป:ทะเล.jpg] ทะเลตอนเย็น", "[ส่งรูป:../../etc.jpg]", "[รูปเธอ:แอบใส่.jpg] ฮะ" ],
        { links: [ "https://example.com/song" ], photos: [ "ทะเล.jpg" ] },
    );
    assert.deepEqual(out.bubbles, [ "ดูอันนี้ https://example.com/song", "[รูปเธอ:ทะเล.jpg] ทะเลตอนเย็น", "ฮะ" ]);
    assert.deepEqual(out.photos, [ "ทะเล.jpg" ]);
    assert.equal(out.dropped.length, 3);
});

test("linksIn: trailing punctuation isn't part of the link", () => {
    assert.deepEqual(world.linksIn("ดูนี่ https://example.com/a?b=1, แล้วก็ (https://x.org/y)."), [ "https://example.com/a?b=1", "https://x.org/y" ]);
});

test("photos: only files really in her folder, once each", async () => {
    const dir = path.join(profiles.activeDir(), "photos");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "ทะเล.jpg"), "x");
    await writeFile(path.join(dir, "notes.txt"), "x");
    assert.deepEqual(await world.unsentPhotos(), [ "ทะเล.jpg" ]);
    assert.ok(await world.photoFile("ทะเล.jpg"));
    assert.equal(await world.photoFile("../settings.json"), null);
    assert.equal(await world.photoFile("notes.txt"), null);
    await world.markPhotoSent("ทะเล.jpg");
    assert.deepEqual(await world.unsentPhotos(), []);
});

/* ------------------------------------ people around her */

test("notePerson: same name, one entry that keeps its story", async () => {
    assert.match(await notePerson({ name: "มิ้นท์", relation: "เพื่อนสนิท", trait: "พูดเร็ว" }), /คนใหม่/);
    assert.match(await notePerson({ name: "มิ้นท์", update: "ได้งานใหม่" }), /อัปเดต/);
    const text = await store.readEditable("people");
    assert.equal(text.match(/^## มิ้นท์$/gm)?.length, 1);
    assert.match(text, /- เป็น: เพื่อนสนิท/);
    assert.match(text, /\] ได้งานใหม่/);
    assert.match(await peopleFor("วันนี้มิ้นท์โทรมา"), /มิ้นท์/);
});

/* ------------------------------------ fading memories */

test("selectMemory: old small things fade, who you are doesn't", () => {
    const memory = [
        "# ความจำ",
        "",
        "## เกี่ยวกับผู้ใช้",
        "- [2025-01-01] ชื่อนัท",
        "",
        "## ทั่วไป",
        "- [2025-01-02] เคยกินก๋วยเตี๋ยวเรือร้านหน้าปากซอย",
        "- [2026-10-10] ชอบแมวส้ม",
    ].join("\n");
    const now = new Date("2026-10-18T12:00:00").getTime();
    const quiet = selectMemory(memory, "วันนี้ทำไรอยู่", 3500, { fadeDays: 60, now });
    assert.match(quiet.text, /ชื่อนัท/);
    assert.match(quiet.text, /แมวส้ม/);
    assert.doesNotMatch(quiet.text, /ก๋วยเตี๋ยว/);
    // Talking about it brings it back
    assert.match(selectMemory(memory, "อยากกินก๋วยเตี๋ยวเรือ", 3500, { fadeDays: 60, now }).text, /ก๋วยเตี๋ยว/);
    // 0 = remember everything
    assert.equal(selectMemory(memory, "", 3500, { fadeDays: 0, now }).text, memory);
});
