import "./main.css";
import { api } from "./api.js";
import { header, brainPicker, subline, fullRoleButton, remoteLinks } from "./components/header.js";
import { chatPanel, bubble, note, typing, errorLine, statusAside, pacingNote, stateNote, correctionForm, previewOf, divider, unsentLine } from "./components/chat.js";
import { teachPanel, lessonList, snapshotList, FILES } from "./components/teach.js";
import { overlays, searchResults } from "./components/overlays.js";
import { logicPanel, logicEvent, backupList, logicWorking } from "./components/logic.js";
import { esc } from "./components/ui.js";
import { shouldInterrupt } from "./interrupt.js";

/* ------------------------------------ state */

const MAX_NUDGES = 2;
const USER_TYPING_GRACE_MS = 2500;   // she waits this long after your last keystroke before replying
const MAX_WAIT_FOR_USER_MS = 30000;
const IN_CHAT_MS = 120000;           // matches PACING.inChatWindowMs on the server
const FALLBACK_PLAN = { readMs: 1500, laterMs: 0, activity: "", thinkMs: 800, typingCps: 6, pauseMs: [ 400, 1200 ], reasons: [ "ไม่ได้แผนจากเซิร์ฟเวอร์" ] };

const state = {
    name: "",
    tab: "chat",
    brain: null,
    status: null,
    teachings: [],
    file: "persona",
    isFileDirty: false,
    showNotes: readPref("showNotes", true),
    isFullRole: readPref("fullRole", true),
    idleMinutes: 15,
    nudges: 0,
    profileId: "",
    profiles: [],
    isLocal: true,
    lan: null,
    snapshots: [],
    replyTo: "",
    editing: "",
    oldestDate: new Date().toLocaleDateString("sv-SE"),
    hasOlder: true,
    isLoadingOlder: false,
    clientId: makeClientId(),
    isElsewhere: false,
    pushSub: null,
    lastSeenAgentAt: 0,
    codePath: "server/pacing.js",
    isCodeDirty: false,
    backups: [],
    logicNext: 0,
    isLogicPolling: false,
    rethinkOnInterrupt: false,
};

/** The conversation engine: what you've sent, what she's read, and whether she's busy replying */
const engine = {
    pending: [],
    isScheduling: false,
    isReplying: false,
    readTimer: null,
    userTypingUntil: 0,
    isAway: false,
    skip: false,
    seq: 0,
    // Set when you send something worth stopping for while she's typing (see src/interrupt.js)
    isInterrupted: false,
};

/** She looks at the chat: everything you've sent so far shows "อ่านแล้ว" */
function glance() {
    const unread = engine.pending.filter((m) => !m.isRead);
    if (!unread.length) return;
    unread.forEach((m) => {
        m.isRead = true;
    });
    setReceipts(unread.map((m) => m.id), "อ่านแล้ว");
    api.read(unread.map((m) => m.id)).catch(() => {});
}

/**
 * She stopped typing to read your message, so the bubbles she never sent are taken back on the server too:
 * out of the log and her short-term memory, and kept as a draft she can pick up next turn.
 */
async function cutReply(result, shown) {
    const bubbles = Array.isArray(result?.bubbles) ? result.bubbles : [];
    if (shown >= bubbles.length) return;
    append(stateNote(shown ? `✋ หยุดพิมพ์เพื่ออ่านข้อความใหม่ · ไม่ได้ส่งอีก ${bubbles.length - shown} ข้อความ` : "✋ ถูกพิมพ์แทรกก่อนส่ง · คิดคำตอบใหม่"));
    try {
        await api.cut(shown, bubbles);
    } catch {}
}

/** Browser storage can be blocked; preferences just fall back to defaults then */
function readPref(key, fallback) {
    try {
        const v = localStorage.getItem(`persona:${key}`);
        return v == null ? fallback : JSON.parse(v);
    } catch {
        return fallback;
    }
}

function writePref(key, value) {
    try {
        localStorage.setItem(`persona:${key}`, JSON.stringify(value));
    } catch {}
}

const $ = (sel) => document.querySelector(sel);
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const between = ([ lo, hi ] = [ 400, 1200 ]) => lo + Math.random() * (hi - lo);

/* ------------------------------------ render */

function paint() {
    const app = document.getElementById("app");
    if (!app) return;
    document.documentElement.classList.toggle("full-role", state.isFullRole);
    app.innerHTML = /*html*/`
        <div class="mx-auto flex h-full w-full max-w-6xl flex-col gap-3 px-4 py-3 sm:px-6 sm:py-5">
            ${header(state)}
            ${chatPanel(state)}
            ${teachPanel(state)}
            ${logicPanel(state)}
        </div>
        ${overlays}
    `;
}

function renderStatus() {
    const html = statusAside(state.status);
    const desktop = $("[data-status]");
    const mobile = $("[data-status-mobile]");
    if (desktop) desktop.innerHTML = html;
    if (mobile) mobile.innerHTML = html;
    const line = $("[data-subline]");
    if (line) line.innerHTML = subline(state.status);
}

function renderBrain() {
    const el = $("[data-brain]");
    if (el) el.innerHTML = brainPicker(state.brain);
}

function renderLessons() {
    const el = $("[data-lessons]");
    if (el) el.innerHTML = lessonList(state.teachings);
    const count = $("[data-lesson-count]");
    if (count) count.textContent = String(state.teachings.length);
}

function renderName() {
    const el = $("[data-name]");
    if (el) el.textContent = state.name;
    const input = $("[data-chat-input]");
    if (input) input.placeholder = `พิมพ์คุยกับ ${state.name}...`;
}

/* ------------------------------------ presence (header line) */

/** "ออนไลน์" / "กำลังพิมพ์..." / "ใช้งานเมื่อ 5 นาทีที่แล้ว", like a messaging app */
function setPresence(mode) {
    const el = $("[data-presence]");
    const dot = $("[data-online-dot]");
    let text = "ออนไลน์";
    let isOnline = true;

    if (mode === "typing") {
        text = "กำลังพิมพ์...";
    } else if (mode !== "online") {
        const away = Date.now() - state.lastSeenAgentAt;
        isOnline = state.lastSeenAgentAt > 0 && away < IN_CHAT_MS;
        const min = Math.round(away / 60000);
        if (!isOnline) text = state.lastSeenAgentAt ? `ใช้งานเมื่อ ${min < 60 ? `${Math.max(1, min)} นาที` : `${Math.round(min / 60)} ชั่วโมง`}ที่แล้ว` : "ออฟไลน์";
    }

    if (el) el.textContent = text;
    dot?.classList.toggle("bg-emerald-400", isOnline);
    dot?.classList.toggle("bg-slate-500", !isOnline);
}

const markSeen = () => {
    state.lastSeenAgentAt = Date.now();
};

/* ------------------------------------ chat output */

const messagesEl = () => $("[data-messages]");

/** Only follow new messages when the reader is already near the bottom */
const scrollDown = (force = false) => {
    const el = messagesEl();
    if (!el) return;
    const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 160;
    if (force || isNearBottom) el.scrollTop = el.scrollHeight;
};

function append(html, force = false) {
    const typingEl = $("[data-typing]");
    // Keep the typing dots as the last row while she's typing
    if (typingEl) typingEl.insertAdjacentHTML("beforebegin", html);
    else messagesEl()?.insertAdjacentHTML("beforeend", html);
    scrollDown(force);
}

function setTyping(isOn) {
    $("[data-typing]")?.remove();
    if (isOn) {
        messagesEl()?.insertAdjacentHTML("beforeend", typing(state.name));
        scrollDown();
        setPresence("typing");
    } else {
        setPresence(engine.isReplying ? "online" : undefined);
    }
}

