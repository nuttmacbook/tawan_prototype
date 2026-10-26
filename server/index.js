import http from "node:http";
import { readFile, stat, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Load .env before anything reads process.env; a missing file is fine in Claude Code mode
try {
    process.loadEnvFile();
} catch {}

// A bug in one request must never take the whole app down; log it and keep serving
process.on("unhandledRejection", (err) => console.error("unhandled:", err?.stack ?? err));

const {
    chat, greet, nudge, resetSession, personaName, brainMode, consolidateHistory, compactMemory, hasApiKey, presence,
    addReaction, awayPing, switchExclusive, forgetSession, noteUnsent, promptStats, cutLastReply, complete, afterthought, cancelAfterthought, onProfileSwitch,
} = await import("./brain.js");
const users = await import("./users.js");
const dm = await import("./dm.js");
const profiles = await import("./profiles.js");
const away = await import("./away.js");
const portable = await import("./portable.js");
const push = await import("./push.js");
const { handleAppIcon } = await import("./appicon.js");
const { planReply, clearActivity } = await import("./pacing.js");
const logic = await import("./logic.js");
const store = await import("./store.js");
const { loadState, describeMood, stageOf, agoText } = await import("./mood.js");
const { loadThreads } = await import("./life.js");
const { styleSettings } = await import("./humanize.js");
const config = await import("./config.js");
const world = await import("./world.js");
const coach = await import("./coach.js");
const live = await import("./live.js");
const builder = await import("./builder.js");
const { claudeCodeStatus, API_MODEL, CC_MODEL } = await import("./llm.js");
const { isLocal, clientIp, isHttps, lanAddresses, makeHostCheck, isOwnPage } = await import("./gate.js");

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const DIST = path.join(ROOT, "dist");
const PORT = Number(process.env.PORT ?? 3939) || 3939;
const isProd = process.argv.includes("--prod");
const isLan = /^(1|true|yes)$/i.test(String(process.env.ALLOW_LAN ?? ""));

// Characters must exist before any route reads their files
await profiles.initProfiles();

// A character with no owner (made before accounts, or at startup) belongs to the admin
{
    const admin = (await users.listUsers()).find((u) => u.role === "admin");
    if (admin) {
        for (const id of await profiles.adoptLegacy(admin.id)) await users.addChat(admin.id, id);
    }
}

/* ------------------------------------ helpers */

const send = (res, status, body) => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
};

/**
 * Collects the raw bytes first and decodes once at the end: decoding chunk by chunk
 * breaks Thai characters that happen to fall across two chunks into "�".
 */
async function readBody(req, limit = 2_000_000) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > limit) throw new Error("ข้อมูลใหญ่เกินไป");
        chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    try {
        return raw ? JSON.parse(raw) : {};
    } catch {
        return {};
    }
}

let ccCache = null;

/** `claude auth status` takes a moment, so cache it briefly */
async function ccStatus(force = false) {
    if (!force && ccCache && Date.now() - ccCache.at < 60000) return ccCache.value;
    const value = await claudeCodeStatus();
    ccCache = { at: Date.now(), value };
    return value;
}

async function statusPayload() {
    const [ state, threads, isOwner ] = await Promise.all([ loadState(), loadThreads(), profiles.isOwnerNow() ]);
    const stage = stageOf(state.closeness);
    return {
        moods: state.moods.map((m) => ({ name: m.name, value: Math.round(m.value * 10) / 10, base: m.base })),
        moodText: describeMood(state),
        closeness: Math.round(state.closeness * 10) / 10,
        stage: stage.label,
        messages: state.messages,
        lastSeen: state.lastSeen == null ? "-" : agoText(Date.now() - state.lastSeen),
        threads,
        // How the prompt was built is the owner's debug view, not something every chatter sees
        prompt: isOwner ? promptStats() : null,
    };
}

async function brainPayload(force = false) {
    return {
        mode: await brainMode(),
        claudeCode: { ...(await ccStatus(force)), model: CC_MODEL },
        api: { ready: hasApiKey(), model: API_MODEL },
    };
}

const EMPTY_REPLY = { bubbles: [], notes: [] };

/** Several replies as one, for a request that waited on an answer already being written */
const mergeReplies = (list) => {
    const done = list.filter(Boolean);
    // A bubble she takes back is counted from the start of the merged list, not of its own reply
    const unsend = [];
    let offset = 0;
    for (const r of done) {
        for (const i of r?.unsend ?? []) unsend.push(i + offset);
        offset += r?.bubbles?.length ?? 0;
    }
    return {
        ...(done.at(-1) ?? EMPTY_REPLY),
        bubbles: done.flatMap((r) => r?.bubbles ?? []),
        notes: done.flatMap((r) => r?.notes ?? []),
        unsend,
        hesitate: done.some((r) => r?.hesitate),
        // Which live updates this reply already contains, so the page doesn't show them twice
        seqs: done.flatMap((r) => r?.seqs ?? []),
    };
};

/** A hidden tab can still ask her to speak (nudge, afterthought); you hear it on your phone */
const pushIfAway = (result) => {
    if (result?.bubbles?.length && !isWatching()) pushMessage(visibleBubbles(result));
    return result;
};

/** Tells open pages (live.js) about something she said, and marks the reply with its number */
const announce = (result, extra = {}) => {
    // A reply with nothing said still tells the page "read, no reply" for those messages
    if (!result?.bubbles?.length && !result?.reaction && !extra.replyTo?.length) return result;
    const seq = live.publish({ ...extra, bubbles: result.bubbles, unsend: result.unsend, reaction: result.reaction });
    return { ...result, seqs: [ ...(result.seqs ?? []), seq ], liveBoot: live.BOOT };
};

/** The bubbles that stay on screen: a typo she takes back isn't something to put on a lock screen */
const visibleBubbles = (result) => (result?.bubbles ?? []).filter((_, i) => !(result?.unsend ?? []).includes(i));

/**
 * Answers the given pending messages and only then removes them from the queue,
 * so a failed reply leaves them waiting to be retried.
 * A message already being answered (by the closed-chat scheduler, or a retry) is never answered twice:
 * this call waits for that answer and returns it instead.
 */
