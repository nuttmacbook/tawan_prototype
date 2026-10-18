import http from "node:http";
import crypto from "node:crypto";
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
    chat, greet, nudge, warmUp, resetSession, personaName, brainMode, consolidateHistory, compactMemory, hasApiKey, presence,
    addReaction, awayPing, switchExclusive, forgetSession, noteUnsent, promptStats, cutLastReply,
} = await import("./brain.js");
const profiles = await import("./profiles.js");
const away = await import("./away.js");
const portable = await import("./portable.js");
const push = await import("./push.js");
const { handleAppIcon, PUBLIC_PATHS } = await import("./appicon.js");
const { planReply, clearActivity } = await import("./pacing.js");
const logic = await import("./logic.js");
const store = await import("./store.js");
const { loadState, describeMood, stageOf, agoText } = await import("./mood.js");
const { loadThreads } = await import("./life.js");
const { styleSettings } = await import("./humanize.js");
const config = await import("./config.js");
const world = await import("./world.js");
const { claudeCodeStatus, API_MODEL, CC_MODEL } = await import("./llm.js");
const { isLocal, clientIp, isHttps, lanAddresses, makeHostCheck, isOwnPage } = await import("./gate.js");

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const DIST = path.join(ROOT, "dist");
const PORT = Number(process.env.PORT ?? 3939) || 3939;
const isProd = process.argv.includes("--prod");
const isLan = /^(1|true|yes)$/i.test(String(process.env.ALLOW_LAN ?? ""));

// Characters must exist before any route reads their files
await profiles.initProfiles();

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
    const [ state, threads ] = await Promise.all([ loadState(), loadThreads() ]);
    const stage = stageOf(state.closeness);
    return {
        moods: state.moods.map((m) => ({ name: m.name, value: Math.round(m.value * 10) / 10, base: m.base })),
        moodText: describeMood(state),
        closeness: Math.round(state.closeness * 10) / 10,
        stage: stage.label,
        messages: state.messages,
        lastSeen: state.lastSeen == null ? "-" : agoText(Date.now() - state.lastSeen),
        threads,
        prompt: promptStats(),
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
    };
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
            return mergeReplies(earlier);
        }
        const result = await chat(items, context);
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

/** Someone is looking at this character's chat right now (a reply for another character still gets a push) */
const isWatching = () => away.isBeingViewed() && profiles.currentId() === profiles.getActiveId();

/** Sends her message to subscribed phones when nobody is looking at the chat */
async function pushMessage(bubbles) {
    try {
        // A lock screen anyone can glance at: the setting can hide what she wrote
        const { pushPreview } = await config.getConfig();
        await push.notifyAll({ title: await personaName(), body: pushPreview ? push.previewText(bubbles) : "ส่งข้อความมา 💬" });
    } catch (err) {
        console.error("push failed:", err?.message ?? err);
    }
}

/** Message id → the reply currently being written for it */
const inFlight = new Map();
const unsendAfter = new Set();
const clockOf = (t) => new Date(t).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

/* ------------------------------------ automatic memory tidy */

let isTidying = false;

/**
 * When memory.md gets long, merge and trim it once a day in the background,
 * with a snapshot first so nothing is ever lost for good.
 */
async function maybeTidyMemory() {
    const { autoTidyChars: AUTO_TIDY_CHARS } = await config.getConfig();
    if (!AUTO_TIDY_CHARS || isTidying) return;
    // Set before the first await, so two replies finishing together can't both start a tidy-up
    isTidying = true;
    try {
        if ((await store.readMemoryFile()).length < AUTO_TIDY_CHARS) return;
        // The character this reply belonged to, even if you've switched since
        const id = profiles.currentId();
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
        isTidying = false;
    }
}

/* ------------------------------------ routes */

