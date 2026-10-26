import { loadState } from "./mood.js";
import { planReply } from "./pacing.js";
import { loadSettings, saveSettings, currentKey, currentUser, pinProfile, getActiveId, listProfiles, isOwnerNow } from "./profiles.js";
import { getConfig } from "./config.js";
import { maybeRefresh, dayKind } from "./world.js";
import { maybeReview } from "./coach.js";
import { complete, afterthought, isAfterthoughtDue } from "./brain.js";

/* ------------------------------------ config */

// She only texts first when the chat has been closed and quiet for a while
// How long and how often come from the settings page (server/config.js)
const CHECK_EVERY_MS = 60000;
const CHANCE_PER_CHECK = 1 / 45;       // roughly once in 45 minutes after she becomes "eligible"
const PAGE_CLOSED_AFTER_MS = 3 * 60000;
// The page beats every 15 s while it's on screen. A locked phone often can't say "hidden" first
// (the page is frozen), so two missed beats already count as nobody looking
const VIEW_STALE_MS = 40000;
// When answering fails (brain not logged in, offline), wait longer each time instead of
// starting Claude every minute and burning through the quota
const RETRY_BASE_MS = 2 * 60000;
const RETRY_MAX_MS = 60 * 60000;
// No answer yet: a friend texts once, asks again the next day, checks in once more, then waits.
// Hours since her last unanswered text before each follow-up (the first one uses awayPingHours)
const FOLLOW_UP_HOURS = [ 20, 44 ];
const MAX_UNANSWERED = 1 + FOLLOW_UP_HOURS.length;

/* ------------------------------------ presence */

// Only one tab or device of each user holds the chat at a time; their others show "open elsewhere".
// Each user has their own: one person looking at the app says nothing about anyone else.
const presences = new Map();
const presenceOf = (user = currentUser()) => {
    if (!presences.has(user)) presences.set(user, { clientId: "", lastBeatAt: 0, isVisible: true });
    return presences.get(user);
};

export function claim(clientId) {
    const presence = presenceOf();
    presence.clientId = String(clientId ?? "").slice(0, 64);
    presence.lastBeatAt = Date.now();
    presence.isVisible = true;
}

/** @returns {boolean} whether this client still holds the chat */
export function beat(clientId, isVisible = true) {
    const presence = presenceOf();
    const id = String(clientId ?? "");
    if (!presence.clientId || Date.now() - presence.lastBeatAt > PAGE_CLOSED_AFTER_MS) presence.clientId = id;
    if (presence.clientId !== id) return false;
    presence.lastBeatAt = Date.now();
    presence.isVisible = isVisible !== false;
    return true;
}

/** This user is looking at the app right now; a push notification would only be noise */
export const isBeingViewed = (user = currentUser()) => {
    const presence = presenceOf(user);
    return presence.isVisible && Date.now() - presence.lastBeatAt < VIEW_STALE_MS;
};

export const isActiveClient = (clientId) => {
    const presence = presenceOf();
    return !presence.clientId || presence.clientId === String(clientId ?? "");
};

/* ------------------------------------ scheduler */

const today = () => new Date().toLocaleDateString("sv-SE");

/**
 * Closed chat with messages still waiting: she reads them when she'd have picked up her phone,
 * and her answer is there the next time you open the chat. Sleep waits until she wakes.
 */
// Backoff per character: one character's brain failing shouldn't hold up the others
const failures = new Map();

async function answerWhileClosed({ planReply, pending, reply }) {
    const failure = failures.get(currentKey()) ?? { count: 0, until: 0 };
    failures.set(currentKey(), failure);
    if (Date.now() < failure.until) return false;
    const list = await pending();
    if (!list.length) return false;
    const plan = await planReply({ texts: list.map((m) => m.text) });
    if (plan.isAsleep) return false;
    const oldest = Math.min(...list.map((m) => m.sentAt));
    if (Date.now() - oldest < plan.readMs + Number(plan.laterMs ?? 0)) return false;

    // Replies made here are pushed by replyToPending in server/index.js
    let result;
    try {
        result = await reply(list.map((m) => m.id), {
            activity: plan.activity ?? "",
            waitedMs: Date.now() - oldest,
        });
        failure.count = 0;
        failure.until = 0;
    } catch (err) {
        failure.count++;
        const wait = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (failure.count - 1));
        failure.until = Date.now() + wait;
        console.error(`  ⚠ ตอบข้อความที่ค้างไม่สำเร็จ (ลองใหม่ใน ${Math.round(wait / 60000)} นาที):`, err?.message ?? err);
        return true;
    }
    console.log(`  ✉ ตอบข้อความที่ค้างไว้: ${(result?.bubbles ?? []).join(" / ") || "(อ่านแล้วไม่ตอบ)"}`);
    return true;
}

/**
 * Whether she may text first now. Exported for tests.
 * @param {{ log?: object, lastSeen: number | null, awayHours: number, maxPerDay: number, now?: number }} input
 * @returns {null | { quietHours: number, unanswered: number, sinceLastMs: number | null, count: number }}
 */