async function replyToPending(ids, context = {}) {
    const wanted = [ ...new Set((Array.isArray(ids) ? ids : []).map(String)) ];

    // Everything up to inFlight.set runs with no await in between, so two calls arriving
    // together can't both take the same message: the second one waits for the first one's answer
    const running = [ ...new Set(wanted.map((id) => inFlight.get(id)).filter(Boolean)) ];
    const mine = wanted.filter((id) => !inFlight.has(id));
    let settle;
    const job = new Promise((resolve, reject) => (settle = { resolve, reject }));
    job.catch(() => {});
    mine.forEach((id) => inFlight.set(id, job));

    let items = [];
    try {
        const settled = await Promise.allSettled(running);
        const earlier = settled.filter((r) => r.status === "fulfilled").map((r) => r.value);
        const failed = settled.find((r) => r.status === "rejected");

        items = await store.takePending(mine);
        if (!items.length) {
            // The answer this call waited for failed: report that instead of trying again at once,
            // which would call Claude twice for one failure (the closed-chat scheduler backs off)
            if (failed && !earlier.length) throw failed.reason;
            settle.resolve(EMPTY_REPLY);
            // Answered already (by the scheduler while the screen was locked): the page gets it from live.js
            return earlier.length ? mergeReplies(earlier) : { ...EMPTY_REPLY, alreadyAnswered: true };
        }
        const result = announce(await chat(items, context), { type: "reply", replyTo: items.map((m) => m.id) });
        await store.removePending(items.map((m) => m.id));
        // Unsent while she was typing: it's in the log now, so take it back there.
        // Checked again after each one, since another take-back can arrive during the loop.
        for (let m = items.find((x) => unsendAfter.has(x.id)); m; m = items.find((x) => unsendAfter.has(x.id))) {
            unsendAfter.delete(m.id);
            await store.unsendFromHistory(m.text, clockOf(m.sentAt));
            noteUnsent(m.text);
        }
        maybeTidyMemory();
        if (result?.bubbles?.length && !isWatching()) pushMessage(visibleBubbles(result));
        settle.resolve(result);
        return mergeReplies([ ...earlier, result ]);
    } catch (err) {
        // The reply failed, but a message the user took back meanwhile should still go away
        const taken = items.filter((m) => unsendAfter.has(m.id)).map((m) => m.id);
        if (taken.length) await store.removePending(taken).catch(() => {});
        settle.reject(err);
        throw err;
    } finally {
        items.forEach((m) => unsendAfter.delete(m.id));
        mine.forEach((id) => {
            if (inFlight.get(id) === job) inFlight.delete(id);
        });
    }
}

/** This user is looking at this character's chat right now (a reply for another character still gets a push) */
const isWatching = () => away.isBeingViewed() && profiles.currentId() === profiles.getActiveId();

/** Sends her message to this user's phones when they aren't looking at the chat */
async function pushMessage(bubbles) {
    try {
        // A lock screen anyone can glance at: the setting can hide what she wrote
        const { pushPreview } = await config.getConfig();
        await push.notifyAll({ title: await personaName(), body: pushPreview ? push.previewText(bubbles) : "ส่งข้อความมา 💬", user: profiles.currentUser() });
    } catch (err) {
        console.error("push failed:", err?.message ?? err);
    }
}

/** Message id → the reply currently being written for it */
const inFlight = new Map();
const unsendAfter = new Set();
const clockOf = (t) => new Date(t).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

/* ------------------------------------ automatic memory tidy */

const tidying = new Set();

/**
 * When memory.md gets long, merge and trim it once a day in the background,
 * with a snapshot first so nothing is ever lost for good.
 */
async function maybeTidyMemory() {
    const { autoTidyChars: AUTO_TIDY_CHARS } = await config.getConfig();
    // The chat this reply belonged to, even if you've switched since
    const id = profiles.currentKey();
    if (!AUTO_TIDY_CHARS || tidying.has(id)) return;
    // Set before the first await, so two replies finishing together can't both start a tidy-up
    tidying.add(id);
    try {
        if ((await store.readMemoryFile()).length < AUTO_TIDY_CHARS) return;
        const today = new Date().toLocaleDateString("sv-SE");
        if ((await store.loadSettings())?.lastTidy?.[id] === today) return;

        // Merged inside the settings lock, so another character's date can't be dropped
        await store.saveSettings((current) => ({ lastTidy: { ...(current?.lastTidy ?? {}), [id]: today } }));
        await profiles.snapshot("ก่อนจัดระเบียบความจำอัตโนมัติ");
        const result = await compactMemory();
        if (result) console.log(`  🧹 จัดระเบียบความจำอัตโนมัติ: ${result.before} → ${result.after} บรรทัด`);
    } catch (err) {
        console.error("auto tidy failed:", err?.message ?? err);
    } finally {
        tidying.delete(id);
    }
}

/* ------------------------------------ accounts and chats */

/** The characters a user can open: ones they made, and public ones they added */
async function botsOf(user) {
    const rows = [];
    for (const p of await profiles.listProfiles()) {
        const meta = await profiles.botMeta(p.id);
        const isOwner = meta.owner === user.id;
        if (isOwner || (user.chats ?? []).includes(p.id)) rows.push({ ...p, isOwner, isPublic: meta.isPublic, owner: meta.owner });
    }
    return rows;
}

/** Which character this user has on screen; one they can still open, or none */
async function activeBotOf(user) {
    const bots = await botsOf(user);
    return bots.find((b) => b.id === user.activeBot)?.id ?? bots[0]?.id ?? "";
}

/** Opens a chat for the user (making their files the first time) and puts it on their screen */
async function openChat(user, id, { reset = false } = {}) {
    await users.setActiveBot(user.id, id);
    profiles.setActiveFor(user.id, id);
    await profiles.pinProfile(async () => {
        await profiles.prepareCurrent();
        if (reset) await onProfileSwitch();
        clearActivity();
    }, id, user.id);
}

/** Names for a list of user ids, in the same order */
async function peopleById(ids) {
    const all = new Map((await users.listUsers()).map((u) => [ u.id, u ]));
    return ids.map((id) => users.publicUser(all.get(id))).filter(Boolean);
}

/** Everything the chat list shows: characters and friends, with the latest from each friend */
async function chatList(user) {
    const fresh = (await users.getUser(user.id)) ?? user;
    const bots = await botsOf(fresh);
    const friends = [];
    for (const f of await peopleById(fresh.friends ?? [])) {
        const pair = dm.pairOf(fresh.id, f.id);
        const last = await dm.lastDm(fresh.id, f.id).catch(() => null);
        friends.push({ ...f, last: last ? { text: last.text.slice(0, 80), at: last.at, isMine: last.from === fresh.id } : null, unread: await dm.unreadCount(fresh.id, f.id, fresh.dmRead?.[pair] ?? 0).catch(() => 0) });
    }
    return {
        bots: bots.map((b) => ({ id: b.id, name: b.name, isOwner: b.isOwner, isPublic: b.isPublic })),
        friends,
        incoming: await peopleById(fresh.incoming ?? []),
        outgoing: await peopleById(fresh.outgoing ?? []),
    };
}