/** Receipts beside your bubbles: "ส่งแล้ว" until she opens the chat, then "อ่านแล้ว" on each one, like LINE */
function setReceipts(ids, text) {
    for (const id of ids) {
        const el = document.querySelector(`[data-receipt="${id}"]`);
        if (el) el.textContent = text;
    }
}

const clock = () => new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

/** Waits like sleep(), but the debug "⏩ ข้าม" button can cut it short */
async function waitSkippable(ms) {
    engine.skip = false;
    const end = Date.now() + Math.max(0, ms);
    while (Date.now() < end && !engine.skip) await sleep(250);
    engine.skip = false;
}

/**
 * A failed send means the message never reached the server; a failed reply means it's saved
 * but she couldn't answer yet. Both retry with the same id, so nothing is duplicated.
 */
function markFailed(batch, err, { isSendFailure = false } = {}) {
    const label = isSendFailure ? "⚠ ส่งไม่สำเร็จ · แตะเพื่อส่งใหม่" : "⚠ ยังไม่ได้คำตอบ · แตะเพื่อลองใหม่";
    for (const m of batch) {
        const el = document.querySelector(`[data-receipt="${m.id}"]`);
        if (el) {
            el.innerHTML = `<button type="button" class="text-rose-300 hover:text-rose-200" onclick="retryMessage('${m.id}')">${label}</button>`;
            el.dataset.text = m.text;
        }
    }
    append(errorLine(err?.message ?? String(err)));
}

/**
 * Shows her reply one bubble at a time. Typing time follows the plan's speed;
 * time already spent waiting for the server counts as typing for the first bubble.
 * Between bubbles she glances at the chat: if you've sent something worth stopping for,
 * she doesn't type the rest, looks for a moment, and returns how many bubbles she showed.
 * @returns {Promise<number>} bubbles shown
 */
async function speak(result, plan, startedAt = Date.now()) {
    if (state.showNotes) (result?.notes ?? []).forEach((n) => append(note(n)));
    const bubbles = Array.isArray(result?.bubbles) ? result.bubbles : [];
    const cps = Number(plan?.typingCps) || 6;
    const canAnimate = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    for (const [ i, text ] of bubbles.entries()) {
        let typingMs = Math.min(9000, Math.max(600, (text.length / cps) * 1000));

        if (i === 0) {
            typingMs -= Date.now() - startedAt;
        } else {
            setTyping(false);
            glance();
            if (engine.isInterrupted) {
                // The dots go away while she reads, like a person who stopped mid-thought
                await sleep(between([ 900, 2200 ]));
                if (result?.status) {
                    state.status = result.status;
                    renderStatus();
                }
                return i;
            }
            await sleep(between(plan?.pauseMs));
            setTyping(true);
        }

        // Long messages sometimes get a pause mid-typing, the way people stop to think
        if (canAnimate && typingMs > 2500 && Math.random() < 0.3) {
            await sleep(typingMs * 0.45);
            setTyping(false);
            await sleep(500 + Math.random() * 900);
            setTyping(true);
            typingMs *= 0.55;
        }

        if (canAnimate) await sleep(typingMs);
        setTyping(false);
        append(bubble("agent", text, { time: clock() }));
        notify(text);
        markSeen();
        if (i < bubbles.length - 1) setTyping(true);
    }

    setTyping(false);
    if (result?.status) {
        state.status = result.status;
        renderStatus();
    }
    return bubbles.length;
}

/* ------------------------------------ engine */

async function getPlan(texts) {
    try {
        return await api.pacing(texts);
    } catch {
        return FALLBACK_PLAN;
    }
}

/**
 * Starts the "she'll see it in a moment" wait. Messages sent before she reads
 * just join the same batch, so a burst of messages gets one reply.
 */
async function schedule() {
    if (engine.isReplying || engine.readTimer || engine.isScheduling || !engine.pending.length) return;
    engine.isScheduling = true;
    let plan = await getPlan(engine.pending.map((m) => m.text));
    engine.isScheduling = false;
    if (engine.isReplying || engine.readTimer) return;

    // She already saw these while typing; if she now steps away it's "read, reply later", not unread
    if (plan.activity && !(plan.laterMs > 0) && engine.pending.every((m) => m.isRead)) {
        plan = { ...plan, laterMs: plan.readMs, readMs: 300 };
    }

    append(pacingNote(plan));
    engine.readTimer = true;
    await waitSkippable(plan.readMs);
    engine.readTimer = null;
    reply(plan);
}

/**
 * She opens the chat. Depending on the plan she replies now, reads and comes back later,
 * or (her choice, via the brain) reads and doesn't reply at all.
 */
async function reply(plan) {
    engine.isReplying = true;
    clearTimeout(idleTimer);

    const firstSentAt = Math.min(...engine.pending.map((m) => m.sentAt));
    glance();
    const readAt = Date.now();
    markSeen();
    setPresence("online");

    // Read it, but busy: she puts the phone down and answers when she's free
    if (Number(plan?.laterMs) > 0) {
        engine.isAway = true;
        append(stateNote(`👀 อ่านแล้วแต่${plan.activity || "ยังไม่ว่าง"} · จะกลับมาตอบใน ~${(plan.laterMs / 60000).toFixed(1)} นาที`, { canSkip: true }));
        await waitSkippable(plan.laterMs);
        engine.isAway = false;
        markSeen();
        glance();
    }

    // If you're still typing she waits for you to finish, reading as you go
    const waitUntil = Date.now() + MAX_WAIT_FOR_USER_MS;
    while (Date.now() < engine.userTypingUntil && Date.now() < waitUntil) {
        await sleep(400);
        glance();
    }

    glance();
    const batch = engine.pending.splice(0);
    // Only what you send from here on can make her stop typing; this batch is what she's answering
    engine.isInterrupted = false;
    if (!batch.length) {
        engine.isReplying = false;
        return;
    }

    await sleep(plan.thinkMs);
    setTyping(true);
    const startedAt = Date.now();

    try {
        const result = await api.chat(batch.map((m) => m.id), {
            clientId: state.clientId,
            activity: plan.activity,
            readAgoMs: Number(plan?.laterMs) > 0 ? Date.now() - readAt : 0,
            waitedMs: Date.now() - firstSentAt,
        });
        // Her reaction lands on the last message of the batch, like a long-press heart
        if (result?.reaction) showReaction(batch.at(-1)?.id, result.reaction);
        if (!result?.bubbles?.length) append(stateNote(result?.reaction ? `${result.reaction} กดรีแอคแทนการตอบ` : "🙊 อ่านแล้วไม่ตอบ"));

        // Optional (style.md "คิดใหม่เมื่อถูกพิมพ์แทรก"): you wrote something important before her first bubble
        // appeared, so she drops this answer and replies to everything together. Costs one more brain call.
        if (engine.isInterrupted && state.rethinkOnInterrupt && result?.bubbles?.length) {
            setTyping(false);
            glance();
            await cutReply(result, 0);
            if (result?.status) {
                state.status = result.status;
                renderStatus();
            }
            return;
        }
        await cutReply(result, await speak(result, plan, startedAt));
    } catch (err) {
        setTyping(false);
        markFailed(batch, err);
    } finally {
        engine.isReplying = false;
        engine.isInterrupted = false;
        // She's still in the chat when she finishes, so she sees what you sent meanwhile
        if (!engine.isAway) glance();
        setPresence();
        armIdle();
        // Anything you sent while she was busy or typing gets its own turn now
        if (engine.pending.length) schedule();
    }
}

/* ------------------------------------ idle nudges */

let idleTimer = null;