export function pingDue({ log = {}, lastSeen, awayHours, maxPerDay, now = Date.now() }) {
    if (lastSeen == null || !(awayHours > 0) || !(maxPerDay > 0)) return null;
    const day = new Date(now).toLocaleDateString("sv-SE");
    const count = log?.date === day ? Number(log?.count ?? 0) : 0;
    if (count >= maxPerDay) return null;
    const quietHours = (now - lastSeen) / 3600000;
    if (quietHours < awayHours) return null;

    const lastAt = Number(log?.lastAt ?? 0);
    // Her texts since you last spoke; older logs without the counter had at most one
    const unanswered = lastAt > lastSeen ? Math.max(1, Number(log?.unanswered ?? 1)) : 0;
    if (unanswered >= MAX_UNANSWERED) return null;
    const waitHours = unanswered ? Math.max(awayHours, FOLLOW_UP_HOURS[unanswered - 1]) : awayHours;
    if (lastAt && now - lastAt < waitHours * 3600000) return null;
    return { quietHours, unanswered, sinceLastMs: unanswered ? now - lastAt : null, count };
}

/**
 * Every minute: if the chat is closed, you've been quiet for hours, she's awake,
 * she may send you something; unanswered, she follows up at most twice, a day or so apart.
 * @param {(hours: number, info: { unanswered: number, sinceLastMs: number | null }) => Promise<{ bubbles: string[] }>} send the brain's awayPing
 * @param {{ planReply: Function, pending: Function, reply: Function }} [deps] used to answer messages left waiting
 */
export function startAwayScheduler(send, deps) {
    let isBusy = false;
    setInterval(() => {
        // A reply can take longer than a minute; never start a second check on top of it
        if (isBusy) return;
        isBusy = true;
        everyCharacter().finally(() => {
            isBusy = false;
        });
    }, CHECK_EVERY_MS);

    /**
     * Each character lives her own life, in a chat with each user: the one a user has on screen waits
     * while they have it open, but the others still read and answer what they were left, and may text first.
     * Each check is pinned, so it reads and writes only that chat's files.
     */
    async function everyCharacter() {
        for (const p of await listProfiles().catch(() => [])) {
            const users = deps?.users ? await deps.users(p.id).catch(() => []) : [];
            // Without accounts there is one chat per character
            if (!deps?.users) await pinProfile(() => tick(p.id === getActiveId()), p.id, "");
            for (const user of users) {
                await pinProfile(() => tick(p.id === getActiveId()), p.id, user);
            }
        }
    }

    async function tick(isOnScreen) {
        try {
            // Her morning look-up runs in the background (still pinned to her), even while you chat
            maybeRefresh();
            // The coach's suggestions go to the person who can accept them: the owner, from their own chat
            if (await isOwnerNow()) maybeReview(complete);
            // On screen right now: the page paces her replies. Hidden or locked: the server takes over,
            // so a reply isn't stuck in a frozen tab and you get the notification
            if (isOnScreen && isBeingViewed()) return;
            if (deps && (await answerWhileClosed(deps))) return;
            // You closed the chat right after talking: what she remembers later still reaches you
            if (isAfterthoughtDue() && !(await planReply({ texts: [] })).isAsleep) {
                const later = await afterthought();
                if (later?.bubbles?.length) await deps?.onAgentMessage?.(later.bubbles.filter((_, i) => !(later.unsend ?? []).includes(i)));
                return;
            }
            const { awayPingHours: AWAY_HOURS, awayPerDay: MAX_PER_DAY } = await getConfig();
            // 0 really means off (it used to fall back to 4 hours)
            if (!(AWAY_HOURS > 0) || !(MAX_PER_DAY > 0) || Math.random() > CHANCE_PER_CHECK) return;

            const id = currentKey();
            const settings = await loadSettings();
            const log = settings?.awayPings?.[id] ?? {};
            const state = await loadState();
            const due = pingDue({ log, lastSeen: state.lastSeen, awayHours: AWAY_HOURS, maxPerDay: MAX_PER_DAY });
            if (!due) return;

            if ((await planReply({ texts: [] })).isAsleep) return;
            // Out all day or swamped: she isn't the one who texts first today
            if ([ "busy", "away", "moody" ].includes(await dayKind())) return;

            const result = await send(due.quietHours, { unanswered: due.unanswered, sinceLastMs: due.sinceLastMs });
            if (!result?.bubbles?.length) return;
            // Without a typo she took back
            await deps?.onAgentMessage?.(result.bubbles.filter((_, i) => !(result.unsend ?? []).includes(i)));
            // Read again: other settings may have changed while she was writing
            await saveSettings((latest) => ({
                awayPings: { ...(latest?.awayPings ?? {}), [id]: { date: today(), count: due.count + 1, lastAt: Date.now(), unanswered: due.unanswered + 1 } },
            }));
            console.log(`  ✉ ${result.bubbles.join(" / ")}`);
        } catch (err) {
            console.error("away message failed:", err?.message ?? err);
        }
    }
}
