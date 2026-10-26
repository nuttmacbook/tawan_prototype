// Several people on one server: accounts, each user's own chat with a character,
// characters made before accounts moving to the first account, friends and their chats.
import "./quiet.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.PERSONA_DATA_DIR = await mkdtemp(path.join(os.tmpdir(), "persona-accounts-"));

// A character from before accounts: everything in her own folder, how she knows "you" in persona.md
const legacy = path.join(process.env.PERSONA_DATA_DIR, "personas", "old");
await mkdir(path.join(legacy, "history"), { recursive: true });
await writeFile(path.join(legacy, "persona.md"), "# บุคลิกหลัก\n\n## ตัวตน\n- ชื่อ: ฝน\n\n## ความสัมพันธ์กับผู้ใช้\n- ตอนนี้เป็น: เพื่อน\n- แชทนี้: คุยกันมานานแล้ว\n\n## นิสัย\n- ขี้เล่น\n");
await writeFile(path.join(legacy, "memory.md"), "# ความจำ\n\n## เกี่ยวกับผู้ใช้\n- [2026-10-01] ชอบกาแฟดำ\n");
await writeFile(path.join(legacy, "history", "2026-10-01.md"), "# บทสนทนา\n\n[10:00] *ผู้ใช้*: หวัดดี\n");

const profiles = await import("../server/profiles.js");
await profiles.initProfiles();
const users = await import("../server/users.js");
const dm = await import("../server/dm.js");
const store = await import("../server/store.js");
const { factsOf, othersNote } = await import("../server/circle.js");

const admin = await users.register({ name: "นัท", handle: "Nutt", password: "secret1" });
const invite = await users.inviteCode();
const bee = await users.register({ name: "บี", handle: "bee", password: "secret2", invite });

test("accounts: the first is the admin, the rest need the invite code, handles are unique", async () => {
    assert.equal(admin.role, "admin");
    assert.equal(admin.handle, "nutt");
    assert.equal(bee.role, "user");
    await assert.rejects(users.register({ name: "ซี", handle: "cee", password: "secret3", invite: "wrong" }), /รหัสเชิญ/);
    await assert.rejects(users.register({ name: "ซ้ำ", handle: "NUTT", password: "secret3", invite }), /มีคนใช้แล้ว/);
    assert.equal((await users.login("nutt", "secret1"))?.id, admin.id);
    assert.equal(await users.login("nutt", "wrong!!"), null);
    assert.equal(await users.login("nobody", "secret1"), null);
});

test("sign-in cookie: accepted as is, refused when changed, and a password change signs others out", async () => {
    const cookie = (await users.sessionCookie(bee)).split(";")[0];
    const req = (c) => ({ headers: { cookie: c } });
    assert.equal((await users.userOf(req(cookie)))?.id, bee.id);
    assert.equal(await users.userOf(req(cookie.replace(/.$/, (c) => (c === "A" ? "B" : "A")))), null);
    assert.equal(await users.userOf(req(cookie.replace(bee.id, admin.id))), null);
    await users.changePassword(bee.id, "secret2", "secret22");
    assert.equal(await users.userOf(req(cookie)), null);
});