/** The signed-in user as their own page sees them */
const meOf = (u) => ({ ...users.publicUser(u), isAdmin: u.role === "admin" });

/** Only the person who made the character on screen */
async function requireOwner() {
    if (!(await profiles.isOwnerNow())) throw Object.assign(new Error("เฉพาะคนที่สร้างตัวละครนี้"), { status: 403 });
}

const requireAdmin = (user) => {
    if (user?.role !== "admin") throw Object.assign(new Error("เฉพาะผู้ดูแลระบบ"), { status: 403 });
};

/* ------------------------------------ routes */

const routes = {
    // scripts/run.js asks this after a restart: if it fails, the new code is rolled back

    "GET /api/bootstrap": async (_, url, req) => {
        // The log and the live number must match: a reply written while the log was being read
        // would otherwise be in neither (or in both). Read again if one slipped in between.
        let seq = live.latestSeq();
        let history = await store.todayEntries();
        for (let i = 0; i < 3 && seq !== live.latestSeq(); i++) {
            seq = live.latestSeq();
            history = await store.todayEntries();
        }
        const user = req.user;
        // No character yet (a new account): the page shows how to make or find one
        if (!profiles.currentId()) return { me: meOf(user), noBot: true, chats: await chatList(user), brain: await brainPayload(), isLocal: isLocal(req) };
        await profiles.prepareCurrent();
        const meta = await profiles.botMeta(profiles.currentId());
        return {
            me: meOf(user),
            isOwner: meta.owner === user.id,
            isPublic: meta.isPublic,
            chats: await chatList(user),
            name: await personaName(),
            profileId: profiles.getActiveId(),
            profiles: (await botsOf(user)).map((b) => ({ id: b.id, name: b.name, isOwner: b.isOwner })),
            brain: await brainPayload(),
            status: await statusPayload(),
            history,
            pending: await store.loadPending(),
            idleMinutes: (await config.getConfig()).idleMinutes,
            pushPreview: (await config.getConfig()).pushPreview,
            rethinkOnInterrupt: styleSettings((await store.loadTexts()).style).rethink,
            lastAgentAt: presence().lastAgentAt,
            // Everything up to here is already in `history`
            seq,
            liveBoot: live.BOOT,
            isLocal: isLocal(req),
            lan: isLocal(req) && user.role === "admin" ? await remoteInfo() : null,
        };
    },

    /* ---------- accounts */

    "GET /api/me": async (_, __, req) => ({ me: meOf(req.user), chats: await chatList(req.user) }),

    "POST /api/account/name": async (body, _, req) => ({ me: meOf(await users.updateProfile(req.user.id, { name: body?.name })) }),
    "POST /api/account/password": async (body, _, req, res) => {
        await users.changePassword(req.user.id, body?.old, body?.next);
        // Every other device is signed out; this one gets a fresh cookie
        res.setHeader("set-cookie", await users.sessionCookie(await users.getUser(req.user.id), { secure: isHttps(req) }));
        return { ok: true };
    },

    "GET /api/admin/invite": async (_, __, req) => {
        requireAdmin(req.user);
        return { code: await users.inviteCode() };
    },
    "POST /api/admin/invite": async (_, __, req) => {
        requireAdmin(req.user);
        return { code: await users.inviteCode({ rotate: true }) };
    },

    /* ---------- chat list, finding people and characters */

    "GET /api/chats": async (_, __, req) => chatList(req.user),

    // People by name or @id, and public characters by name or id
    "GET /api/explore": async (_, url, req) => {
        const q = String(url.searchParams.get("q") ?? "").trim().slice(0, 40);
        if (!q) return { people: [], bots: [] };
        const me = (await users.getUser(req.user.id)) ?? req.user;
        const people = (await users.searchUsers(q, { exclude: me.id })).map((u) => ({
            ...users.publicUser(u),
            status: me.friends.includes(u.id) ? "friend" : me.outgoing.includes(u.id) ? "requested" : me.incoming.includes(u.id) ? "incoming" : "",
        }));
        const needle = q.toLowerCase().replace(/^@/, "");
        const bots = [];
        for (const p of await profiles.listProfiles()) {
            const meta = await profiles.botMeta(p.id);
            if (!meta.isPublic && meta.owner !== me.id) continue;
            if (!p.name.toLowerCase().includes(needle) && p.id !== needle) continue;
            const owner = users.publicUser(await users.getUser(meta.owner));
            bots.push({ id: p.id, name: p.name, owner, isOwner: meta.owner === me.id, hasChat: meta.owner === me.id || me.chats.includes(p.id) });
        }
        return { people, bots: bots.slice(0, 20) };
    },

    // Adding a public character you found: your own chat with her starts like meeting someone new
    "POST /api/chats/add": async (body, _, req) => {
        const id = String(body?.id ?? "");
        const meta = await profiles.botMeta(id);
        if (!meta.isPublic && meta.owner !== req.user.id) throw Object.assign(new Error("ตัวละครนี้เป็นแบบส่วนตัว"), { status: 403 });
        await profiles.ensureChat(id, req.user.id);
        await openChat(req.user, id);
        return { id };
    },

    "POST /api/chats/remove": async (body, _, req) => {
        const id = String(body?.id ?? "");
        if ((await profiles.botMeta(id)).owner === req.user.id) throw new Error("ตัวละครที่สร้างเองลบได้จากเมนูลบ");
        await users.removeChat(req.user.id, id);
        return chatList(await users.getUser(req.user.id));
    },

    // Owner only: whether others can find her and start their own chat
    "POST /api/profiles/visibility": async (body) => {
        await requireOwner();
        const meta = await profiles.setBotMeta(profiles.currentId(), { isPublic: body?.isPublic === true });
        return { isPublic: meta.isPublic };
    },

    /* ---------- friends and chats between people */

    "POST /api/friends/request": async (body, _, req) => {
        const to = String(body?.id ?? "");
        const result = await users.requestFriend(req.user.id, to);
        live.publishToUser(to, { type: result === "friends" ? "friend" : "request", from: users.publicUser(req.user) });
        if (result === "requested") notifyUser(to, "คำขอเป็นเพื่อน", `${req.user.name} (@${req.user.handle}) อยากเป็นเพื่อน`);
        return { result, chats: await chatList(req.user) };
    },
    "POST /api/friends/answer": async (body, _, req) => {
        const from = String(body?.id ?? "");
        await users.answerFriend(req.user.id, from, body?.accept === true);
        if (body?.accept === true) live.publishToUser(from, { type: "friend", from: users.publicUser(req.user) });
        return chatList(req.user);
    },
    "POST /api/friends/remove": async (body, _, req) => {
        await users.removeFriend(req.user.id, String(body?.id ?? ""));
        return chatList(req.user);
    },

    "GET /api/dm": async (_, url, req) => {
        const other = String(url.searchParams.get("with") ?? "");
        if (!(await users.areFriends(req.user.id, other))) throw Object.assign(new Error("คุยได้เฉพาะเพื่อน"), { status: 403 });
        const before = Number(url.searchParams.get("before") ?? 0) || Infinity;
        const messages = await dm.readDm(req.user.id, other, { before });
        await users.markDmRead(req.user.id, dm.pairOf(req.user.id, other));
        return { messages, with: users.publicUser(await users.getUser(other)) };
    },
    "POST /api/dm/send": async (body, _, req) => {
        const to = String(body?.to ?? "");
        if (!(await users.areFriends(req.user.id, to))) throw Object.assign(new Error("คุยได้เฉพาะเพื่อน"), { status: 403 });
        const message = await dm.sendDm(req.user.id, to, body?.text);
        const event = { type: "dm", pair: dm.pairOf(req.user.id, to), message, from: users.publicUser(req.user) };
        live.publishToUser(to, event);
        live.publishToUser(req.user.id, event);
        if (!away.isBeingViewed(to)) notifyUser(to, req.user.name, message.text.slice(0, 120));
        await users.markDmRead(req.user.id, event.pair);
        return { message };
    },
    "POST /api/dm/read": async (body, _, req) => {
        const other = String(body?.with ?? "");
        await users.markDmRead(req.user.id, dm.pairOf(req.user.id, other));
        return { ok: true };
    },

    // This user's own news (friends' messages, requests), since a number
    "GET /api/events/user": async (_, url, req) => live.eventsSince(url.searchParams.get("after"), live.userFeed(req.user.id)),

    /* ---------- one active device */

    // Local only (see LOCAL_ONLY): makes every link and cookie handed out so far stop working

    "POST /api/presence/claim": async (body) => {
        away.claim(body?.clientId);
        return { ok: true };
    },

    "POST /api/presence/beat": async (body) => ({ isActive: away.beat(body?.clientId, body?.visible) }),

    /* ---------- push notifications */

    "GET /api/push/key": async () => ({
        key: await push.publicKey(),
        count: await push.subscriptionCount(profiles.currentUser()),
        preview: (await config.getConfig()).pushPreview,
    }),

    /* ---------- app settings (were only in .env) */

    "GET /api/config": async () => ({ values: await config.getConfig(), fields: config.describeConfig() }),
    // App-wide settings change everyone's characters, so only the admin
    "POST /api/config": async (body, _, req) => {
        requireAdmin(req.user);
        return { values: await config.setConfig(body?.values ?? {}), fields: config.describeConfig() };
    },

    "POST /api/push/subscribe": async (body) => ({ count: await push.subscribe(body?.subscription, body?.label, profiles.currentUser()) }),

    "POST /api/push/unsubscribe": async (body) => {
        await push.unsubscribe(body?.endpoint, profiles.currentUser());
        return { count: await push.subscriptionCount(profiles.currentUser()) };
    },

    "POST /api/push/test": async () => ({
        reached: await push.notifyAll({ title: await personaName(), body: "ทดสอบแจ้งเตือน 🔔", user: profiles.currentUser() }),
    }),

    /* ---------- move, share and back up characters */

    "POST /api/profiles/import": async (body, _, req) => {
        const { id, name } = await portable.importProfile(body?.pack);
        await openChat(req.user, id, { reset: true });
        return { id, name };
    },

    "GET /api/backup": async (_, __, req) => {
        requireAdmin(req.user);
        return portable.backupInfo();
    },
    "POST /api/backup": async (_, __, req) => {
        requireAdmin(req.user);
        return portable.backupAll();
    },

    /* ---------- characters */

    "GET /api/profiles": async (_, __, req) => ({ active: profiles.getActiveId(), profiles: (await botsOf(req.user)).map((b) => ({ id: b.id, name: b.name, isOwner: b.isOwner })) }),

    "POST /api/profiles/create": async (body, _, req) => {
        // A copy takes her persona, style and lessons, so only of a character you made
        if (body?.copy) await requireOwner();
        const id = await profiles.createProfile({ name: body?.name, copyFrom: body?.copy ? profiles.currentId() : "", owner: req.user.id });
        await openChat(req.user, id, { reset: true });
        return { id };
    },

    // The new-character form: files written from what you filled in, then she's the one on screen
    "POST /api/profiles/build": async (body, _, req) => {
        const made = await builder.buildCharacter(body?.spec ?? {}, complete, { owner: req.user.id, isPublic: body?.spec?.isPublic === true });
        await openChat(req.user, made.id, { reset: true });
        return made;
    },
    // What the form would write, without creating anything (no AI)
    "POST /api/profiles/preview": async (body) => ({ files: await builder.renderAll(builder.cleanSpec(body?.spec ?? {})) }),

    // Work already running stays pinned to the chat it started in, so a reply is saved where it belongs
    "POST /api/profiles/switch": async (body, _, req) => {
        const id = String(body?.id ?? "");
        if (!(await botsOf(req.user)).some((b) => b.id === id)) throw Object.assign(new Error("ไม่พบแชทนี้"), { status: 404 });
        await openChat(req.user, id);
        return { id };
    },

    "POST /api/profiles/delete": async (body, _, req) => {
        const id = String(body?.id ?? "");
        if ((await profiles.botMeta(id)).owner !== req.user.id) throw Object.assign(new Error("ลบได้เฉพาะตัวละครที่สร้างเอง"), { status: 403 });
        await profiles.deleteProfile(id);
        await users.dropBotEverywhere(id);
        // A new character could get this id one day; she must not inherit anything from this one
        forgetSession(id);
        return { profiles: (await botsOf(await users.getUser(req.user.id))).map((b) => ({ id: b.id, name: b.name, isOwner: b.isOwner })) };
    },

    /* ---------- memory snapshots */

    "GET /api/snapshots": async () => ({ snapshots: await profiles.listSnapshots() }),

    "POST /api/snapshots/create": async () => {
        await profiles.snapshot("สำรองเอง");
        return { snapshots: await profiles.listSnapshots() };
    },

    "POST /api/snapshots/restore": async (body) => {
        // Her files were just replaced, so her short-term memory of the last minutes goes too
        await switchExclusive(() => profiles.restoreSnapshot(body?.id), { reset: true });
        return { snapshots: await profiles.listSnapshots() };
    },

    /* ---------- chat extras */

    // She notices the reaction next turn, and it is saved in the day's log so it's still there after a refresh
    "POST /api/react": async (body) => {
        addReaction(body?.emoji, String(body?.text ?? "").replace(/\[รูป:[^\]]+\]/g, "📷").trim());
        const saved = await store.logReaction({
            by: "user",
            name: "ผู้ใช้",
            emoji: body?.emoji,
            targetTime: body?.time,
            targetText: body?.text,
            date: body?.date,
        });
        return { ok: true, saved };
    },

    // The morning look-up again, now (from the Teach tab); takes a few minutes
    "POST /api/today/refresh": async () => {
        const info = await world.refreshNow();
        return { ok: true, city: info?.city ?? "", text: await store.readEditable("today") };
    },

    // The coach's suggestions from reading past chats; each waits for you to accept or dismiss it
    "GET /api/coach": async () => ({ suggestions: (await coach.loadCoach()).suggestions }),
    "POST /api/coach/review": async () => {
        const result = await coach.reviewNow(complete);
        return { result, suggestions: (await coach.loadCoach()).suggestions };
    },
    "POST /api/coach/decide": async (body) => {
        const message = await coach.decide(String(body?.id ?? ""), body?.accept === true);
        return { message, suggestions: (await coach.loadCoach()).suggestions, teachings: await store.listTeachings() };
    },

    "GET /api/search": async (_, url) => ({ results: await store.searchHistory(url.searchParams.get("q")) }),

    "GET /api/status": statusPayload,
    "GET /api/brain": () => brainPayload(true),

    "POST /api/brain": async (body, _, req) => {
        requireAdmin(req.user);
        const mode = body?.mode === "api" ? "api" : "claude-code";
        await store.saveSettings({ brain: mode });
        return brainPayload();
    },

    // Saves the message the moment you press send; she reads and replies later through /api/chat
    "POST /api/send": async (body) => {
        if (!away.isActiveClient(body?.clientId)) throw new Error("แชทนี้เปิดใช้งานอยู่ที่อื่น");
        await store.addPending({ id: body?.id, text: body?.text });
        cancelAfterthought();
        return { ok: true };
    },

    /* ---------- unsend, edit, older days */

    "POST /api/unsend": async (body) => {
        const id = String(body?.id ?? "");
        if (inFlight.has(id)) {
            unsendAfter.add(id);
            return { ok: true, wasRead: true };
        }
        const pending = await store.unsendPending(id);
        if (pending.found) {
            if (pending.wasRead) noteUnsent(pending.text);
            return { ok: true, wasRead: pending.wasRead };
        }
        // Already answered: take it back in today's log, and she remembers seeing it
        const changed = await store.unsendFromHistory(body?.text, body?.time);
        if (!changed) throw new Error("ยกเลิกได้เฉพาะข้อความของวันนี้");
        noteUnsent(body?.text);
        return { ok: true, wasRead: true };
    },

    "POST /api/edit": async (body) => {
        if (inFlight.has(String(body?.id ?? ""))) throw new Error("เธออ่านแล้ว แก้ไม่ได้ ยกเลิกส่งได้อย่างเดียว");
        await store.editPending(body?.id, body?.text);
        return { ok: true };
    },

    "GET /api/history/day": async (_, url) => store.previousDay(url.searchParams.get("before")),

    "POST /api/read": async (body) => {
        await store.markPendingRead(body?.ids);
        return { ok: true };
    },

    "POST /api/chat": async (body) => {
        if (!away.isActiveClient(body?.clientId)) throw new Error("แชทนี้เปิดใช้งานอยู่ที่อื่น");
        await profiles.dailySnapshot().catch(() => {});
        const context = { activity: String(body?.activity ?? ""), readAgoMs: Number(body?.readAgoMs ?? 0), waitedMs: Number(body?.waitedMs ?? 0) };
        return { ...(await replyToPending(body?.ids, context)), status: await statusPayload() };
    },

    // She stopped typing because you sent something: keep only the bubbles that appeared on screen
    "POST /api/cut": async (body) => ({ ok: await cutLastReply(body?.shown, body?.bubbles) }),

    "POST /api/pacing": async (body) => planReply({ texts: Array.isArray(body?.texts) ? body.texts : [], ...presence() }),

    // Debug: "ข้ามการรอ" ends whatever she's busy with
    "POST /api/pacing/clear": async () => {
        clearActivity();
        return { ok: true };
    },

    "GET /api/logic/state": async (_, url) => ({
        ...logic.logicState(Number(url.searchParams.get("since") ?? 0)),
        model: logic.LOGIC_MODEL,
    }),

    "POST /api/logic/run": async (body) => {
        await logic.startLogicRun(body?.prompt);
        return logic.logicState(0);
    },

    "POST /api/logic/reset": async () => {
        logic.resetLogicSession();
        return { ok: true };
    },

    "GET /api/logic/files": async () => ({ files: await logic.listCodeFiles() }),
    "GET /api/logic/file": async (_, url) => ({ text: await logic.readCode(url.searchParams.get("path")) }),
    "POST /api/logic/file": async (body) => logic.writeCode(body?.path, body?.text),
    "GET /api/logic/backups": async () => ({ backups: await logic.listBackups() }),

    "POST /api/logic/restore": async (body) => {
        const files = await logic.restoreBackup(body?.id);
        return { files };
    },

    // scripts/run.js starts the server again when it exits with this code
    "POST /api/restart": async (body, _, req) => {
        requireAdmin(req.user);
        if (!process.env.PERSONA_RUNNER) throw new Error("รีสตาร์ทจากหน้าเว็บได้เมื่อเปิดด้วย npm run dev เท่านั้น ตอนนี้ให้กด Ctrl+C แล้วเปิดใหม่เอง");
        if (body?.backupId) await logic.markRestart(body.backupId);
        setTimeout(() => process.exit(75), 300);
        return { ok: true };
    },

    "POST /api/greet": async () => {
        // A new day may have started while the server was running
        await consolidateHistory().catch((err) => console.error("summary failed:", err?.message));
        return { ...pushIfAway(announce(await greet())), status: await statusPayload() };
    },

    // "เห้ย ลืมบอก": the page asks when the time the server picked has come; empty if it passed
    "POST /api/afterthought": async (body) => {
        // A tab that lost the chat to another device mustn't use it up where nobody sees it
        if (!away.isActiveClient(body?.clientId)) return { bubbles: [], notes: [] };
        return { ...pushIfAway(announce(await afterthought())), status: await statusPayload() };
    },
    "POST /api/nudge": async (body) => ({ ...pushIfAway(announce(await nudge(Number(body?.minutes ?? 15)))), status: await statusPayload() }),

    // What she said that this page hasn't shown yet (after a locked screen or a dropped connection)
    "GET /api/events": async (_, url) => live.eventsSince(url.searchParams.get("after"), url.searchParams.get("profile")),

    "POST /api/reset": async () => {
        resetSession();
        return { ok: true };
    },

    "GET /api/teachings": async () => ({ teachings: await store.listTeachings() }),

    "POST /api/teach": async (body) => {
        const message = await store.teach(body ?? {});
        return { message, teachings: await store.listTeachings() };
    },

    "POST /api/teachings/delete": async (body) => {
        const removed = await store.deleteTeaching(body?.trigger);
        return { removed, teachings: await store.listTeachings() };
    },

    "POST /api/style/correct": async (body) => ({
        count: await store.addStyleCorrection({ before: body?.before, after: body?.after, context: body?.context ?? "" }),
    }),

    "POST /api/style/samples": async (body) => ({
        added: await store.addStyleSamples(body?.text, { speaker: body?.speaker ?? "" }),
    }),

    "POST /api/remember": async (body) => ({ message: await store.remember(body?.topic || "สิ่งที่ผู้ใช้ขอให้จำ", body?.fact) }),

    "POST /api/compact": async () => {
        await profiles.snapshot("ก่อนจัดระเบียบความจำ");
        const days = await consolidateHistory();
        const memory = await compactMemory();
        return { days, memory };
    },

    "GET /api/file": async (_, url) => ({ text: await store.readEditable(url.searchParams.get("name")) }),

    "POST /api/file": async (body) => {
        // A hand edit can wipe memories by accident; keep a copy unless one was taken in the last 10 minutes
        const latest = (await profiles.listSnapshots())[0]?.id ?? "";
        const latestAt = new Date(latest.slice(0, 19).replace(/^(\d{4}-\d{2}-\d{2})-(\d{2})-(\d{2})-(\d{2})$/, "$1T$2:$3:$4")).getTime();
        if (!(Date.now() - latestAt < 10 * 60000)) await profiles.snapshot(`ก่อนแก้ไฟล์ ${body?.name}`);
        await store.writeEditable(body?.name, body?.text);
        return { ok: true, name: await personaName() };
    },
};