function armIdle() {
    clearTimeout(idleTimer);
    if (!(state.idleMinutes > 0) || state.nudges >= MAX_NUDGES) return;

    idleTimer = setTimeout(async () => {
        if (engine.isReplying || engine.readTimer || engine.pending.length) return armIdle();
        state.nudges++;
        engine.isReplying = true;
        try {
            const plan = await getPlan([]);
            engine.isInterrupted = false;
            const result = plan.isAsleep ? null : await api.nudge(state.idleMinutes * state.nudges);
            if (result?.bubbles?.length) {
                setTyping(true);
                await cutReply(result, await speak(result, plan, Date.now()));
            }
        } catch (err) {
            console.error(err);
        } finally {
            engine.isReplying = false;
            setPresence();
            armIdle();
        }
    }, state.idleMinutes * 60000);
}

// Keeps "ใช้งานเมื่อ ... ที่แล้ว" fresh
setInterval(() => {
    if (!engine.isReplying && !$("[data-typing]")) setPresence();
}, 30000);

/* ------------------------------------ window handlers: chat */

if (typeof window !== "undefined") {
    window.switchTab = (id) => {
        if (state.isFullRole && id !== "chat") return;
        state.tab = id;
        document.querySelectorAll("[data-tab-panel]").forEach((el) => el.classList.toggle("hidden", el.dataset.tabPanel !== id));
        document.querySelectorAll("[data-tab-btn]").forEach((el) => el.setAttribute("aria-selected", String(el.dataset.tabBtn === id)));
        if (id === "teach" && !$("[data-file-text]")?.value) window.openFile(state.file);
        if (id === "teach") {
            refreshSnapshots();
            refreshBackupInfo();
        }
        if (id === "logic") loadLogic();
        if (id === "chat") $("[data-chat-input]")?.focus();
    };

    window.toggleFullRole = () => {
        state.isFullRole = !state.isFullRole;
        writePref("fullRole", state.isFullRole);
        document.documentElement.classList.toggle("full-role", state.isFullRole);
        const slot = $("[data-full-role-slot]");
        if (slot) slot.innerHTML = fullRoleButton(state.isFullRole);
        if (state.isFullRole && state.tab !== "chat") window.switchTab("chat");
    };

    window.addEventListener("keydown", (e) => {
        if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "f") {
            e.preventDefault();
            window.toggleFullRole();
        }
    });

    window.autoGrow = (el) => {
        el.style.height = "auto";
        el.style.height = `${Math.min(el.scrollHeight, 144)}px`;
    };

    // Typing tells her you're not done yet, so she holds her reply
    window.onChatInput = (el) => {
        window.autoGrow(el);
        if (el.value.trim()) engine.userTypingUntil = Date.now() + USER_TYPING_GRACE_MS;
    };

    // Enter sends, Shift+Enter adds a new line; skip while composing Thai with an IME
    window.onChatKey = (e) => {
        if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
            e.preventDefault();
            window.sendMessage();
        }
    };

    /** Never blocks: you can keep sending while she reads or types, like a real chat */
    window.sendMessage = (e) => {
        e?.preventDefault?.();
        const input = $("[data-chat-input]");
        const typed = input?.value?.trim();
        if (!typed) return;

        input.value = "";
        window.autoGrow(input);
        engine.userTypingUntil = 0;
        if (state.editing) saveEdit(state.editing, typed);
        else queueMessage(withReply(typed));
        input.focus();
    };

    window.sendSticker = (emoji) => {
        window.toggleStickers(false);
        queueMessage(withReply(emoji));
    };

    /** Shrinks the picture in the browser first, so phones don't upload 10MB photos */
    window.pickImage = async (input) => {
        const file = input?.files?.[0];
        input.value = "";
        if (!file) return;
        try {
            const data = await shrinkImage(file);
            const { name } = await api.upload(data);
            queueMessage(withReply(`[รูป:${name}]`));
        } catch (err) {
            append(errorLine(`ส่งรูปไม่สำเร็จ: ${err.message}`));
        }
    };
}

/** Adds the "replying to" prefix when a reply is pending, then clears it */
function withReply(text) {
    const quote = state.replyTo;
    if (!quote) return text;
    window.cancelReply();
    return `[ตอบกลับ "${quote.replace(/"/g, "'").slice(0, 60)}"] ${text}`;
}

/** Shows your message and puts it in line for her to read */
async function queueMessage(text) {
    const id = `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}${engine.seq++}`;
    append(bubble("user", text, { id, receipt: "กำลังส่ง", time: clock() }), true);
    state.nudges = 0;
    clearTimeout(idleTimer);

    // Saved on the server first, so a refresh or closed tab can't lose it
    try {
        await api.send(state.clientId, id, text);
    } catch (err) {
        markFailed([ { id, text } ], err, { isSendFailure: true });
        return;
    }

    // "อ่านแล้ว" comes when she actually looks (between bubbles, or when she's done typing),
    // not the instant it arrives; something important makes her stop typing to look
    engine.pending.push({ id, text, sentAt: Date.now(), isRead: false });
    setReceipts([ id ], "ส่งแล้ว");
    if (engine.isReplying && !engine.isAway && shouldInterrupt(text)) engine.isInterrupted = true;
    schedule();
}

if (typeof window !== "undefined") {
    window.retryMessage = async (id) => {
        const el = document.querySelector(`[data-receipt="${id}"]`);
        const text = el?.dataset?.text;
        if (!el || !text) return;
        el.textContent = "กำลังส่ง";
        try {
            // Same id: if the first send did reach the server, this doesn't duplicate it
            await api.send(state.clientId, id, text);
        } catch (err) {
            return markFailed([ { id, text } ], err, { isSendFailure: true });
        }
        el.textContent = "ส่งแล้ว";
        engine.pending.push({ id, text, sentAt: Date.now() });
        schedule();
    };

    // Debug: stop whatever she's waiting on (reading, busy, coming back later)
    window.skipWait = () => {
        engine.skip = true;
        api.clearActivity().catch(() => {});
    };

    /** Opens the "a real person would type..." box under one of her bubbles */
    window.correctBubble = (btn) => {
        const row = btn.closest(".bubble-in");
        if (!row) return;
        const next = row.nextElementSibling;
        if (next?.matches?.("[data-correction]")) return next.querySelector("textarea")?.focus();
        const original = previewOf(row.dataset.raw ?? "");
        row.insertAdjacentHTML("afterend", correctionForm(original));
        row.nextElementSibling?.querySelector("textarea")?.focus();
    };

    window.saveCorrection = async (e) => {
        e.preventDefault();
        const form = e.target;
        const msg = form.querySelector("[data-correction-msg]");

        // The user's last message before this bubble tells the example what it was answering
        let context = "";
        for (let el = form.previousElementSibling; el; el = el.previousElementSibling) {
            if (el.matches?.('[data-who="user"]')) {
                context = previewOf(el.dataset.raw ?? "");
                break;
            }
        }

        try {
            const res = await api.correctStyle(form.before.value, form.after.value, context);
            if (msg) msg.textContent = `✓ บันทึกแล้ว (มี ${res.count} ตัวอย่าง)`;
            setTimeout(() => form.remove(), 1200);
        } catch (err) {
            if (msg) msg.textContent = err.message;
        }
    };

    window.resetChat = async () => {
        if (!confirm("ล้างความจำระยะสั้นของรอบนี้? (ไฟล์ความจำยังอยู่ครบ)")) return;
        await api.reset();
        append(errorLine("ล้างความจำระยะสั้นแล้ว"));
    };

    window.toggleNotes = (isOn) => {
        state.showNotes = isOn;
        writePref("showNotes", isOn);
        document.querySelectorAll("[data-note]").forEach((el) => el.classList.toggle("hidden", !isOn));
    };

    window.setBrain = async (mode) => {
        try {
            state.brain = await api.setBrain(mode);
            renderBrain();
        } catch (err) {
            alert(err.message);
        }
    };

    window.refreshBrain = async () => {
        try {
            state.brain = await api.brain();
            renderBrain();
            $("[data-brain-menu]")?.setAttribute("open", "");
        } catch (err) {
            alert(err.message);
        }
    };
}

