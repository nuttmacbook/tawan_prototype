import { loadState } from "./mood.js";
import { planReply } from "./pacing.js";
import { loadSettings, saveSettings, getActiveId } from "./profiles.js";

/* ------------------------------------ config */

// She only texts first when the chat has been closed and quiet for a while
const AWAY_HOURS = Number(process.env.AWAY_PING_HOURS ?? 4) || 4;
const MAX_PER_DAY = 2;
const CHECK_EVERY_MS = 60000;
const CHANCE_PER_CHECK = 1 / 45;       // roughly once in 45 minutes after she becomes "eligible"
const PAGE_CLOSED_AFTER_MS = 3 * 60000;

/* ------------------------------------ presence */

// Only one tab or device holds the chat at a time; the others show "open elsewhere"
const presence = { clientId: "", lastBeatAt: 0, isVisible: true };

export function claim(clientId) {
    presence.clientId = String(clientId ?? "").slice(0, 64);
    presence.lastBeatAt = Date.now();
    presence.isVisible = true;
}

/** @returns {boolean} whether this client still holds the chat */
export function beat(clientId, isVisible = true) {
    const id = String(clientId ?? "");
    if (!presence.clientId || Date.now() - presence.lastBeatAt > PAGE_CLOSED_AFTER_MS) presence.clientId = id;
    if (presence.clientId !== id) return false;
    presence.lastBeatAt = Date.now();
    presence.isVisible = isVisible !== false;
    return true;
}

/** Someone is looking at the chat right now; a push notification would only be noise */
export const isBeingViewed = () => isChatOpen() && presence.isVisible;

export const isActiveClient = (clientId) => !presence.clientId || presence.clientId === String(clientId ?? "");
const isChatOpen = () => Date.now() - presence.lastBeatAt < PAGE_CLOSED_AFTER_MS;

/* ------------------------------------ scheduler */

const today = () => new Date().toLocaleDateString("sv-SE");

/**
 * Closed chat with messages still waiting: she reads them when she'd have picked up her phone,
 * and her answer is there the next time you open the chat. Sleep waits until she wakes.
 */
async function answerWhileClosed({ planReply, pending, reply }) {
    const list = await pending();
    if (!list.length) return false;
    const plan = await planReply({ texts: list.map((m) => m.text) });
    if (plan.isAsleep) return false;
    const oldest = Math.min(...list.map((m) => m.sentAt));
    if (Date.now() - oldest < plan.readMs + Number(plan.laterMs ?? 0)) return false;

    // Replies made here are pushed by replyToPending in server/index.js
    const result = await reply(list.map((m) => m.id), {
        activity: plan.activity ?? "",
        waitedMs: Date.now() - oldest,
    });
    console.log(`  ✉ ตอบข้อความที่ค้างไว้: ${(result?.bubbles ?? []).join(" / ") || "(อ่านแล้วไม่ตอบ)"}`);
    return true;
}

/**
 * Every minute: if the chat is closed, you've been quiet for hours, she's awake,
 * and she hasn't already texted without an answer, she may send you something.
 * @param {(hours: number) => Promise<{ bubbles: string[] }>} send the brain's awayPing
 * @param {{ planReply: Function, pending: Function, reply: Function }} [deps] used to answer messages left waiting
 */
export function startAwayScheduler(send, deps) {
    setInterval(async () => {
        try {
            if (isChatOpen()) return;
            if (deps && (await answerWhileClosed(deps))) return;
            if (!(AWAY_HOURS > 0) || Math.random() > CHANCE_PER_CHECK) return;

            const id = getActiveId();
            const settings = await loadSettings();
            const log = settings?.awayPings?.[id] ?? {};
            const count = log.date === today() ? Number(log.count ?? 0) : 0;
            if (count >= MAX_PER_DAY) return;

            const state = await loadState();
            if (state.lastSeen == null) return;
            const quietHours = (Date.now() - state.lastSeen) / 3600000;
            if (quietHours < AWAY_HOURS) return;

            // One unanswered text is enough; real friends don't keep texting into silence
            if (Number(log.lastAt ?? 0) > state.lastSeen) return;
            if (Date.now() - Number(log.lastAt ?? 0) < AWAY_HOURS * 3600000) return;

            if ((await planReply({ texts: [] })).isAsleep) return;

            const result = await send(quietHours);
            if (!result?.bubbles?.length) return;
            await deps?.onAgentMessage?.(result.bubbles);
            await saveSettings({
                awayPings: { ...(settings?.awayPings ?? {}), [id]: { date: today(), count: count + 1, lastAt: Date.now() } },
            });
            console.log(`  ✉ ${result.bubbles.join(" / ")}`);
        } catch (err) {
            console.error("away message failed:", err?.message ?? err);
        }
    }, CHECK_EVERY_MS);
}
