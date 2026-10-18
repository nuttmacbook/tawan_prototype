/**
 * The chat rhythm: when she reads, how long she types, when she stops to look at what you sent.
 * It knows nothing about the page: everything it shows goes through `ui`, every wait through `timers`,
 * so tests can run it in Node with a fake clock.
 */
import { shouldInterrupt } from "./interrupt.js";

const MAX_NUDGES = 2;
const USER_TYPING_GRACE_MS = 2500;   // she waits this long after your last keystroke before replying
const MAX_WAIT_FOR_USER_MS = 30000;
const SKIP_POLL_MS = 250;
const FALLBACK_PLAN = { readMs: 1500, laterMs: 0, activity: "", thinkMs: 800, typingCps: 6, pauseMs: [ 400, 1200 ], reasons: [ "ไม่ได้แผนจากเซิร์ฟเวอร์" ] };

const realTimers = {
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms))),
    random: () => Math.random(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (t) => clearTimeout(t),
};

/**
 * @param {object} deps
 * @param {object} deps.api the server calls: pacing, read, chat, cut, nudge, greet
 * @param {object} deps.ui what the page does: see main.js for the full list
 * @param {() => { clientId: string, idleMinutes: number, rethinkOnInterrupt: boolean, showNotes: boolean }} deps.settings read live
 * @param {object} [deps.timers] now, sleep, random, setTimeout, clearTimeout
 */