/* ------------------------------------ window handlers: teach */

if (typeof window !== "undefined") {
    window.pickFeeling = (word) => {
        const input = $("[data-feeling-input]");
        if (!input) return;
        const parts = input.value.split(/\s+/).filter(Boolean);
        if (!parts.includes(word)) input.value = [ ...parts, word ].join(" ");
        input.focus();
    };

    window.saveTeaching = async (e) => {
        e.preventDefault();
        const form = e.target;
        const lesson = Object.fromEntries(new FormData(form).entries());
        const msg = $("[data-teach-msg]");
        try {
            const res = await api.teach(lesson);
            state.teachings = res.teachings ?? [];
            renderLessons();
            form.reset();
            if (msg) msg.textContent = `✓ ${res.message}`;
        } catch (err) {
            if (msg) msg.textContent = err.message;
        }
    };

    window.editTeaching = (i) => {
        const t = state.teachings?.[i];
        const form = $("[data-teach-form]");
        if (!t || !form) return;
        form.trigger.value = t.trigger;
        form.feeling.value = t.feeling;
        form.response.value = t.response;
        form.example.value = t.example;
        form.scrollIntoView({ behavior: "smooth", block: "start" });
        form.response.focus();
    };

    window.deleteTeaching = async (i) => {
        const t = state.teachings?.[i];
        if (!t || !confirm(`ลบสิ่งที่สอน “${t.trigger}”?`)) return;
        try {
            state.teachings = (await api.deleteTeaching(t.trigger)).teachings ?? [];
            renderLessons();
        } catch (err) {
            alert(err.message);
        }
    };

    window.filterLessons = (q) => {
        const query = q.trim().toLowerCase();
        document.querySelectorAll("[data-lesson]").forEach((el) => {
            el.classList.toggle("hidden", Boolean(query) && !el.textContent.toLowerCase().includes(query));
        });
    };

    window.rememberFact = async (e) => {
        e.preventDefault();
        const form = e.target;
        const msg = $("[data-remember-msg]");
        try {
            const res = await api.remember(form.fact.value, form.topic.value);
            form.fact.value = "";
            if (msg) msg.textContent = `✓ ${res.message}`;
            if (state.file === "memory") window.openFile("memory");
        } catch (err) {
            if (msg) msg.textContent = err.message;
        }
    };

    window.addSamples = async (e) => {
        e.preventDefault();
        const form = e.target;
        const msg = $("[data-samples-msg]");
        try {
            const res = await api.addSamples(form.text.value, form.speaker.value);
            if (msg) msg.textContent = res.added ? `✓ เพิ่ม ${res.added} ประโยค` : "ไม่มีประโยคใหม่ที่ใช้ได้";
            if (res.added) form.text.value = "";
            if (state.file === "style") window.openFile("style");
        } catch (err) {
            if (msg) msg.textContent = err.message;
        }
    };

    window.openFile = async (name = state.file) => {
        if (state.isFileDirty && name !== state.file && !confirm("ยังไม่ได้บันทึกไฟล์นี้ จะเปลี่ยนไฟล์เลยไหม?")) return;
        state.file = name;
        document.querySelectorAll("[data-file-btn]").forEach((el) => el.setAttribute("aria-selected", String(el.dataset.fileBtn === name)));
        const hint = $("[data-file-hint]");
        if (hint) hint.textContent = FILES.find((f) => f.id === name)?.hint ?? "";

        const area = $("[data-file-text]");
        const msg = $("[data-file-msg]");
        try {
            const { text } = await api.readFile(name);
            if (area) area.value = text ?? "";
            state.isFileDirty = false;
            if (msg) msg.textContent = `data/${name}.md · มีผลทันทีในข้อความถัดไป`;
        } catch (err) {
            if (msg) msg.textContent = err.message;
        }
    };

    window.markFileDirty = () => {
        state.isFileDirty = true;
        const msg = $("[data-file-msg]");
        if (msg) msg.textContent = "● ยังไม่ได้บันทึก";
    };

    window.saveFile = async () => {
        const area = $("[data-file-text]");
        const msg = $("[data-file-msg]");
        try {
            const res = await api.writeFile(state.file, area?.value ?? "");
            state.isFileDirty = false;
            if (msg) msg.textContent = `✓ บันทึก data/${state.file}.md แล้ว`;

            // Editing these files changes what the rest of the page shows
            if (res?.name && res.name !== state.name) {
                state.name = res.name;
                renderName();
            }
            if (state.file === "teachings") {
                state.teachings = (await api.teachings()).teachings ?? [];
                renderLessons();
            }
            if (state.file === "state" || state.file === "threads") {
                state.status = await api.status();
                renderStatus();
            }
        } catch (err) {
            if (msg) msg.textContent = err.message;
        }
    };

    window.compactMemory = async () => {
        if (!confirm("ให้สรุปบทสนทนาวันก่อน ๆ และจัดระเบียบไฟล์ความจำ? (สำรองไฟล์เดิมไว้ที่ memory.backup.md)")) return;
        const btn = $("[data-compact-btn]");
        const msg = $("[data-file-msg]");
        try {
            if (btn) btn.disabled = true;
            if (msg) msg.textContent = "กำลังจัดระเบียบ...";
            const res = await api.compact();
            const parts = [];
            if (res?.days?.length) parts.push(`สรุป ${res.days.length} วัน`);
            if (res?.memory) parts.push(`ความจำ ${res.memory.before} → ${res.memory.after} บรรทัด`);
            if (msg) msg.textContent = parts.length ? `✓ ${parts.join(", ")}` : "ไม่มีอะไรต้องจัด";
            if (state.file === "memory" || state.file === "journal") window.openFile(state.file);
        } catch (err) {
            if (msg) msg.textContent = err.message;
        } finally {
            if (btn) btn.disabled = false;
        }
    };
}

/* ------------------------------------ editlogic */

function appendLogic(events) {
    const log = $("[data-logic-log]");
    if (!log || !events?.length) return;
    $("[data-logic-empty]")?.remove();
    $("[data-logic-working]")?.remove();
    log.insertAdjacentHTML("beforeend", events.map(logicEvent).join(""));
    log.scrollTop = log.scrollHeight;
}

function setLogicWorking(isOn) {
    $("[data-logic-working]")?.remove();
    const log = $("[data-logic-log]");
    if (isOn && log) {
        log.insertAdjacentHTML("beforeend", logicWorking);
        log.scrollTop = log.scrollHeight;
    }
    const btn = $("[data-logic-send]");
    if (btn) btn.disabled = isOn;
}

async function refreshBackups() {
    try {
        state.backups = (await api.logicBackups()).backups ?? [];
        const el = $("[data-backups]");
        if (el) el.innerHTML = backupList(state.backups);
    } catch {}
}

/** Polls the run log; works across page reloads because the server keeps the events */
async function pollLogic() {
    if (state.isLogicPolling) return;
    state.isLogicPolling = true;
    try {
        while (true) {
            const res = await api.logicState(state.logicNext);
            appendLogic(res.events);
            state.logicNext = res.next ?? state.logicNext;
            setLogicWorking(res.isRunning);
            if (!res.isRunning) break;
            await sleep(800);
        }
    } catch (err) {
        appendLogic([ { kind: "error", text: err.message } ]);
    } finally {
        state.isLogicPolling = false;
        refreshBackups();
        // Claude may have just changed the file that's open in the viewer
        if (!state.isCodeDirty && $("[data-code-text]")?.value) window.openCode(state.codePath);
    }
}