// Changing the system's code is only allowed from this computer, never from a phone on the network
const LOCAL_ONLY = /^\/api\/(logic\/|restart)/;
// The system's code and the server itself: the admin only
const ADMIN_ONLY = /^\/api\/(logic\/|restart|backup)/;
// Teaching her, her files, her backups, the coach: the person who made the character on screen
const OWNER_ONLY = new Set([
    "GET /api/teachings", "POST /api/teach", "POST /api/teachings/delete", "POST /api/style/correct", "POST /api/style/samples",
    "POST /api/remember", "POST /api/compact", "GET /api/file", "POST /api/file", "GET /api/snapshots", "POST /api/snapshots/create",
    "POST /api/snapshots/restore", "GET /api/coach", "POST /api/coach/review", "POST /api/coach/decide", "POST /api/today/refresh",
    "POST /api/reset", "POST /api/pacing/clear",
]);
// Fine with no chat open yet: everything about accounts, the chat list, and making or finding a character
const NO_BOT_OK = /^\/api\/(me|bootstrap|chats|explore|friends|dm|events\/user|stream\/user|profiles\/(build|preview|import|switch)|profiles$|push\/|presence\/|account\/|admin\/|auth\/|logic\/|restart|config|brain|backup)/;

/** Signing in and signing up: the only API calls that work without an account */
async function handleAuth(req, res, url) {
    if (req.method === "GET" && url.pathname === "/api/auth/state") {
        return send(res, 200, { hasUsers: await users.hasUsers(), me: users.publicUser(await users.userOf(req)) });
    }
    if (req.method !== "POST" || !isOwnPage(req)) return send(res, 403, { error: "คำขอนี้ไม่ได้มาจากหน้าแชทของแอป" });
    if (url.pathname === "/api/auth/logout") {
        res.setHeader("set-cookie", users.clearCookie(isHttps(req)));
        return send(res, 200, { ok: true });
    }
    const ip = clientIp(req);
    if (isBlocked(ip)) return send(res, 429, { error: "ลองผิดหลายครั้งเกินไป รอสักครู่แล้วลองใหม่" });
    const body = await readBody(req, 20_000);
    try {
        let user;
        if (url.pathname === "/api/auth/login") {
            user = await users.login(body?.handle, body?.password);
            if (!user) {
                recordFailure(ip);
                return send(res, 401, { error: "ไอดีหรือรหัสผ่านไม่ถูกต้อง" });
            }
        } else if (url.pathname === "/api/auth/register") {
            const isFirst = !(await users.hasUsers());
            user = await users.register(body ?? {}).catch((err) => {
                recordFailure(ip);
                throw err;
            });
            // The first account takes over everything made before accounts existed
            if (isFirst) {
                const adopted = await profiles.adoptLegacy(user.id);
                for (const id of adopted) await users.addChat(user.id, id);
                await push.adoptSubs(user.id);
                const before = (await store.loadSettings())?.activePersona;
                await users.setActiveBot(user.id, adopted.includes(before) ? before : adopted[0] ?? "");
                if (adopted.length) console.log(`  👤 ${user.name} เป็นผู้ดูแลระบบ และได้ตัวละครเดิม ${adopted.length} ตัว`);
            }
        } else {
            return send(res, 404, { error: "ไม่พบ" });
        }
        res.setHeader("set-cookie", await users.sessionCookie(user, { secure: isHttps(req) }));
        return send(res, 200, { me: users.publicUser(user) });
    } catch (err) {
        return send(res, 400, { error: err?.message ?? String(err) });
    }
}