test("adoptLegacy: the old character becomes the admin's, with her chat and how she knew them", async () => {
    const moved = await profiles.adoptLegacy(admin.id);
    assert.deepEqual(moved, [ "old" ]);
    assert.equal((await profiles.botMeta("old")).owner, admin.id);
    const chat = profiles.chatDirOf("old", admin.id);
    assert.match(await readFile(path.join(chat, "memory.md"), "utf8"), /กาแฟดำ/);
    assert.ok((await readdir(path.join(chat, "history"))).includes("2026-10-01.md"));
    assert.match(await readFile(path.join(chat, "relation.md"), "utf8"), /คุยกันมานานแล้ว/);
    const persona = await readFile(path.join(legacy, "persona.md"), "utf8");
    assert.doesNotMatch(persona, /ความสัมพันธ์กับผู้ใช้/);
    assert.match(persona, /## นิสัย/);
    // Runs once
    assert.deepEqual(await profiles.adoptLegacy(admin.id), []);
});

test("each user has their own chat with her; her own files are shared", async () => {
    await profiles.ensureChat("old", bee.id);
    const beeMemory = await profiles.pinProfile(() => store.readMemoryFile(), "old", bee.id);
    assert.doesNotMatch(beeMemory, /กาแฟดำ/);
    await profiles.pinProfile(() => store.remember("เกี่ยวกับผู้ใช้", "บีเลี้ยงหมาชื่อถั่ว"), "old", bee.id);
    assert.doesNotMatch(await profiles.pinProfile(() => store.readMemoryFile(), "old", admin.id), /ถั่ว/);
    const [ a, b ] = await Promise.all([ admin.id, bee.id ].map((u) => profiles.pinProfile(() => profiles.fileOf("persona"), "old", u)));
    assert.equal(a, b);
    assert.notEqual(
        await profiles.pinProfile(() => profiles.fileOf("memory"), "old", admin.id),
        await profiles.pinProfile(() => profiles.fileOf("memory"), "old", bee.id),
    );
    assert.match(await readFile(path.join(profiles.chatDirOf("old", bee.id), "relation.md"), "utf8"), /ค้นเจอคุณในแอป/);
    assert.equal(await profiles.pinProfile(() => profiles.isOwnerNow(), "old", bee.id), false);
    assert.equal(await profiles.pinProfile(() => profiles.isOwnerNow(), "old", admin.id), true);
});

test("she knows the other people who chat with her", async () => {
    const note = await profiles.pinProfile(() => othersNote(), "old", bee.id);
    assert.match(note, /นัท \(@nutt\)/);
    assert.match(note, /กาแฟดำ/);
    // Not herself telling you about you
    assert.doesNotMatch(note, /@bee/);
    assert.deepEqual(factsOf("## เกี่ยวกับผู้ใช้\n- [2026-01-01] ก\n## อื่น ๆ\n- ข"), [ "ก", "ข" ]);
});

test("friends: a request, then accepted; both ways asking makes friends at once", async () => {
    const cee = await users.register({ name: "ซี", handle: "cee", password: "secret3", invite });
    assert.equal(await users.requestFriend(bee.id, admin.id), "requested");
    assert.ok((await users.getUser(admin.id)).incoming.includes(bee.id));
    await users.answerFriend(admin.id, bee.id, true);
    assert.ok(await users.areFriends(admin.id, bee.id));
    assert.ok(await users.areFriends(bee.id, admin.id));
    assert.equal(await users.requestFriend(cee.id, bee.id), "requested");
    assert.equal(await users.requestFriend(bee.id, cee.id), "friends");
    assert.equal((await users.searchUsers("nu"))[0]?.id, admin.id);
});

test("chats between people: same pair either way, unread counts, text only", async () => {
    assert.equal(dm.pairOf(admin.id, bee.id), dm.pairOf(bee.id, admin.id));
    assert.throws(() => dm.pairOf(admin.id, "../x"), /ไม่ถูกต้อง/);
    const sent = await dm.sendDm(bee.id, admin.id, "  หวัดดี  ");
    assert.equal(sent.text, "หวัดดี");
    await dm.sendDm(admin.id, bee.id, "ว่าไง");
    assert.equal(await dm.unreadCount(admin.id, bee.id, 0), 1);
    assert.equal(await dm.unreadCount(admin.id, bee.id, sent.at), 0);
    assert.deepEqual((await dm.readDm(admin.id, bee.id)).map((m) => m.text), [ "หวัดดี", "ว่าไง" ]);
    await assert.rejects(dm.sendDm(admin.id, bee.id, "   "), /ยังไม่ได้พิมพ์/);
});

test("splitRelation: only the relationship section moves", () => {
    const { persona, relation } = profiles.splitRelation("## ตัวตน\n- ชื่อ: ก\n\n## ความสัมพันธ์กับผู้ใช้\n- แชทนี้: x\n\n## นิสัย\n- y\n");
    assert.match(persona, /## ตัวตน[\s\S]*## นิสัย/);
    assert.doesNotMatch(persona, /แชทนี้/);
    assert.match(relation, /^## ความสัมพันธ์กับผู้ใช้คนนี้\n- แชทนี้: x\n$/);
    assert.deepEqual(profiles.splitRelation("## ตัวตน\n"), { persona: "## ตัวตน\n", relation: "" });
});

test("a damaged accounts file never reads as 'no accounts yet'", async () => {
    const file = path.join(process.env.PERSONA_DATA_DIR, "users.json");
    const good = await readFile(file, "utf8");
    await writeFile(file, "{ broken");
    // The last good copy is used, so nobody becomes admin and nobody is wiped
    assert.ok(await users.hasUsers());
    assert.equal((await users.findByHandle("nutt"))?.role, "admin");
    await writeFile(file, good);
});