async function loadLogic() {
    const select = $("[data-code-select]");
    if (select && !select.options.length) {
        try {
            const { files } = await api.logicFiles();
            select.innerHTML = (files ?? []).map((f) => `<option value="${esc(f)}" ${f === state.codePath ? "selected" : ""}>${esc(f)}</option>`).join("");
            window.openCode(state.codePath);
        } catch (err) {
            const msg = $("[data-code-msg]");
            if (msg) msg.textContent = err.message;
        }
    }
    refreshBackups();
    pollLogic();
}

/** Waits for the restarted server, then reloads so the page uses the new code too */
async function waitForServer() {
    document.body.insertAdjacentHTML("beforeend", /*html*/`
        <div class="fixed inset-0 z-50 grid place-items-center bg-slate-950/80 backdrop-blur" data-restarting>
            <p class="flex items-center gap-3 rounded-2xl bg-slate-900 px-5 py-4 text-sm text-slate-200 ring-1 ring-white/10">
                <span class="flex gap-1"><span class="typing-dot h-1.5 w-1.5 rounded-full bg-sky-300"></span><span class="typing-dot h-1.5 w-1.5 rounded-full bg-sky-300"></span><span class="typing-dot h-1.5 w-1.5 rounded-full bg-sky-300"></span></span>
                กำลังรีสตาร์ทเซิร์ฟเวอร์...
            </p>
        </div>
    `);
    await sleep(1500);
    for (let i = 0; i < 60; i++) {
        try {
            await api.bootstrap();
            location.reload();
            return;
        } catch {
            await sleep(1000);
        }
    }
    $("[data-restarting]")?.remove();
    alert("เซิร์ฟเวอร์ยังไม่กลับมา ดูข้อความใน terminal ของ VS Code");
}

if (typeof window !== "undefined") {
    window.onLogicKey = (e) => {
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            window.runLogic();
        }
    };

    window.useLogicSuggestion = (btn) => {
        const input = $("[data-logic-input]");
        if (!input) return;
        input.value = btn.textContent.trim();
        input.focus();
    };

    window.runLogic = async (e) => {
        e?.preventDefault?.();
        const input = $("[data-logic-input]");
        const prompt = input?.value?.trim();
        if (!prompt) return;
        try {
            await api.logicRun(prompt);
            input.value = "";
            pollLogic();
        } catch (err) {
            appendLogic([ { kind: "error", text: err.message } ]);
        }
    };

    window.resetLogic = async () => {
        if (!confirm("เริ่มบทสนทนาใหม่กับ Claude? (โค้ดที่แก้ไปแล้วยังอยู่)")) return;
        try {
            await api.logicReset();
            state.logicNext = 0;
            const log = $("[data-logic-log]");
            if (log) log.innerHTML = `<p class="text-xs text-slate-500" data-logic-empty>เริ่มใหม่แล้ว</p>`;
        } catch (err) {
            alert(err.message);
        }
    };

    window.openCode = async (path = state.codePath) => {
        if (state.isCodeDirty && path !== state.codePath && !confirm("ยังไม่ได้บันทึกไฟล์นี้ จะเปลี่ยนไฟล์เลยไหม?")) {
            const select = $("[data-code-select]");
            if (select) select.value = state.codePath;
            return;
        }
        state.codePath = path;
        const area = $("[data-code-text]");
        const msg = $("[data-code-msg]");
        try {
            const { text } = await api.readCode(path);
            if (area) area.value = text ?? "";
            state.isCodeDirty = false;
            if (msg) msg.textContent = path;
        } catch (err) {
            if (msg) msg.textContent = err.message;
        }
    };

    window.markCodeDirty = () => {
        state.isCodeDirty = true;
        const msg = $("[data-code-msg]");
        if (msg) msg.textContent = "● ยังไม่ได้บันทึก";
    };

    window.saveCode = async () => {
        const area = $("[data-code-text]");
        const msg = $("[data-code-msg]");
        try {
            const res = await api.writeCode(state.codePath, area?.value ?? "");
            state.isCodeDirty = false;
            if (msg) msg.innerHTML = res?.needsRestart
                ? `✓ บันทึกแล้ว · <button type="button" class="text-sky-300 underline" onclick="restartServer('${esc(res.backupId)}')">รีสตาร์ทให้ใช้โค้ดใหม่</button>`
                : `✓ บันทึกแล้ว · <button type="button" class="text-sky-300 underline" onclick="location.reload()">โหลดหน้าใหม่</button>`;
            refreshBackups();
        } catch (err) {
            if (msg) msg.textContent = err.message;
        }
    };

    window.restartServer = async (backupId = "") => {
        if (state.isCodeDirty && !confirm("ยังไม่ได้บันทึกโค้ด รีสตาร์ทเลยไหม?")) return;
        try {
            await api.restart(backupId);
            await waitForServer();
        } catch (err) {
            alert(err.message);
        }
    };

    window.restoreBackup = async (id) => {
        if (!confirm(`ย้อนโค้ดระบบกลับไปที่จุด ${id}? (ความจำและบุคลิกใน data/ ไม่ถูกแตะ)`)) return;
        try {
            const res = await api.restore(id);
            appendLogic([ { kind: "text", text: `↶ ย้อนกลับ ${res?.files?.length ?? 0} ไฟล์แล้ว กำลังรีสตาร์ท...` } ]);
            await api.restart("");
            await waitForServer();
        } catch (err) {
            alert(err.message);
        }
    };

    window.addEventListener("beforeunload", (e) => {
        if (state.isFileDirty || state.isCodeDirty) e.preventDefault();
    });
}

/* ------------------------------------ chat extras */

function makeClientId() {
    try {
        const saved = sessionStorage.getItem("persona:clientId");
        if (saved) return saved;
        const id = `c${Math.random().toString(36).slice(2, 10)}`;
        sessionStorage.setItem("persona:clientId", id);
        return id;
    } catch {
        return `c${Math.random().toString(36).slice(2, 10)}`;
    }
}

/** Draws a picture into a canvas no bigger than 1280px and returns a JPEG data URL */
function shrinkImage(file, maxSide = 1280) {
    return new Promise((resolve, reject) => {
        if (!file.type.startsWith("image/")) return reject(new Error("ไม่ใช่ไฟล์รูป"));
        // GIFs would lose their animation in a canvas, so they go up as they are
        if (file.type === "image/gif") {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(new Error("อ่านไฟล์ไม่ได้"));
            return reader.readAsDataURL(file);
        }
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => {
            const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
            const canvas = document.createElement("canvas");
            canvas.width = Math.round(img.width * scale);
            canvas.height = Math.round(img.height * scale);
            canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
            URL.revokeObjectURL(url);
            resolve(canvas.toDataURL("image/jpeg", 0.85));
        };
        img.onerror = () => reject(new Error("เปิดรูปไม่ได้"));
        img.src = url;
    });
}

function showReaction(msgId, emoji) {
    const row = document.querySelector(`[data-msg="${msgId}"]`);
    const badge = row?.querySelector("[data-reactions]");
    if (!badge) return;
    badge.textContent = emoji;
    badge.classList.remove("hidden");
}

/* ------------------------------------ notifications */

// Web Push needs a secure page: https (Cloudflare Tunnel) or localhost
const canPush = () => typeof window !== "undefined" && window.isSecureContext && "serviceWorker" in navigator && "PushManager" in window;
const canNotify = () => typeof Notification !== "undefined";
const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent);
const isInstalled = () => window.matchMedia?.("(display-mode: standalone)")?.matches || navigator.standalone === true;