/** Sends a notification to one user's phones (a friend's message or request) */
async function notifyUser(user, title, body) {
    try {
        const { pushPreview } = await config.getConfig();
        await push.notifyAll({ title, body: pushPreview ? body : "มีข้อความใหม่ 💬", tag: "persona-people", user });
    } catch (err) {
        console.error("push failed:", err?.message ?? err);
    }
}

/**
 * Every request runs as its signed-in user, on the character they have on screen, even if they
 * switch characters while it's still running (a reply can take a minute).
 */
async function handleApi(req, res, url) {
    if (url.pathname.startsWith("/api/auth/")) return handleAuth(req, res, url);
    const user = await users.userOf(req);
    if (!user) return send(res, 401, { error: "ต้องเข้าสู่ระบบก่อน", needsLogin: true });
    req.user = user;
    let bot = await activeBotOf(user);
    // A page names the chat it shows; it gets that chat's updates only if it's one of this user's
    const asked = url.searchParams.get("profile");
    if (asked && asked !== bot && (await botsOf(user)).some((b) => b.id === asked)) bot = asked;
    else profiles.setActiveFor(user.id, bot);
    return profiles.pinProfile(() => handleApiNow(req, res, url), bot || "", user.id);
}

async function handleApiNow(req, res, url) {
    if (!isLocal(req) && LOCAL_ONLY.test(url.pathname)) return send(res, 403, { error: "ใช้ได้เฉพาะบนคอมเครื่องนี้" });
    if (ADMIN_ONLY.test(url.pathname) && req.user?.role !== "admin") return send(res, 403, { error: "เฉพาะผู้ดูแลระบบ" });
    // Anything that changes something must come from this app's own page (see isOwnPage)
    if (req.method !== "GET" && req.method !== "HEAD" && !isOwnPage(req)) {
        return send(res, 403, { error: "คำขอนี้ไม่ได้มาจากหน้าแชทของแอป" });
    }
    if (!profiles.currentId() && !NO_BOT_OK.test(url.pathname)) return send(res, 409, { error: "ยังไม่มีแชท สร้างหรือค้นหาตัวละครก่อน", noBot: true });
    if (OWNER_ONLY.has(`${req.method} ${url.pathname}`) && !(await profiles.isOwnerNow())) {
        return send(res, 403, { error: "เฉพาะคนที่สร้างตัวละครนี้" });
    }

    // This user's own feed (friends' messages, requests)
    if (req.method === "GET" && url.pathname === "/api/stream/user") return live.stream(req, res, live.userFeed(req.user.id));
    // A live stream stays open, so it skips the JSON routes too
    if (req.method === "GET" && url.pathname === "/api/stream") return live.stream(req, res, profiles.currentKey());

    // Pictures are binary, so they skip the JSON routes
    if (req.method === "GET" && url.pathname.startsWith("/api/upload/")) {
        try {
            const { bytes, ext } = await store.readUpload(decodeURIComponent(url.pathname.slice(12)));
            res.writeHead(200, { "content-type": `image/${ext === "jpg" ? "jpeg" : ext}`, "cache-control": "private, max-age=86400" });
            return res.end(bytes);
        } catch (err) {
            return send(res, 404, { error: err?.message ?? "ไม่พบรูป" });
        }
    }
    // Your own chat with the character on screen, as text: anyone can take that, it's theirs
    if (req.method === "GET" && url.pathname === "/api/profiles/history") {
        try {
            const { name, text } = await portable.exportHistory(profiles.currentId());
            res.writeHead(200, {
                "content-type": "text/markdown; charset=utf-8",
                "content-disposition": `attachment; filename="chat.md"; filename*=UTF-8''${encodeURIComponent(portable.historyFileName(name))}`,
                "cache-control": "no-store",
            });
            return res.end(text);
        } catch (err) {
            return send(res, 400, { error: err?.message ?? String(err) });
        }
    }
    // A character file is a download, not JSON for the page. Only of a character you made, and only
    // with your own chat: someone else's character (or someone else's chat) never leaves this way
    if (req.method === "GET" && url.pathname === "/api/profiles/export") {
        try {
            const id = url.searchParams.get("id") || profiles.currentId();
            if ((await profiles.botMeta(id)).owner !== req.user.id) return send(res, 403, { error: "ส่งออกได้เฉพาะตัวละครที่สร้างเอง (แชทของคุณโหลดเป็นไฟล์ข้อความได้)" });
            const pack = await portable.exportProfile(id, {
                mode: url.searchParams.get("mode") === "identity" ? "identity" : "full",
                withImages: url.searchParams.get("images") === "1",
                user: req.user.id,
            });
            const name = portable.exportFileName(pack);
            res.writeHead(200, {
                "content-type": "application/json; charset=utf-8",
                "content-disposition": `attachment; filename="character.persona.json"; filename*=UTF-8''${encodeURIComponent(name)}`,
                "cache-control": "no-store",
            });
            return res.end(JSON.stringify(pack, null, 1));
        } catch (err) {
            return send(res, 400, { error: err?.message ?? String(err) });
        }
    }
    if (req.method === "POST" && url.pathname === "/api/profiles/import") {
        try {
            const body = await readBody(req, 64_000_000);
            return send(res, 200, await routes["POST /api/profiles/import"](body));
        } catch (err) {
            return send(res, 400, { error: err?.message ?? String(err) });
        }
    }
    if (req.method === "POST" && url.pathname === "/api/upload") {
        try {
            const body = await readBody(req, 12_000_000);
            return send(res, 200, { name: await store.saveUpload(body?.data) });
        } catch (err) {
            return send(res, 400, { error: err?.message ?? String(err) });
        }
    }

    const route = routes[`${req.method} ${url.pathname}`];
    if (!route) return send(res, 404, { error: "ไม่พบ" });
    try {
        const body = req.method === "POST" ? await readBody(req) : null;
        send(res, 200, await route(body, url, req, res));
    } catch (err) {
        if (!err?.status) console.error(err);
        send(res, err?.status ?? 500, { error: err?.message ?? String(err) });
    }
}