const routes = {
    // scripts/run.js asks this after a restart: if it fails, the new code is rolled back
    "GET /api/health": async () => ({ ok: true, name: await personaName(), status: await statusPayload() }),

    "GET /api/bootstrap": async (_, url, req) => ({
        name: await personaName(),
        profileId: profiles.getActiveId(),
        profiles: await profiles.listProfiles(),
        brain: await brainPayload(),
        status: await statusPayload(),
        history: await store.todayEntries(),
        pending: await store.loadPending(),
        idleMinutes: (await config.getConfig()).idleMinutes,
        pushPreview: (await config.getConfig()).pushPreview,
        rethinkOnInterrupt: styleSettings((await store.loadTexts()).style).rethink,
        lastAgentAt: presence().lastAgentAt,
        isLocal: isLocal(req),
        lan: isLocal(req) ? await remoteInfo() : null,
    }),

    /* ---------- one active device */

    // Local only (see LOCAL_ONLY): makes every link and cookie handed out so far stop working
    "POST /api/remote/rotate": async () => {
        await rotateKey();
        return remoteInfo();
    },

    "POST /api/presence/claim": async (body) => {
        away.claim(body?.clientId);
        return { ok: true };
    },

    "POST /api/presence/beat": async (body) => ({ isActive: away.beat(body?.clientId, body?.visible) }),

    /* ---------- push notifications */

    "GET /api/push/key": async () => ({
        key: await push.publicKey(),
        count: await push.subscriptionCount(),
        preview: (await config.getConfig()).pushPreview,
    }),

    /* ---------- app settings (were only in .env) */

    "GET /api/config": async () => ({ values: await config.getConfig(), fields: config.describeConfig() }),
    "POST /api/config": async (body) => ({ values: await config.setConfig(body?.values ?? {}), fields: config.describeConfig() }),

    "POST /api/push/subscribe": async (body) => ({ count: await push.subscribe(body?.subscription, body?.label) }),

    "POST /api/push/unsubscribe": async (body) => {
        await push.unsubscribe(body?.endpoint);
        return { count: await push.subscriptionCount() };
    },

    "POST /api/push/test": async () => ({
        reached: await push.notifyAll({ title: await personaName(), body: "ทดสอบแจ้งเตือน 🔔" }),
    }),

    /* ---------- move, share and back up characters */

    "POST /api/profiles/import": async (body) => {
        const { id, name } = await portable.importProfile(body?.pack);
        await switchExclusive(() => profiles.switchProfile(id), { reset: true });
        clearActivity();
        return { id, name };
    },

    "GET /api/backup": async () => portable.backupInfo(),
    "POST /api/backup": async () => portable.backupAll(),

    /* ---------- characters */

    "GET /api/profiles": async () => ({ active: profiles.getActiveId(), profiles: await profiles.listProfiles() }),

    "POST /api/profiles/create": async (body) => {
        const id = await profiles.createProfile({ name: body?.name, copyFrom: body?.copy ? profiles.getActiveId() : "" });
        await switchExclusive(() => profiles.switchProfile(id), { reset: true });
        clearActivity();
        return { id };
    },

    // Waits for a reply that is still being written, so it is saved to the character it belongs to
    "POST /api/profiles/switch": async (body) => {
        await switchExclusive(() => profiles.switchProfile(body?.id));
        clearActivity();
        return { id: profiles.getActiveId() };
    },

    "POST /api/profiles/delete": async (body) => {
        await profiles.deleteProfile(body?.id);
        // A new character could get this id one day; she must not inherit anything from this one
        forgetSession(String(body?.id ?? ""));
        return { profiles: await profiles.listProfiles() };
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

    "GET /api/search": async (_, url) => ({ results: await store.searchHistory(url.searchParams.get("q")) }),

    "GET /api/status": statusPayload,
    "GET /api/brain": () => brainPayload(true),

    "POST /api/brain": async (body) => {
        const mode = body?.mode === "api" ? "api" : "claude-code";
        await store.saveSettings({ brain: mode });
        return brainPayload();
    },

    // Saves the message the moment you press send; she reads and replies later through /api/chat
    "POST /api/send": async (body) => {
        if (!away.isActiveClient(body?.clientId)) throw new Error("แชทนี้เปิดใช้งานอยู่ที่อื่น");
        await store.addPending({ id: body?.id, text: body?.text });
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
    "POST /api/restart": async (body) => {
        if (!process.env.PERSONA_RUNNER) throw new Error("รีสตาร์ทจากหน้าเว็บได้เมื่อเปิดด้วย npm run dev เท่านั้น ตอนนี้ให้กด Ctrl+C แล้วเปิดใหม่เอง");
        if (body?.backupId) await logic.markRestart(body.backupId);
        setTimeout(() => process.exit(75), 300);
        return { ok: true };
    },

    "POST /api/greet": async () => {
        // A new day may have started while the server was running
        await consolidateHistory().catch((err) => console.error("summary failed:", err?.message));
        return { ...(await greet()), status: await statusPayload() };
    },

    "POST /api/nudge": async (body) => ({ ...(await nudge(Number(body?.minutes ?? 15))), status: await statusPayload() }),

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
const LOCAL_ONLY = /^\/api\/(logic\/|restart|remote\/)/;

// These change which character is active, so they must not be pinned to the old one
const UNPINNED = new Set([ "/api/profiles/switch", "/api/profiles/create", "/api/profiles/import", "/api/snapshots/restore" ]);

/**
 * Every other request works on the character that was active when it arrived, even if you
 * switch characters while it's still running (a reply can take a minute).
 */
const handleApi = (req, res, url) =>
    UNPINNED.has(url.pathname) ? handleApiNow(req, res, url) : profiles.pinProfile(() => handleApiNow(req, res, url));

async function handleApiNow(req, res, url) {
    if (!isLocal(req) && LOCAL_ONLY.test(url.pathname)) return send(res, 403, { error: "ใช้ได้เฉพาะบนคอมเครื่องนี้" });
    // Anything that changes something must come from this app's own page (see isOwnPage)
    if (req.method !== "GET" && req.method !== "HEAD" && !isOwnPage(req)) {
        return send(res, 403, { error: "คำขอนี้ไม่ได้มาจากหน้าแชทของแอป" });
    }

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
    // Her own photos (data/personas/<id>/photos), only names that are really in that folder
    if (req.method === "GET" && url.pathname.startsWith("/api/photo/")) {
        let name = "";
        try {
            name = decodeURIComponent(url.pathname.slice(11));
        } catch {}
        const file = await world.photoFile(name);
        if (!file) return send(res, 404, { error: "ไม่พบรูป" });
        try {
            const ext = path.extname(file).slice(1).toLowerCase();
            res.writeHead(200, { "content-type": `image/${ext === "jpg" ? "jpeg" : ext}`, "cache-control": "private, max-age=86400" });
            return res.end(await readFile(file));
        } catch {
            return send(res, 404, { error: "ไม่พบรูป" });
        }
    }
    // A character file is a download, not JSON for the page
    if (req.method === "GET" && url.pathname === "/api/profiles/export") {
        try {
            const pack = await portable.exportProfile(url.searchParams.get("id") || profiles.getActiveId(), {
                mode: url.searchParams.get("mode") === "identity" ? "identity" : "full",
                withImages: url.searchParams.get("images") === "1",
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
        send(res, 200, await route(body, url, req));
    } catch (err) {
        console.error(err);
        send(res, 500, { error: err?.message ?? String(err) });
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

/** A random key kept in settings; other devices open the link with ?key= once and get a cookie */
async function accessKey() {
    const settings = await store.loadSettings();
    if (settings?.lanKey) return settings.lanKey;
    return rotateKey();
}

/** New key: every phone and old link has to be opened again with the new link */
async function rotateKey() {
    const key = crypto.randomBytes(18).toString("base64url");
    await store.saveSettings({ lanKey: key });
    return key;
}

const sameKey = (a, b) => {
    const x = Buffer.from(String(a ?? ""));
    const y = Buffer.from(String(b ?? ""));
    return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
};

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

async function remoteInfo() {
    const key = await accessKey();
    const tunnel = await tunnelUrl();
    return {
        enabled: isLan || Boolean(tunnel),
        isTunnelOn: /^(1|true|yes)$/i.test(String(process.env.TUNNEL ?? "")) || Boolean(process.env.PUBLIC_URL),
        tunnel: tunnel ? `${tunnel}/?key=${key}` : "",
        urls: isLan ? lanAddresses().map((ip) => `http://${ip}:${PORT}/?key=${key}`) : [],
    };
}

const cookieOf = (req, name) =>
    String(req.headers.cookie ?? "").split(";").map((c) => c.trim().split("=")).find(([ k ]) => k === name)?.[1] ?? "";

// Wrong keys from one address are limited, so the key can't be guessed by hammering the link
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

/** @returns {Promise<boolean>} true when the request may continue */
async function accessGate(req, res, url) {
    if (isLocal(req)) return true;
    // App name and icon only: phones fetch these for the home screen without sending the cookie
    if (PUBLIC_PATHS.has(url.pathname)) return true;
    const ip = clientIp(req);
    if (isBlocked(ip)) {
        res.writeHead(429, { "content-type": "text/plain; charset=utf-8" });
        res.end("ลองผิดหลายครั้งเกินไป รอสักครู่แล้วลองใหม่");
        return false;
    }

    const key = await accessKey();
    const secure = isHttps(req) ? "; Secure" : "";
    if (sameKey(url.searchParams.get("key"), key)) {
        // Swap the key in the address bar for a cookie so it doesn't sit in browser history
        res.writeHead(302, { location: "/", "set-cookie": `pk=${key}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax${secure}` });
        res.end();
        return false;
    }
    if (sameKey(cookieOf(req, "pk"), key)) return true;

    recordFailure(ip);
    if (url.pathname.startsWith("/api/")) {
        send(res, 401, { error: "ต้องเปิดลิงก์ที่มีรหัสก่อน" });
        return false;
    }
    res.writeHead(401, { "content-type": "text/html; charset=utf-8" });
    res.end("<meta name=viewport content='width=device-width'><p style='font-family:sans-serif;padding:2rem'>เปิดลิงก์ที่มี ?key= จากเมนูบนคอมก่อนนะ (แตะชื่อตัวละคร → เปิดบนมือถือ)</p>");
    return false;
}

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
    // Vite refuses unknown Host headers; tunnel addresses are allowed because accessGate checks the key first
    const publicHost = process.env.PUBLIC_URL ? new URL(process.env.PUBLIC_URL).hostname : "";
    vite = await createServer({
        root: ROOT,
        server: { middlewareMode: true, hmr: false, allowedHosts: [ ".trycloudflare.com", ...(publicHost ? [ publicHost ] : []), ...String(process.env.ALLOWED_HOSTS ?? "").split(",").map((h) => h.trim()).filter(Boolean) ] },
        appType: "spa",
    });
}

await warmUp();

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
    if (!(await accessGate(req, res, url))) return;
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
    planReply,
    pending: store.loadPending,
    reply: (ids, context) => replyToPending(ids, context),
    onAgentMessage: pushMessage,
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
    // The quick tunnel's address is printed by scripts/run.js; make sure the key it needs exists
    await accessKey();
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