const urlKey = (b64) => {
    const pad = "=".repeat((4 - (b64.length % 4)) % 4);
    const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};

/** Registers the service worker and picks up an existing subscription from an earlier visit */
async function initPush() {
    if (!canPush()) return;
    try {
        const reg = await navigator.serviceWorker.register("/sw.js");
        state.pushSub = await reg.pushManager.getSubscription();
    } catch (err) {
        console.warn("service worker:", err);
    }
}

function renderNotify() {
    const area = $("[data-notify-area]");
    if (!area) return;
    const row = (label, onclick, tone = "text-slate-300") =>
        `<button type="button" onclick="${onclick}" class="w-full rounded-xl px-2 py-2 text-left text-sm ${tone} hover:bg-white/5">${label}</button>`;
    const hint = (text) => `<p class="px-2 pb-1 text-[11px] text-slate-500">${text}</p>`;

    if (state.pushSub) {
        area.innerHTML = row("🔔 แจ้งเตือนเปิดอยู่ · ส่งทดสอบ", "testPush()", "text-emerald-300") + row("🔕 ปิดการแจ้งเตือนบนเครื่องนี้", "disablePush()");
    } else if (canPush()) {
        area.innerHTML = Notification.permission === "denied"
            ? row("🔕 การแจ้งเตือนถูกบล็อก", "enableNotifications()") + hint("เปิดสิทธิ์แจ้งเตือนของเว็บนี้ในตั้งค่าเบราว์เซอร์ก่อน")
            : row("🔔 เปิดการแจ้งเตือน", "enableNotifications()") + hint("เด้งเตือนเมื่อเธอส่งข้อความ แม้ปิดหน้าแชทไปแล้ว");
    } else if (isIos() && !isInstalled()) {
        area.innerHTML = row("🔔 แจ้งเตือน (iPhone)", "") + hint("กดปุ่มแชร์ → เพิ่มไปยังหน้าจอโฮม แล้วเปิดแชทจากไอคอนนั้น จึงจะเปิดการแจ้งเตือนได้");
    } else if (!window.isSecureContext) {
        area.innerHTML = row("🔕 แจ้งเตือนใช้ไม่ได้ในลิงก์นี้", "") + hint("ต้องเปิดผ่านลิงก์ https (Cloudflare Tunnel) หรือบนคอมเครื่องนี้");
    } else if (canNotify()) {
        area.innerHTML = row(Notification.permission === "granted" ? "🔔 แจ้งเตือนในแท็บเปิดอยู่" : "🔔 เปิดการแจ้งเตือน", "enableNotifications()") + hint("เบราว์เซอร์นี้เตือนได้เฉพาะตอนเปิดหน้าแชทค้างไว้");
    } else {
        area.innerHTML = row("🔕 เบราว์เซอร์นี้ไม่รองรับการแจ้งเตือน", "");
    }
}

// Kept for older callers
const updateNotifyButton = renderNotify;

/** In-tab fallback for browsers without push; with push on, the service worker shows it instead */
function notify(text) {
    if (state.pushSub || !canNotify() || Notification.permission !== "granted" || !document.hidden) return;
    try {
        const n = new Notification(state.name, { body: previewOf(text), tag: "persona-chat" });
        n.onclick = () => {
            window.focus();
            n.close();
        };
    } catch {}
}

/* ------------------------------------ one active tab or device */

async function heartbeat() {
    try {
        const { isActive } = await api.beat(state.clientId, !document.hidden);
        setElsewhere(!isActive);
    } catch {}
}

function setElsewhere(isElsewhere) {
    if (state.isElsewhere === isElsewhere) return;
    state.isElsewhere = isElsewhere;
    const el = $("[data-elsewhere]");
    el?.classList.toggle("hidden", !isElsewhere);
    el?.classList.toggle("grid", isElsewhere);
    if (isElsewhere) clearTimeout(idleTimer);
}

// Tell the server right away when the chat is hidden or closed, so her next message becomes a push
if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
        if (state.clientId) api.beat(state.clientId, !document.hidden).catch(() => {});
    });
    window.addEventListener("pagehide", () => {
        // keepalive fetch instead of sendBeacon: the server only accepts JSON posts, and a beacon is sent as plain text
        fetch("/api/presence/beat", {
            method: "POST",
            keepalive: true,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ clientId: state.clientId, visible: false }),
        }).catch(() => {});
    });
}

async function refreshBackupInfo() {
    const info = $("[data-backup-info]");
    const btn = $("[data-backup-btn]");
    try {
        const res = await api.backupInfo();
        if (res?.dir) {
            const last = res.lastAt ? new Date(res.lastAt).toLocaleString("th-TH", { dateStyle: "medium", timeStyle: "short" }) : "ยังไม่เคย";
            if (info) info.textContent = `สำรองตัวละครทุกตัววันละครั้งไปที่ ${res.dir} · ล่าสุด: ${last}`;
            btn?.classList.remove("hidden");
        } else if (info) {
            info.textContent = "ใส่ BACKUP_DIR=โฟลเดอร์ที่ Google Drive / OneDrive / Dropbox sync ในไฟล์ .env แล้วเปิดแอปใหม่ ระบบจะสำรองตัวละครทุกตัวไปที่นั่นวันละครั้ง ถ้าคอมเสีย ข้อมูลยังอยู่บนคลาวด์";
        }
    } catch {}
}

/* ------------------------------------ snapshots */

async function refreshSnapshots() {
    try {
        state.snapshots = (await api.snapshots()).snapshots ?? [];
        const el = $("[data-snapshots]");
        if (el) el.innerHTML = snapshotList(state.snapshots);
    } catch {}
}

/* ------------------------------------ window handlers: extras */

let searchTimer = null;