/* ------------------------------------ access from other devices (LAN, Cloudflare Tunnel) */

const isKnownHost = makeHostCheck({
    isLan,
    isQuickTunnel: /^(1|true|yes)$/i.test(String(process.env.TUNNEL ?? "")),
    publicUrl: process.env.PUBLIC_URL ?? "",
    // Extra names you open the app by, e.g. a hostname on your LAN: ALLOWED_HOSTS=mypc.local
    extraHosts: String(process.env.ALLOWED_HOSTS ?? "").split(","),
});

/** The public tunnel address: PUBLIC_URL for a named tunnel, or the quick tunnel the runner started */
async function tunnelUrl() {
    if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/+$/, "");
    try {
        return JSON.parse(await readFile(TUNNEL_FILE, "utf8"))?.url ?? "";
    } catch {
        return "";
    }
}

const TUNNEL_FILE = path.join(ROOT, "data", ".tunnel.json");

/** Addresses other devices can open; everyone signs in there with their own account */
async function remoteInfo() {
    const tunnel = await tunnelUrl();
    return {
        enabled: isLan || Boolean(tunnel),
        isTunnelOn: /^(1|true|yes)$/i.test(String(process.env.TUNNEL ?? "")) || Boolean(process.env.PUBLIC_URL),
        tunnel: tunnel ? `${tunnel}/` : "",
        urls: isLan ? lanAddresses().map((ip) => `http://${ip}:${PORT}/`) : [],
    };
}

