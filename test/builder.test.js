// The new-character form (server/builder.js): what you fill in becomes files the app reads correctly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.PERSONA_DATA_DIR = await mkdtemp(path.join(os.tmpdir(), "persona-builder-"));
const profiles = await import("../server/profiles.js");
await profiles.initProfiles();
const builder = await import("../server/builder.js");
const { personaHabits, parseActivities } = await import("../server/pacing.js");

const FORM = {
    name: "ฟ้า", age: "25", gender: "หญิง", job: "บาริสต้า", livesIn: "ห้องเช่า", city: "เชียงใหม่",
    likes: "กาแฟ", dislikes: "ฝน", personality: "ขี้เล่น\n- ปากแข็ง", selfRef: "ฟ้า", callUser: "พี่",
    particles: "อ่ะ, นะ", samples: "โห้ยย ง่วง", relation: "friend", howMet: "ลูกค้าประจำ",
    memories: "ชอบอเมริกาโน่เย็น", people: "มิ้นท์ - เพื่อนร่วมงาน", wake: "7", sleep: "0", typing: "7",
};

test("cleanSpec: a name is required and characters are adults", () => {
    assert.throws(() => builder.cleanSpec({}), /ต้องมีชื่อ/);
    assert.throws(() => builder.cleanSpec({ name: "x", age: "17" }), /18 ปีขึ้นไป/);
    const spec = builder.cleanSpec({ ...FORM, name: "ฟ้า\n## แทรกหัวข้อ", wake: "99", relation: "???" });
    assert.equal(spec.name.includes("\n"), false);
    assert.equal(spec.wake, 23);
    assert.equal(spec.relation, "stranger");
    assert.deepEqual(spec.personality, [ "ขี้เล่น", "ปากแข็ง" ]);
});

test("renderAll: the files read back the way the rest of the app expects", async () => {
    const files = await builder.renderAll(builder.cleanSpec(FORM));
    assert.match(files.persona, /^- ชื่อ: ฟ้า$/m);
    assert.match(files.persona, /^- เมือง: เชียงใหม่$/m);
    assert.deepEqual(personaHabits(files.persona), { wakeHour: 7, sleepHour: 0, typingCps: 7 });
    assert.equal(parseActivities(files.persona).length, 3);
    assert.match(files.memory, /## เกี่ยวกับผู้ใช้\n- \[\d{4}-\d{2}-\d{2}\] ชอบอเมริกาโน่เย็น/);
    assert.match(files.people, /## มิ้นท์\n- เป็น: เพื่อนร่วมงาน/);
    assert.match(files.state, /- ความสนิท: 30/);
    assert.equal(files.style.includes("มะลิ"), false);
    assert.match(files.style, /## ตัวอย่างจากแชทจริง\n(?:>.*\n)*- โห้ยย ง่วง/);
});

test("cleanExtra: only activities pacing.js can read are kept", () => {
    const extra = builder.cleanExtra({
        activities: [ "ทำคอนเทนต์อยู่ | 13-17 | 15% | 5-20 | อ่านแต่ยังไม่ตอบ", "เขียนมั่ว ๆ ไม่มีรูปแบบ" ],
        examples: [ { situation: "ทักทาย", bad: "สวัสดีค่ะ", good: [ "ว่าไง" ] }, { situation: "ว่าง" } ],
        opinions: [ { about: "ทุเรียน", opinion: "ไม่ชอบ" } ],
    });
    assert.deepEqual(extra.activities, [ "- ทำคอนเทนต์อยู่ | 13-17 | 15% | 5-20 | อ่านแต่ยังไม่ตอบ" ]);
    assert.equal(extra.examples.length, 1);
});

test("buildCharacter: makes the character, with the brain's details or without them", async () => {
    const ask = async () => JSON.stringify({ personality: [ "ชอบร้องเพลงตอนชงกาแฟ" ], opinions: [ { about: "ฝน", opinion: "เกลียด" } ], activities: [ "วาดรูปอยู่ | 20-23 | 20% | 10-30 | อ่านแต่ยังไม่ตอบ" ] });
    const made = await builder.buildCharacter({ ...FORM, useAI: true }, ask);
    assert.equal(made.filled, true);
    const dir = path.join(profiles.PERSONAS_DIR, made.id);
    const persona = await readFile(path.join(dir, "persona.md"), "utf8");
    assert.match(persona, /ชอบร้องเพลงตอนชงกาแฟ/);
    assert.match(persona, /- วาดรูปอยู่ \| 20-23/);
    assert.match(await readFile(path.join(dir, "opinions.md"), "utf8"), /## ฝน\n- \[.*\] เกลียด/);

    const plain = await builder.buildCharacter({ ...FORM, name: "ดาว", useAI: true }, async () => {
        throw new Error("ไม่ได้ล็อกอิน");
    });
    assert.equal(plain.filled, false);
    assert.match(await readFile(path.join(profiles.PERSONAS_DIR, plain.id, "persona.md"), "utf8"), /^- ชื่อ: ดาว$/m);
});