if (typeof window !== "undefined") {
    /** Tapping a bubble shows its reply/reaction buttons; tapping again hides them */
    window.toggleActions = (el) => {
        const row = el.closest(".bubble-in");
        const actions = row?.querySelector("[data-actions]");
        if (!actions) return;
        const isOpen = !actions.classList.contains("hidden");
        document.querySelectorAll("[data-actions]").forEach((a) => {
            a.classList.add("hidden");
            a.classList.remove("flex");
        });
        if (!isOpen) {
            actions.classList.remove("hidden");
            actions.classList.add("flex");
            // Editing is only possible before she has read it
            const receipt = row.querySelector("[data-receipt]")?.textContent ?? "";
            row.querySelector("[data-edit-btn]")?.classList.toggle("hidden", receipt !== "ส่งแล้ว");
        }
    };

    window.closePopovers = (e) => {
        if (e?.target?.closest?.(".bubble-in")) return;
        document.querySelectorAll("[data-actions]").forEach((a) => {
            a.classList.add("hidden");
            a.classList.remove("flex");
        });
        window.toggleStickers(false);
    };

    window.startReply = (btn) => {
        const row = btn.closest(".bubble-in");
        state.replyTo = previewOf(row?.dataset?.raw ?? "");
        const bar = $("[data-reply-bar]");
        const text = $("[data-reply-text]");
        if (text) text.textContent = state.replyTo;
        bar?.classList.remove("hidden");
        bar?.classList.add("flex");
        window.closePopovers();
        $("[data-chat-input]")?.focus();
    };

    window.cancelReply = () => {
        state.replyTo = "";
        const bar = $("[data-reply-bar]");
        bar?.classList.add("hidden");
        bar?.classList.remove("flex");
    };

    window.reactTo = async (btn, emoji) => {
        const row = btn.closest(".bubble-in");
        const badge = row?.querySelector("[data-reactions]");
        if (badge) {
            badge.textContent = emoji;
            badge.classList.remove("hidden");
        }
        window.closePopovers();
        try {
            // The bubble's own text and time let the server find the message in the log and save the reaction there
            await api.react(emoji, row?.dataset?.raw ?? "", row?.dataset?.time ?? "", row?.dataset?.date ?? "");
        } catch {}
    };

    window.toggleStickers = (force) => {
        const el = $("[data-stickers]");
        if (!el) return;
        const isOpen = typeof force === "boolean" ? force : el.classList.contains("hidden");
        el.classList.toggle("hidden", !isOpen);
        el.classList.toggle("grid", isOpen);
    };

    window.openImage = (src) => {
        const viewer = $("[data-image-viewer]");
        const img = $("[data-image-full]");
        if (!viewer || !img) return;
        img.src = src;
        viewer.classList.remove("hidden");
        viewer.classList.add("grid");
    };

    window.openSearch = () => {
        const el = $("[data-search]");
        el?.classList.remove("hidden");
        el?.classList.add("flex");
        $("[data-search-input]")?.focus();
    };

    window.closeSearch = () => {
        const el = $("[data-search]");
        el?.classList.add("hidden");
        el?.classList.remove("flex");
    };

    window.runSearch = (q) => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(async () => {
            const box = $("[data-search-results]");
            if (!box) return;
            if (!q.trim()) {
                box.innerHTML = `<p class="py-6 text-center text-sm text-slate-500">พิมพ์คำที่อยากหา</p>`;
                return;
            }
            try {
                box.innerHTML = searchResults((await api.search(q)).results, q, state.name);
            } catch (err) {
                box.innerHTML = `<p class="py-6 text-center text-sm text-rose-200">${esc(err.message)}</p>`;
            }
        }, 250);
    };

    window.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
            window.closeSearch();
            window.closePopovers();
            $("[data-image-viewer]")?.classList.add("hidden");
            $("[data-profile-menu]")?.classList.add("hidden");
        }
    });

    window.toggleProfileMenu = async (e) => {
        e?.stopPropagation?.();
        const menu = $("[data-profile-menu]");
        menu?.classList.toggle("hidden");
        updateNotifyButton();
        // The quick tunnel's address arrives a few seconds after start, so refresh it on open
        if (state.isLocal && !menu?.classList.contains("hidden")) {
            try {
                state.lan = (await api.bootstrap())?.lan ?? state.lan;
                const body = $("[data-remote-body]");
                if (body) body.innerHTML = remoteLinks(state.lan);
            } catch {}
        }
    };

    window.rotateKey = async () => {
        if (!confirm("เปลี่ยนรหัส? มือถือและเครื่องอื่นที่เคยเปิดไว้จะเข้าไม่ได้จนกว่าจะเปิดลิงก์ใหม่")) return;
        try {
            state.lan = await api.rotateKey();
            const body = $("[data-remote-body]");
            if (body) body.innerHTML = remoteLinks(state.lan);
        } catch (err) {
            alert(err.message);
        }
    };

    document.addEventListener("click", (e) => {
        if (!e.target.closest?.("[data-profile-menu]")) $("[data-profile-menu]")?.classList.add("hidden");
    });

    window.switchProfile = async (id) => {
        if (id === state.profileId) return $("[data-profile-menu]")?.classList.add("hidden");
        try {
            await api.switchProfile(id);
            location.reload();
        } catch (err) {
            alert(err.message);
        }
    };

    window.createProfile = async (isCopy) => {
        const name = prompt(isCopy ? `ชื่อของตัวละครใหม่ (คัดลอกตัวตน สไตล์ และสิ่งที่สอนจาก ${state.name})` : "ชื่อของตัวละครใหม่");
        if (name == null) return;
        try {
            await api.createProfile(name.trim(), isCopy);
            location.reload();
        } catch (err) {
            alert(err.message);
        }
    };

    window.deleteProfile = async (id, name) => {
        if (!confirm(`ลบ "${name}"? (ย้ายไปไว้ที่ data/.trash ยังกู้คืนเองได้)`)) return;
        try {
            state.profiles = (await api.deleteProfile(id)).profiles ?? [];
            location.reload();
        } catch (err) {
            alert(err.message);
        }
    };

    window.enableNotifications = async () => {
        if (!canNotify()) return renderNotify();
        const permission = await Notification.requestPermission();
        if (permission === "granted" && canPush()) {
            try {
                const reg = await navigator.serviceWorker.ready;
                const { key } = await api.pushKey();
                state.pushSub = (await reg.pushManager.getSubscription())
                    ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlKey(key) }));
                const label = /Android|iPhone|iPad/.test(navigator.userAgent) ? "มือถือ" : "คอม";
                await api.pushSubscribe(state.pushSub.toJSON(), label);
            } catch (err) {
                alert(`เปิดแจ้งเตือนไม่สำเร็จ: ${err.message}`);
            }
        }
        renderNotify();
    };

    window.disablePush = async () => {
        try {
            const endpoint = state.pushSub?.endpoint;
            await state.pushSub?.unsubscribe();
            if (endpoint) await api.pushUnsubscribe(endpoint);
        } catch {}
        state.pushSub = null;
        renderNotify();
    };

    window.testPush = async () => {
        try {
            const { reached } = await api.pushTest();
            if (!reached) alert("ส่งไม่ถึงเครื่องไหนเลย ลองปิดแล้วเปิดการแจ้งเตือนใหม่");
        } catch (err) {
            alert(err.message);
        }
    };

    /* ---------- move, share, back up characters */

    window.exportProfile = (mode) => {
        const images = $("[data-export-images]")?.checked ? "1" : "0";
        location.href = `/api/profiles/export?id=${encodeURIComponent(state.profileId)}&mode=${mode}&images=${images}`;
    };

    window.importProfile = async (input) => {
        const file = input?.files?.[0];
        input.value = "";
        if (!file) return;
        const msg = $("[data-portable-msg]");
        try {
            const pack = JSON.parse(await file.text());
            if (!confirm(`นำเข้า "${pack?.name ?? "ตัวละคร"}" เป็นตัวละครใหม่?`)) return;
            if (msg) msg.textContent = "กำลังนำเข้า...";
            await api.importProfile(pack);
            location.reload();
        } catch (err) {
            if (msg) msg.textContent = `นำเข้าไม่สำเร็จ: ${err.message}`;
        }
    };

    window.backupNow = async () => {
        const msg = $("[data-portable-msg]");
        try {
            const res = await api.backupNow();
            if (msg) msg.textContent = `✓ สำรอง ${res.count} ตัวไปที่ ${res.dir}`;
            refreshBackupInfo();
        } catch (err) {
            if (msg) msg.textContent = err.message;
        }
    };

    window.useHere = async () => {
        await api.claim(state.clientId);
        location.reload();
    };

    window.createSnapshot = async () => {
        try {
            state.snapshots = (await api.createSnapshot()).snapshots ?? [];
            const el = $("[data-snapshots]");
            if (el) el.innerHTML = snapshotList(state.snapshots);
        } catch (err) {
            alert(err.message);
        }
    };

    window.restoreSnapshot = async (id) => {
        if (!confirm(`ย้อนความจำของ ${state.name} กลับไปที่จุดนี้? (สถานะตอนนี้จะถูกสำรองไว้ก่อน)`)) return;
        try {
            await api.restoreSnapshot(id);
            location.reload();
        } catch (err) {
            alert(err.message);
        }
    };
}

/* ------------------------------------ edit, unsend, older days */

const dayLabel = (date) =>
    new Date(`${date}T12:00:00`).toLocaleDateString("th-TH", { weekday: "short", day: "numeric", month: "short" });