// Wrong passwords (and invite codes) from one address are limited, so they can't be guessed by hammering
const failures = new Map();
const MAX_FAILURES = 20;
const FAILURE_WINDOW_MS = 10 * 60000;

const isBlocked = (ip) => {
    const f = failures.get(ip);
    if (!f || Date.now() - f.since > FAILURE_WINDOW_MS) return false;
    return f.count >= MAX_FAILURES;
};

const MAX_TRACKED = 5000;

const recordFailure = (ip) => {
    const f = failures.get(ip);
    if (!f || Date.now() - f.since > FAILURE_WINDOW_MS) failures.set(ip, { since: Date.now(), count: 1 });
    else f.count++;
    // Old entries go, so a flood of addresses can't grow this without limit
    if (failures.size > MAX_TRACKED) {
        for (const [ k, v ] of failures) if (Date.now() - v.since > FAILURE_WINDOW_MS) failures.delete(k);
        while (failures.size > MAX_TRACKED) failures.delete(failures.keys().next().value);
    }
};

/* ------------------------------------ static (production) */

const TYPES = { ".webmanifest": "application/manifest+json", ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2" };

async function serveStatic(req, res, url) {
    let decoded = "";
    try {
        decoded = decodeURIComponent(url.pathname);
    } catch {
        return send(res, 400, { error: "bad path" });
    }
    const safe = path.normalize(decoded).replace(/^([/\\])+/, "");
    let file = path.join(DIST, safe);
    if (!file.startsWith(DIST + path.sep) && file !== DIST) return send(res, 403, { error: "forbidden" });
    try {
        if (!(await stat(file)).isFile()) file = path.join(DIST, "index.html");
    } catch {
        file = path.join(DIST, "index.html");
    }
    try {
        const data = await readFile(file);
        res.writeHead(200, { "content-type": `${TYPES[path.extname(file)] ?? "application/octet-stream"}; charset=utf-8` });
        res.end(data);
    } catch {
        res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
        res.end("ยังไม่ได้ build หน้าเว็บ ให้รัน npm run build ก่อน หรือใช้ npm run dev");
    }
}

/* ------------------------------------ start */

let vite = null;
if (!isProd) {
    const { createServer } = await import("vite");
    // HMR off: editlogic may rewrite page files mid-run, and an auto reload would cut the page off
    // Vite refuses unknown Host headers; tunnel addresses are allowed because every API call needs a signed-in account
    const publicHost = process.env.PUBLIC_URL ? new URL(process.env.PUBLIC_URL).hostname : "";
    vite = await createServer({
        root: ROOT,
        server: { middlewareMode: true, hmr: false, allowedHosts: [ ".trycloudflare.com", ...(publicHost ? [ publicHost ] : []), ...String(process.env.ALLOWED_HOSTS ?? "").split(",").map((h) => h.trim()).filter(Boolean) ] },
        appType: "spa",
    });
}

async function handleRequest(req, res) {
    let url;
    try {
        url = new URL(req.url, "http://localhost");
    } catch {
        return send(res, 400, { error: "bad request" });
    }
    if (!isKnownHost(req)) {
        console.log(`  ⚠ ปฏิเสธคำขอจากชื่อ host ที่ไม่รู้จัก: ${String(req.headers.host ?? "").slice(0, 100)} (ถ้าเป็นของคุณ ใส่ใน ALLOWED_HOSTS)`);
        res.writeHead(421, { "content-type": "text/plain; charset=utf-8" });
        return res.end("unknown host");
    }
    // The page itself is open to anyone (it shows the sign-in screen); every API call checks the account
    if (url.pathname === "/api/health") return send(res, 200, { ok: true });
    if (url.pathname.startsWith("/api/")) return handleApi(req, res, url);
    if (await handleAppIcon(req, res, url)) return;
    if (vite) return vite.middlewares(req, res);
    return serveStatic(req, res, url);
}

const server = http.createServer(async (req, res) => {
    try {
        await handleRequest(req, res);
    } catch (err) {
        console.error("request failed:", err?.stack ?? err);
        if (!res.headersSent) send(res, 500, { error: "เซิร์ฟเวอร์ผิดพลาด" });
        else res.end();
    }
});

away.startAwayScheduler(awayPing, {
    // Every chat gets its own check: the owner's, and everyone who added her and still has her in their list
    users: async (bot) => {
        const meta = await profiles.botMeta(bot);
        const members = new Set((await users.listUsers()).filter((u) => u.id === meta.owner || u.chats.includes(bot)).map((u) => u.id));
        return (await profiles.chatUsers(bot)).filter((id) => members.has(id));
    },
    planReply,
    pending: store.loadPending,
    reply: (ids, context) => replyToPending(ids, context),
    // She texted first, or remembered something, while nobody was looking: open pages and phones hear it
    onAgentMessage: (bubbles) => {
        live.publish({ type: "say", bubbles });
        return pushMessage(bubbles);
    },
});
portable.startBackupScheduler();

// Localhost unless ALLOW_LAN=1: this server edits files on disk and runs Claude on your account
server.listen(PORT, isLan ? "0.0.0.0" : "127.0.0.1", async () => {
    const brain = await brainPayload();
    console.log(`\n  ✿ Broker พร้อมแล้ว → http://localhost:${PORT}\n`);
    if (isLan) {
        const info = await remoteInfo();
        console.log("  📱 เปิดบนมือถือ (Wi-Fi เดียวกัน):");
        info.urls.forEach((u) => console.log(`     ${u}`));
        console.log("");
    }
    if (process.env.PUBLIC_URL) console.log(`  🌐 เปิดจากที่ไหนก็ได้: ${(await remoteInfo()).tunnel}\n`);
    if (!(await users.hasUsers())) console.log("  👤 ยังไม่มีบัญชี: เปิดหน้าเว็บแล้วสมัคร บัญชีแรกเป็นผู้ดูแลระบบและได้ตัวละครเดิมทั้งหมด\n");
    console.log(`  สมอง: ${brain.mode === "api" ? `API key (${API_MODEL})` : `Claude ในเครื่อง (${CC_MODEL})`}`);
    if (brain.mode === "claude-code" && !brain.claudeCode.installed) console.log("  ⚠ ไม่พบ Claude Code ในเครื่อง — ติดตั้งก่อน หรือสลับไปใช้ API key ในหน้าเว็บ");
    else if (brain.mode === "claude-code" && !brain.claudeCode.loggedIn) console.log("  ⚠ Claude Code ยังไม่ได้ล็อกอิน — พิมพ์ claude ใน terminal เพื่อล็อกอินก่อน");
    console.log("");

    // Under npm run dev the runner drops the rollback marker once /api/health answers;
    // started by hand, there's no runner to roll back, so just clear it after a while
    if (!process.env.PERSONA_RUNNER) {
        setTimeout(() => rm(path.join(ROOT, "data", ".backups", "pending-restart.json"), { force: true }).catch(() => {}), 12000);
    }
});