export function createEngine({ api, ui, settings, timers = realTimers }) {
    const t = { ...realTimers, ...timers };
    const between = ([ lo, hi ] = [ 400, 1200 ]) => lo + t.random() * (hi - lo);

    const s = {
        pending: [],
        isScheduling: false,
        isReplying: false,
        isReading: false,
        userTypingUntil: 0,
        isAway: false,
        skip: false,
        seq: 0,
        // Set when you send something worth stopping for while she's typing (see interrupt.js)
        isInterrupted: false,
        // The last reply was dropped to think again; the next one is shown whatever happens
        hasRethought: false,
        nudges: 0,
        idleTimer: null,
        // Until then she's away from her phone (shower, asleep): the header shows when she was last on
        offlineUntil: 0,
    };

    /* ------------------------------------ small pieces */

    /** She looks at the chat: everything you've sent so far shows "อ่านแล้ว" */
    function glance() {
        const unread = s.pending.filter((m) => !m.isRead);
        if (!unread.length) return;
        unread.forEach((m) => {
            m.isRead = true;
        });
        ui.setReceipts(unread.map((m) => m.id), "อ่านแล้ว");
        api.read(unread.map((m) => m.id)).catch(() => {});
    }

    /** Waits like sleep(), but the debug "⏩ ข้าม" button can cut it short */
    async function waitSkippable(ms) {
        s.skip = false;
        const end = t.now() + Math.max(0, ms);
        while (t.now() < end && !s.skip) await t.sleep(Math.min(SKIP_POLL_MS, end - t.now()));
        s.skip = false;
    }

    async function getPlan(texts) {
        try {
            return await api.pacing(texts);
        } catch {
            return FALLBACK_PLAN;
        }
    }

    /**
     * She stopped typing to read your message, so the bubbles she never sent are taken back on the server too:
     * out of the log and her short-term memory, and kept as a draft she can pick up next turn.
     */
    async function cutReply(result, shown) {
        const bubbles = Array.isArray(result?.bubbles) ? result.bubbles : [];
        if (shown >= bubbles.length) return;
        ui.append("state", shown ? `✋ หยุดพิมพ์เพื่ออ่านข้อความใหม่ · ไม่ได้ส่งอีก ${bubbles.length - shown} ข้อความ` : "✋ ถูกพิมพ์แทรกก่อนส่ง · คิดคำตอบใหม่");
        try {
            await api.cut(shown, bubbles);
        } catch {}
    }

    const setOffline = (ms) => {
        s.offlineUntil = Math.max(s.offlineUntil, t.now() + Math.max(0, ms));
    };

    /* ------------------------------------ her typing */

    /**
     * Shows her reply one bubble at a time. Typing time follows the plan's speed;
     * time already spent waiting for the server counts as typing for the first bubble.
     * Between bubbles she glances at the chat: if you've sent something worth stopping for,
     * she doesn't type the rest, looks for a moment, and returns how many bubbles she showed.
     * @returns {Promise<number>} bubbles shown
     */
    async function speak(result, plan, startedAt = t.now()) {
        if (settings().showNotes) ui.append("notes", result?.notes ?? []);
        const bubbles = Array.isArray(result?.bubbles) ? result.bubbles : [];
        const unsend = new Set(Array.isArray(result?.unsend) ? result.unsend : []);
        const cps = Number(plan?.typingCps) || 6;
        const canAnimate = !ui.isReducedMotion?.();

        for (const [ i, text ] of bubbles.entries()) {
            let typingMs = Math.min(9000, Math.max(600, (text.length / cps) * 1000));

            if (i === 0 && result?.hesitate && canAnimate) {
                // Started typing, stopped, thought again, and started over
                ui.setTyping(false);
                await t.sleep(between([ 1500, 4000 ]));
                ui.setTyping(true);
            } else if (i === 0) {
                typingMs -= t.now() - startedAt;
            } else {
                ui.setTyping(false);
                glance();
                if (s.isInterrupted) {
                    // The dots go away while she reads, like a person who stopped mid-thought
                    await t.sleep(between([ 900, 2200 ]));
                    ui.renderStatus(result?.status);
                    return i;
                }
                await t.sleep(between(plan?.pauseMs));
                ui.setTyping(true);
            }

            // Long messages sometimes get a pause mid-typing, the way people stop to think
            if (canAnimate && typingMs > 2500 && t.random() < 0.3) {
                await t.sleep(typingMs * 0.45);
                ui.setTyping(false);
                await t.sleep(500 + t.random() * 900);
                ui.setTyping(true);
                typingMs *= 0.55;
            }

            if (canAnimate) await t.sleep(typingMs);
            ui.setTyping(false);
            const shown = ui.showBubble(text);
            ui.markSeen();

            if (unsend.has(i)) {
                // Spotted the typo, took it back; the corrected bubble comes next
                await t.sleep(between([ 1200, 3000 ]));
                ui.unsendBubble(shown);
            } else {
                ui.notify(text);
            }
            if (i < bubbles.length - 1) ui.setTyping(true);
        }

        ui.setTyping(false);
        ui.renderStatus(result?.status);
        return bubbles.length;
    }

    /* ------------------------------------ reading and replying */

    /**
     * Starts the "she'll see it in a moment" wait. Messages sent before she reads
     * just join the same batch, so a burst of messages gets one reply.
     */
    async function schedule() {
        if (s.isReplying || s.isReading || s.isScheduling || !s.pending.length) return;
        s.isScheduling = true;
        let plan = await getPlan(s.pending.map((m) => m.text));
        s.isScheduling = false;
        if (s.isReplying || s.isReading) return;

        // She already saw these while typing; if she now steps away it's "read, reply later", not unread
        if (plan.activity && !(plan.laterMs > 0) && s.pending.every((m) => m.isRead)) {
            plan = { ...plan, laterMs: plan.readMs, readMs: 300 };
        }

        ui.append("pacing", plan);
        // Phone down or asleep: she isn't online until she comes back to it
        if (plan.phoneAway || plan.isAsleep) {
            setOffline(plan.readMs);
            ui.setPresence();
        }
        s.isReading = true;
        await waitSkippable(plan.readMs);
        s.isReading = false;
        s.offlineUntil = 0;
        await reply(plan);
    }

    /**
     * She opens the chat. Depending on the plan she replies now, reads and comes back later,
     * or (her choice, via the brain) reads and doesn't reply at all.
     */
    async function reply(plan) {
        s.isReplying = true;
        stopIdle();

        const firstSentAt = Math.min(...s.pending.map((m) => m.sentAt));
        glance();
        const readAt = t.now();
        ui.markSeen();
        ui.setPresence("online");

        // Read it, but busy: she puts the phone down and answers when she's free
        if (Number(plan?.laterMs) > 0) {
            s.isAway = true;
            ui.append("state", `👀 อ่านแล้วแต่${plan.activity || "ยังไม่ว่าง"} · จะกลับมาตอบใน ~${(plan.laterMs / 60000).toFixed(1)} นาที`, { canSkip: true });
            setOffline(plan.laterMs);
            ui.setPresence();
            await waitSkippable(plan.laterMs);
            s.offlineUntil = 0;
            s.isAway = false;
            ui.markSeen();
            glance();
        }

        // If you're still typing she waits for you to finish, reading as you go
        const waitUntil = t.now() + MAX_WAIT_FOR_USER_MS;
        while (t.now() < s.userTypingUntil && t.now() < waitUntil) {
            await t.sleep(400);
            glance();
        }

        glance();
        const batch = s.pending.splice(0);
        // Only what you send from here on can make her stop typing; this batch is what she's answering
        s.isInterrupted = false;
        if (!batch.length) {
            s.isReplying = false;
            return;
        }

        await t.sleep(plan.thinkMs);
        ui.setTyping(true);
        const startedAt = t.now();

        try {
            const result = await api.chat(batch.map((m) => m.id), {
                clientId: settings().clientId,
                activity: plan.activity,
                readAgoMs: Number(plan?.laterMs) > 0 ? t.now() - readAt : 0,
                waitedMs: t.now() - firstSentAt,
            });
            // Her reaction lands on the last message of the batch, like a long-press heart
            if (result?.reaction) ui.showReaction(batch.at(-1)?.id, result.reaction);
            if (!result?.bubbles?.length) ui.append("state", result?.reaction ? `${result.reaction} กดรีแอคแทนการตอบ` : "🙊 อ่านแล้วไม่ตอบ");

            // Optional (style.md "คิดใหม่เมื่อถูกพิมพ์แทรก"): you wrote something important before her first bubble
            // appeared, so she drops this answer and replies to everything together. Costs one more brain call.
            // Once in a row at most: a stream of messages shouldn't throw away reply after reply
            if (s.isInterrupted && settings().rethinkOnInterrupt && !s.hasRethought && result?.bubbles?.length) {
                s.hasRethought = true;
                ui.setTyping(false);
                glance();
                await cutReply(result, 0);
                ui.renderStatus(result?.status);
                return;
            }
            s.hasRethought = false;
            await cutReply(result, await speak(result, plan, startedAt));
        } catch (err) {
            ui.setTyping(false);
            ui.markFailed(batch, err);
        } finally {
            s.isReplying = false;
            s.isInterrupted = false;
            // She's still in the chat when she finishes, so she sees what you sent meanwhile
            if (!s.isAway) glance();
            ui.setPresence();
            armIdle();
            // Anything you sent while she was busy or typing gets its own turn now
            if (s.pending.length) schedule();
        }
    }

    /* ------------------------------------ she talks first */

    function stopIdle() {
        t.clearTimeout(s.idleTimer);
        s.idleTimer = null;
    }

    /** After a quiet while she may nudge you, up to MAX_NUDGES times in a row */
    function armIdle() {
        stopIdle();
        const minutes = Number(settings().idleMinutes);
        if (!(minutes > 0) || s.nudges >= MAX_NUDGES) return;

        s.idleTimer = t.setTimeout(async () => {
            s.idleTimer = null;
            if (s.isReplying || s.isReading || s.pending.length) return armIdle();
            s.nudges++;
            s.isReplying = true;
            try {
                const plan = await getPlan([]);
                s.isInterrupted = false;
                // You wrote meanwhile: answer that instead of nudging
                const result = plan.isAsleep || s.pending.length ? null : await api.nudge(minutes * s.nudges);
                if (result?.bubbles?.length) {
                    ui.setTyping(true);
                    await cutReply(result, await speak(result, plan, t.now()));
                }
            } catch (err) {
                console.error(err);
            } finally {
                s.isReplying = false;
                s.isInterrupted = false;
                ui.setPresence();
                armIdle();
                // A message sent while she was nudging waited for her to finish; answer it now
                if (s.pending.length) schedule();
            }
        }, minutes * 60000);
    }

    /** When you open the chat she may say hi, unless she's asleep or has your messages to answer */
    async function greet() {
        s.isReplying = true;
        try {
            const plan = await getPlan([]);
            s.isInterrupted = false;
            const result = plan.isAsleep || s.pending.length ? null : await api.greet();
            if (result?.bubbles?.length) {
                await t.sleep(plan.thinkMs);
                ui.setTyping(true);
                await cutReply(result, await speak(result, plan, t.now()));
            }
        } catch (err) {
            ui.setTyping(false);
            ui.append("error", err?.message ?? String(err));
        } finally {
            s.isReplying = false;
            s.isInterrupted = false;
            ui.setPresence();
            armIdle();
            if (s.pending.length) schedule();
        }
    }

    /* ------------------------------------ what the page calls */

    return {
        state: s,
        speak,
        glance,
        armIdle,
        stopIdle,
        greet,
        schedule,

        /** A new id for a message you're about to send */
        nextId: () => `m${t.now().toString(36)}${t.random().toString(36).slice(2, 6)}${s.seq++}`,

        /** Your message reached the server: she'll read it when the plan says so */
        add({ id, text, sentAt = t.now(), isRead = false }) {
            s.pending.push({ id, text, sentAt, isRead });
            if (!isRead) ui.setReceipts([ id ], "ส่งแล้ว");
            if (s.isReplying && !s.isAway && shouldInterrupt(text)) s.isInterrupted = true;
            s.nudges = 0;
            if (!s.isReplying) stopIdle();
            schedule();
        },

        /** Messages left waiting from before a refresh; answered after greet() */
        restore(list) {
            for (const m of list ?? []) s.pending.push({ id: m.id, text: m.text, sentAt: m.sentAt, isRead: Boolean(m.readAt) });
        },

        remove: (id) => {
            s.pending = s.pending.filter((m) => m.id !== id);
        },
        find: (id) => s.pending.find((m) => m.id === id),
        skip: () => {
            s.skip = true;
        },
        /** You're typing: she holds her reply until you pause */
        userTyping: (isTyping) => {
            s.userTypingUntil = isTyping ? t.now() + USER_TYPING_GRACE_MS : 0;
        },
        isBusy: () => s.isReplying || s.isReading,
        isOffline: () => t.now() < s.offlineUntil,
    };
}