async function saveEdit(id, text) {
    const row = document.querySelector(`[data-msg="${id}"]`);
    window.cancelEdit();
    try {
        await api.edit(id, text);
        const item = engine.pending.find((m) => m.id === id);
        if (item) item.text = text;
        if (row) {
            row.dataset.raw = text;
            const span = row.querySelector("[data-text]");
            if (span) span.textContent = text;
            if (!row.querySelector("[data-edited]")) span?.insertAdjacentHTML("afterend", `<span class="ml-1.5 text-[10px] opacity-60" data-edited>แก้ไขแล้ว</span>`);
        }
    } catch (err) {
        alert(err.message);
    }
}

/** Inserts an earlier day above everything, keeping your scroll position where it was */
async function loadOlder() {
    if (state.isLoadingOlder || !state.hasOlder) return;
    state.isLoadingOlder = true;
    const box = messagesEl();
    const btn = $("[data-older-btn]");
    if (btn) btn.textContent = "กำลังโหลด...";
    try {
        const { date, entries } = await api.olderDay(state.oldestDate);
        if (!date) {
            state.hasOlder = false;
            $("[data-older]")?.replaceChildren(Object.assign(document.createElement("span"), { className: "text-[11px] text-slate-600", textContent: "ไม่มีแชทก่อนหน้านี้" }));
            return;
        }
        state.oldestDate = date;
        const html = divider(dayLabel(date)) + (entries ?? []).map((e, i) => {
            const parts = e.who === "agent" ? String(e.text).split(" / ") : [ e.text ];
            const options = { id: `d${date}-${i}`, time: e.time, date, receipt: e.who === "user" ? "อ่านแล้ว" : "", canUnsend: false };
            return parts.map((p, k) => (p ? bubble(e.who, p, { ...options, reaction: e.reactions?.[k] ?? "" }) : "")).join("");
        }).join("");

        const before = box.scrollHeight;
        $("[data-older]")?.insertAdjacentHTML("afterend", html);
        box.scrollTop += box.scrollHeight - before;
        if (btn) btn.textContent = "โหลดแชทวันก่อนหน้า";
    } catch (err) {
        if (btn) btn.textContent = "โหลดไม่สำเร็จ · ลองอีกครั้ง";
    } finally {
        state.isLoadingOlder = false;
    }
}

if (typeof window !== "undefined") {
    window.loadOlder = loadOlder;

    // Reaching the top loads the day before, like scrolling up in a chat app
    window.onChatScroll = (el) => {
        if (el.scrollTop < 40 && state.hasOlder && !state.isLoadingOlder && el.scrollHeight > el.clientHeight) loadOlder();
    };

    window.startEdit = (btn) => {
        const row = btn.closest(".bubble-in");
        if (!row?.dataset?.msg) return;
        window.cancelReply();
        state.editing = row.dataset.msg;
        const input = $("[data-chat-input]");
        if (input) {
            input.value = previewOf(row.dataset.raw ?? "");
            window.autoGrow(input);
            input.focus();
        }
        const bar = $("[data-edit-bar]");
        const text = $("[data-edit-text]");
        if (text) text.textContent = previewOf(row.dataset.raw ?? "");
        bar?.classList.remove("hidden");
        bar?.classList.add("flex");
        window.closePopovers();
    };

    window.cancelEdit = () => {
        if (state.editing) {
            const input = $("[data-chat-input]");
            if (input) input.value = "";
        }
        state.editing = "";
        const bar = $("[data-edit-bar]");
        bar?.classList.add("hidden");
        bar?.classList.remove("flex");
    };

    /** Takes a message back; if she already saw it, she knows (and may tease you about it) */
    window.unsendMessage = async (btn) => {
        const row = btn.closest(".bubble-in");
        const id = row?.dataset?.msg ?? "";
        if (!row || !confirm("ยกเลิกส่งข้อความนี้?")) return;
        window.closePopovers();
        try {
            await api.unsend(id, row.dataset.raw ?? "", row.dataset.time ?? "");
            engine.pending = engine.pending.filter((m) => m.id !== id);
            row.outerHTML = unsentLine("user", row.dataset.time ?? "");
        } catch (err) {
            alert(err.message);
        }
    };
}

/* ------------------------------------ boot */

async function boot() {
    try {
        const data = await api.bootstrap();
        state.name = data?.name ?? "เพื่อน";
        state.brain = data?.brain ?? null;
        state.status = data?.status ?? null;
        state.idleMinutes = Number(data?.idleMinutes ?? 15);
        state.rethinkOnInterrupt = data?.rethinkOnInterrupt === true;
        state.lastSeenAgentAt = Number(data?.lastAgentAt ?? 0);
        state.profileId = data?.profileId ?? "";
        state.profiles = data?.profiles ?? [];
        state.isLocal = data?.isLocal !== false;
        state.lan = data?.lan ?? null;
        if (state.isFullRole) state.tab = "chat";
        document.title = state.name;
        paint();

        // Today's earlier messages, so a refresh doesn't look like a fresh start
        const history = data?.history ?? [];
        // Your messages there are ones she already read, or ones she chose not to answer
        history.forEach((entry, i) => {
            const parts = entry.who === "agent" ? String(entry.text).split(" / ") : [ entry.text ];
            const options = { id: `h${i}`, time: entry.time, receipt: entry.who === "user" ? "อ่านแล้ว" : "" };
            // Index k stays the bubble's position in the log line, which is what saved reactions point at
            parts.forEach((p, k) => {
                if (p) messagesEl()?.insertAdjacentHTML("beforeend", bubble(entry.who, p, { ...options, reaction: entry.reactions?.[k] ?? "" }));
            });
        });
        // Messages you sent that she hasn't answered yet: still waiting, even after a refresh
        for (const m of data?.pending ?? []) {
            const time = new Date(m.sentAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
            messagesEl()?.insertAdjacentHTML("beforeend", bubble("user", m.text, { id: m.id, time, receipt: m.readAt ? "อ่านแล้ว" : "ส่งแล้ว", isEdited: Boolean(m.isEdited) }));
            engine.pending.push({ id: m.id, text: m.text, sentAt: m.sentAt, isRead: Boolean(m.readAt) });
        }
        scrollDown(true);
        setPresence();

        state.teachings = (await api.teachings()).teachings ?? [];
        renderLessons();
    } catch (err) {
        document.getElementById("app").innerHTML = /*html*/`
            <div class="grid h-full place-items-center p-6 text-center">
                <p class="max-w-sm text-sm text-rose-200">เชื่อมต่อเซิร์ฟเวอร์ไม่ได้: ${esc(err.message)}<br><span class="text-slate-400">ตรวจว่าเปิด npm run dev อยู่</span></p>
            </div>`;
        return;
    }

    // This tab now holds the chat; any other tab or device steps aside
    await api.claim(state.clientId).catch(() => {});
    setInterval(heartbeat, 15000);
    await initPush();
    renderNotify();

    // She notices you opened the chat, then decides whether to say hi
    engine.isReplying = true;
    try {
        // Asleep by her routine in persona.md: no hello, she'll see your messages when she wakes.
        // With messages still waiting she answers those instead of saying hello.
        const plan = await getPlan([]);
        engine.isInterrupted = false;
        const result = plan.isAsleep || engine.pending.length ? null : await api.greet();
        if (result?.bubbles?.length) {
            await sleep(plan.thinkMs);
            setTyping(true);
            await cutReply(result, await speak(result, plan, Date.now()));
        }
    } catch (err) {
        setTyping(false);
        append(errorLine(err.message));
    } finally {
        engine.isReplying = false;
        setPresence();
        armIdle();
        if (engine.pending.length) schedule();
        $("[data-chat-input]")?.focus();
    }
}

boot();
