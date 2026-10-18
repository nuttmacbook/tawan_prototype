import { esc, CARD, EYEBROW, BTN, BTN_GHOST } from "./ui.js";
import { findLinks } from "../links.js";

const MOOD_STYLE = {
    "ดีใจ":    { icon: "😊", bar: "bg-amber-400" },
    "เหงา":    { icon: "🥺", bar: "bg-indigo-400" },
    "งอน":     { icon: "😤", bar: "bg-rose-400" },
    "เหนื่อย":  { icon: "😪", bar: "bg-slate-400" },
    "ตื่นเต้น": { icon: "🤩", bar: "bg-pink-400" },
    "กังวล":   { icon: "😟", bar: "bg-violet-400" },
};
const MOOD_DEFAULT = { icon: "💭", bar: "bg-sky-400" };

/* ------------------------------------ messages */

const REACTIONS = [ "❤️", "😂", "😮", "😢", "👍", "🙏" ];

const STICKERS = [
    "😂", "🥹", "😭", "🥺", "😤", "😴", "🤔", "😳",
    "🥰", "😎", "🤗", "🙄", "😱", "🫠", "🙏", "👍",
    "❤️", "💔", "🔥", "🎉", "☕", "🍲", "🐱", "🌙",
];

const IMAGE_TOKEN = /\[รูป:([a-z0-9]+\.(?:jpg|png|webp|gif))\]/g;
// A picture from her own photos folder (data/personas/<id>/photos/), sent by her
const HER_PHOTO = /\[รูปเธอ:([^\]\/\\]{1,120})\]/g;
// http(s) only; trailing punctuation stays outside the link
/**
 * Text with web links made clickable. Every piece is escaped on its own, so a link can't
 * smuggle markup in, and links open in a new tab without access back to this page.
 */
const withLinks = (text) => {
    const s = String(text ?? "");
    let out = "";
    let last = 0;
    for (const { url, index } of findLinks(s)) {
        out += esc(s.slice(last, index));
        out += `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer nofollow" onclick="event.stopPropagation()" class="break-all underline decoration-current/50 underline-offset-2">${esc(url)}</a>`;
        last = index + url.length;
    }
    return out + esc(s.slice(last));
};
const REPLY_TOKEN = /^\[ตอบกลับ "([^"]*)"\]\s*/;
const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\u200d|\ufe0f|\s){1,12}$/u;

/**
 * Splits a stored message into what to draw: pictures, the message it replies to, and the text.
 * Emoji-only messages are drawn big like stickers.
 */
const parseMessage = (raw) => {
    let text = String(raw ?? "");
    const images = [
        ...[ ...text.matchAll(IMAGE_TOKEN) ].map((m) => `/api/upload/${m[1]}`),
        ...[ ...text.matchAll(HER_PHOTO) ].map((m) => `/api/photo/${encodeURIComponent(m[1])}`),
    ];
    text = text.replace(IMAGE_TOKEN, "").replace(HER_PHOTO, "").trim();
    const reply = text.match(REPLY_TOKEN)?.[1] ?? "";
    text = text.replace(REPLY_TOKEN, "").trim();
    const isSticker = Boolean(text) && !images.length && EMOJI_ONLY.test(text) && /\p{Extended_Pictographic}/u.test(text);
    return { images, reply, text, isSticker };
};

/** What a message looks like when quoted or previewed: pictures and stickers become words */
const previewOf = (raw) => {
    const m = parseMessage(raw);
    return m.text || (m.images.length ? "📷 รูป" : "");
};

/**
 * One chat bubble, LINE style: time beside every bubble, "อ่านแล้ว" beside yours once she has read it.
 * Tapping a bubble shows reply and reaction buttons.
 * @param {"user" | "agent"} who
 * @param {string} raw message as stored, may contain [รูป:..] and [ตอบกลับ ".."]
 * @param {{ id?: string, receipt?: string, time?: string, canUnsend?: boolean, isEdited?: boolean, reaction?: string, date?: string }} [options]
 *   reaction: an emoji already on this bubble (from the saved log) · date: the day of an older message, sent along with a reaction
 */
const bubble = (who, raw, { id = "", receipt = "", time = "", canUnsend = true, isEdited = false, reaction = "", date = "" } = {}) => {
    const isUser = who === "user";
    if (String(raw ?? "").trim() === UNSENT) return unsentLine(who, time);
    const msg = parseMessage(raw);
    const bubbleTone = isUser
        ? "rounded-2xl rounded-br-md bg-sky-500 text-slate-950"
        : "rounded-2xl rounded-bl-md bg-slate-800/90 text-slate-100 ring-1 ring-inset ring-white/5";

    const meta = /*html*/`
        <span class="mb-0.5 flex shrink-0 flex-col ${isUser ? "items-end" : "items-start"} text-[10px] leading-tight text-slate-500">
            ${isUser ? `<span data-receipt="${id}">${esc(receipt)}</span>` : ""}
            ${isUser ? "" : `<button type="button" data-debug onclick="event.stopPropagation(); correctBubble(this)" title="คนจริงจะพิมพ์ว่า..." aria-label="แก้ให้เหมือนคน" class="rounded px-1 text-slate-600 transition hover:bg-white/5 hover:text-sky-300">✎</button>`}
            <span class="font-mono tabular-nums">${esc(time)}</span>
        </span>
    `;

    const quote = msg.reply ? /*html*/`
        <span class="mb-1 block border-l-2 ${isUser ? "border-slate-950/40 text-slate-900/80" : "border-sky-400/60 text-slate-400"} pl-2 text-xs">${esc(msg.reply)}</span>
    ` : "";

    const pictures = msg.images.map((src) => /*html*/`
        <img src="${esc(src)}" alt="รูปที่ส่ง" loading="lazy" onclick="event.stopPropagation(); openImage(this.src)"
            class="max-h-64 w-auto max-w-full cursor-zoom-in rounded-2xl object-cover ring-1 ring-white/10" />
    `).join("");

    let body = "";
    if (msg.isSticker) {
        body = `<p class="text-5xl leading-none sm:text-6xl" data-text>${esc(msg.text)}</p>`;
    } else if (msg.text || quote) {
        body = `<p class="whitespace-pre-wrap break-words px-3.5 py-2 text-[15px] leading-relaxed ${bubbleTone}">${quote}<span data-text>${withLinks(msg.text)}</span>${isEdited ? `<span class="ml-1.5 text-[10px] opacity-60" data-edited>แก้ไขแล้ว</span>` : ""}</p>`;
    }

    return /*html*/`
        <div class="bubble-in group flex flex-col ${isUser ? "items-end" : "items-start"}" ${id ? `data-msg="${id}"` : ""} data-who="${who}" data-raw="${esc(raw)}" data-time="${esc(time)}" ${date ? `data-date="${esc(date)}"` : ""}>
            <div class="flex w-full items-end gap-1.5 ${isUser ? "justify-end" : "justify-start"}">
                ${isUser ? meta : ""}
                <div class="flex max-w-[80%] cursor-pointer flex-col gap-1 sm:max-w-[70%] ${isUser ? "items-end" : "items-start"}" onclick="toggleActions(this)">
                    ${pictures}
                    ${body}
                </div>
                ${isUser ? "" : meta}
            </div>
            <span class="-mt-1.5 ${reaction ? "" : "hidden"} rounded-full bg-slate-900 px-1.5 py-0.5 text-xs ring-1 ring-white/10 ${isUser ? "mr-12" : "ml-3"}" data-reactions>${esc(reaction)}</span>
            <div class="mt-1 hidden items-center gap-0.5 rounded-full bg-slate-900/95 p-1 ring-1 ring-white/10" data-actions>
                <button type="button" onclick="startReply(this)" class="rounded-full px-2 py-0.5 text-xs text-slate-300 hover:bg-white/10" aria-label="ตอบกลับ">↩ ตอบกลับ</button>
                ${isUser && canUnsend && !msg.images.length && !msg.isSticker ? `<button type="button" onclick="startEdit(this)" class="rounded-full px-2 py-0.5 text-xs text-slate-300 hover:bg-white/10" data-edit-btn aria-label="แก้ไข">✎ แก้ไข</button>` : ""}
                ${isUser && canUnsend ? `<button type="button" onclick="unsendMessage(this)" class="rounded-full px-2 py-0.5 text-xs text-rose-300 hover:bg-rose-500/10" aria-label="ยกเลิกส่ง">ยกเลิกส่ง</button>` : ""}
                ${isUser ? "" : REACTIONS.map((r) => `<button type="button" onclick="reactTo(this, '${r}')" class="rounded-full px-1.5 py-0.5 text-base hover:bg-white/10" aria-label="รีแอค ${r}">${r}</button>`).join("")}
            </div>
        </div>
    `;
};

const UNSENT = "[ยกเลิกข้อความ]";

/** What's left after a message is taken back, like LINE's "ยกเลิกข้อความ" line */
const unsentLine = (who, time) => /*html*/`
    <div class="bubble-in flex ${who === "user" ? "justify-end" : "justify-start"} items-center gap-2 text-[11px] text-slate-500" data-unsent>
        <span class="rounded-full px-3 py-1 italic ring-1 ring-inset ring-white/10">${who === "user" ? "คุณยกเลิกการส่งข้อความ" : "ยกเลิกข้อความแล้ว"}</span>
        <span class="font-mono tabular-nums">${esc(time)}</span>
    </div>
`;

/** "Load earlier" control at the top of the chat */
const olderButton = /*html*/`
    <div class="flex justify-center" data-older>
        <button type="button" onclick="loadOlder()" class="rounded-full px-3 py-1 text-[11px] text-slate-400 ring-1 ring-inset ring-white/10 transition hover:text-white" data-older-btn>โหลดแชทวันก่อนหน้า</button>
    </div>
`;

const stickerPicker = /*html*/`
    <div class="absolute bottom-full left-0 z-20 mb-2 hidden w-72 grid-cols-6 gap-1 rounded-2xl bg-slate-900/95 p-2 shadow-2xl ring-1 ring-white/10 backdrop-blur" data-stickers>
        ${STICKERS.map((s) => `<button type="button" onclick="sendSticker('${s}')" class="rounded-xl p-1.5 text-2xl transition hover:bg-white/10" aria-label="ส่งสติกเกอร์ ${s}">${s}</button>`).join("")}
    </div>
`;

/** Inline "a real person would type..." box under one of her bubbles (debug only) */
const correctionForm = (original) => /*html*/`
    <form class="ml-2 flex max-w-md flex-col gap-2 rounded-xl bg-slate-900/90 p-3 ring-1 ring-inset ring-sky-400/20" data-debug data-correction onsubmit="saveCorrection(event)">
        <p class="text-[11px] text-slate-400">เดิม: <span class="text-slate-300">${esc(original)}</span></p>
        <textarea name="after" rows="2" required placeholder="คนจริงจะพิมพ์ว่า... (ขึ้นบรรทัดใหม่ = แยกเป็นหลายข้อความ)"
            class="w-full resize-y rounded-lg border border-white/5 bg-slate-950/70 px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/60"></textarea>
        <input type="hidden" name="before" value="${esc(original)}" />
        <div class="flex items-center gap-2">
            <button type="submit" class="rounded-lg bg-sky-500 px-3 py-1.5 text-xs font-semibold text-slate-950 hover:bg-sky-400">บันทึกเป็นตัวอย่าง</button>
            <button type="button" onclick="this.closest('[data-correction]').remove()" class="rounded-lg px-3 py-1.5 text-xs text-slate-400 hover:text-white">ยกเลิก</button>
            <span class="text-[11px] text-emerald-300" data-correction-msg></span>
        </div>
    </form>
`;

const skipButton = `<button type="button" onclick="skipWait()" class="ml-1 rounded-full px-2 text-sky-300 hover:bg-sky-500/10">⏩ ข้าม</button>`;

/** Debug-only line explaining why she waits as long as she does */
const pacingNote = (plan) => /*html*/`
    <div class="flex justify-center" data-debug data-note>
        <span class="flex max-w-[95%] items-center rounded-full bg-slate-900/80 px-3 py-1 text-[11px] text-slate-500 ring-1 ring-inset ring-white/5">
            <span class="truncate">⏱ อ่านใน ${(Number(plan?.readMs ?? 0) / 1000).toFixed(1)} วิ${Number(plan?.laterMs) > 0 ? ` · ตอบหลังอ่าน ${(plan.laterMs / 60000).toFixed(1)} นาที` : ""} · พิมพ์ ${esc(plan?.typingCps)} ตัว/วิ · ${esc((plan?.reasons ?? []).join(", "))}</span>
            ${skipButton}
        </span>
    </div>
`;

/** Debug-only line for "read, went away, will reply later" and "read, chose not to reply" */
const stateNote = (text, { canSkip = false } = {}) => /*html*/`
    <div class="flex justify-center" data-debug data-note>
        <span class="flex max-w-[95%] items-center rounded-full bg-slate-900/80 px-3 py-1 text-[11px] text-slate-500 ring-1 ring-inset ring-white/5">
            <span class="truncate">${esc(text)}</span>${canSkip ? skipButton : ""}
        </span>
    </div>
`;

/** Small centered chip for things the persona noted, e.g. a memory or mood change */
const note = (text) => /*html*/`
    <div class="bubble-in flex justify-center" data-note data-debug>
        <span class="max-w-[90%] truncate rounded-full bg-slate-900/80 px-3 py-1 text-[11px] text-slate-400 ring-1 ring-inset ring-white/5">✎ ${esc(text)}</span>
    </div>
`;

const divider = (label) => /*html*/`
    <div class="flex items-center gap-3 py-1 text-[11px] text-slate-500" data-divider>
        <span class="h-px flex-1 bg-white/5"></span>${esc(label)}<span class="h-px flex-1 bg-white/5"></span>
    </div>
`;

const errorLine = (text) => /*html*/`
    <div class="bubble-in flex justify-center" data-debug>
        <span class="max-w-[90%] rounded-xl bg-rose-500/10 px-3 py-2 text-xs text-rose-200 ring-1 ring-inset ring-rose-400/20">${esc(text)}</span>
    </div>
`;

const typing = (name) => /*html*/`
    <div class="flex items-end gap-2" data-typing>
        <div class="flex items-center gap-1 rounded-2xl rounded-bl-md bg-slate-800/90 px-3.5 py-3 ring-1 ring-inset ring-white/5" aria-label="${esc(name)} กำลังพิมพ์">
            <span class="typing-dot h-1.5 w-1.5 rounded-full bg-slate-300"></span>
            <span class="typing-dot h-1.5 w-1.5 rounded-full bg-slate-300"></span>
            <span class="typing-dot h-1.5 w-1.5 rounded-full bg-slate-300"></span>
        </div>
        <span class="pb-1 text-[11px] text-slate-500">${esc(name)} กำลังพิมพ์...</span>
    </div>
`;

/* ------------------------------------ status aside */

const moodRow = (m) => {
    const style = MOOD_STYLE[m.name] ?? MOOD_DEFAULT;
    const pct = Math.min(100, Math.max(0, (Number(m.value) || 0) * 10));
    return /*html*/`
        <div class="grid grid-cols-[1.5rem_1fr_2.25rem] items-center gap-2">
            <span class="text-base" aria-hidden="true">${style.icon}</span>
            <div class="min-w-0">
                <div class="flex justify-between text-xs"><span class="truncate text-slate-300">${esc(m.name)}</span></div>
                <div class="mt-1 h-1.5 overflow-hidden rounded-full bg-white/5">
                    <div class="h-full rounded-full ${style.bar} transition-all duration-700 motion-reduce:transition-none" style="width:${pct}%"></div>
                </div>
            </div>
            <span class="text-right font-mono text-xs tabular-nums text-slate-400">${Number(m.value).toFixed(1)}</span>
        </div>
    `;
};

const PART_LABELS = {
    persona: "ตัวตน",
    style: "สไตล์พิมพ์",
    rules: "กฎของระบบ",
    teachings: "สิ่งที่สอน",
    memory: "ความจำ",
    journal: "บันทึกรายวัน",
    diary: "ไดอารี่",
    world: "วันนี้ + คนรอบตัว",
    conversation: "บทสนทนา",
};
const WARN_CHARS = 30000;

/**
 * How much text went to the brain last turn and what it cost in tokens.
 * Big prompts mean slow replies and a quota that runs out sooner.
 */
const promptMeter = (prompt) => {
    if (!prompt?.parts) return `<section class="space-y-1"><p class="${EYEBROW}">ส่งให้สมอง</p><p class="text-xs text-slate-500">ยังไม่มีข้อมูล (คุยสักข้อความก่อน)</p></section>`;
    const entries = Object.entries(prompt.parts).filter(([ , n ]) => n > 0).sort((a, b) => b[1] - a[1]);
    const total = entries.reduce((n, [ , v ]) => n + v, 0);
    const max = Math.max(...entries.map(([ , v ]) => v), 1);
    const isBig = total > WARN_CHARS;
    const u = prompt.usage;
    const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

    return /*html*/`
        <section class="space-y-2">
            <div class="flex items-baseline justify-between">
                <p class="${EYEBROW}">ส่งให้สมองรอบล่าสุด</p>
                <span class="font-mono text-xs tabular-nums ${isBig ? "text-amber-300" : "text-slate-400"}">${k(total)} ตัวอักษร</span>
            </div>
            ${entries.map(([ name, n ]) => /*html*/`
                <div class="grid grid-cols-[5.5rem_1fr_2.5rem] items-center gap-2 text-[11px]">
                    <span class="truncate text-slate-400">${esc(PART_LABELS[name] ?? name)}</span>
                    <span class="h-1 overflow-hidden rounded-full bg-white/5"><span class="block h-full rounded-full bg-sky-400/70" style="width:${(n / max) * 100}%"></span></span>
                    <span class="text-right font-mono tabular-nums text-slate-500">${k(n)}</span>
                </div>
            `).join("")}
            <p class="text-[11px] text-slate-400">
                ความจำส่ง ${Number(prompt.memory?.kept ?? 0)}/${Number(prompt.memory?.total ?? 0)} เรื่อง · สิ่งที่สอน ${Number(prompt.teachings?.kept ?? 0)}/${Number(prompt.teachings?.total ?? 0)}
            </p>
            ${u?.ms ? `<p class="text-[11px] text-slate-400">สมองใช้เวลา <span class="font-mono tabular-nums">${(Number(u.ms) / 1000).toFixed(1)}</span> วิ${u.isWarm ? " · ใช้ตัวที่เตรียมไว้ล่วงหน้า" : ""}</p>` : ""}
            ${u ? `<p class="text-[11px] text-slate-400">ใช้จริง: เข้า <span class="font-mono tabular-nums">${k(u.input)}</span> tokens${u.cached ? ` (แคช ${k(u.cached)})` : ""} · ออก <span class="font-mono tabular-nums">${k(u.output)}</span>${u.cost != null ? ` · $${Number(u.cost).toFixed(4)}` : ""}</p>` : ""}
            ${isBig ? `<p class="text-[11px] text-amber-300/90">ใหญ่เกิน ${k(WARN_CHARS)} ตัวอักษร ลองย่อไฟล์ตัวตนหรือสไตล์พิมพ์ ตอบจะเร็วขึ้น</p>` : ""}
        </section>
    `;
};

const statusAside = (status) => {
    const closeness = Math.min(100, Math.max(0, Number(status?.closeness ?? 0)));
    const threads = Array.isArray(status?.threads) ? status.threads : [];

    return /*html*/`
        <div class="space-y-5">
            <!-- อารมณ์ -->
            <section class="space-y-2.5">
                <p class="${EYEBROW}">อารมณ์ตอนนี้</p>
                ${(status?.moods ?? []).map(moodRow).join("") || `<p class="text-xs text-slate-500">—</p>`}
            </section>

            <!-- ความสนิท -->
            <section class="space-y-2">
                <div class="flex items-baseline justify-between">
                    <p class="${EYEBROW}">ความสนิท</p>
                    <span class="font-mono text-xs tabular-nums text-slate-400">${Math.round(closeness)}/100</span>
                </div>
                <div class="h-2 overflow-hidden rounded-full bg-white/5">
                    <div class="h-full rounded-full bg-gradient-to-r from-sky-400 to-pink-400 transition-all duration-700 motion-reduce:transition-none" style="width:${closeness}%"></div>
                </div>
                <p class="text-xs text-slate-400">${esc(status?.stage ?? "")} · คุยกันแล้ว <span class="font-mono tabular-nums">${Number(status?.messages ?? 0)}</span> ข้อความ</p>
            </section>

            <!-- ขนาดที่ส่งให้สมอง -->
            ${promptMeter(status?.prompt)}

            <!-- เรื่องค้าง -->
            <section class="space-y-2">
                <p class="${EYEBROW}">เรื่องที่รอถามต่อ</p>
                ${threads.length
                    ? threads.map((t) => /*html*/`
                        <div class="flex items-start gap-2 text-xs">
                            <span class="mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${t.isDue ? "bg-amber-400" : "bg-slate-600"}"></span>
                            <span class="min-w-0 text-slate-300">${esc(t.about)} <span class="text-slate-500">· ${t.isDue ? "ถึงเวลาถาม" : esc(t.askOn)}</span></span>
                        </div>
                    `).join("")
                    : `<p class="text-xs text-slate-500">ยังไม่มี</p>`}
            </section>
        </div>
    `;
};

/* ------------------------------------ panel */

const chatPanel = (state) => /*html*/`
    <section data-tab-panel="chat" class="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)_auto] gap-3 lg:grid-cols-[minmax(0,1fr)_17rem] lg:grid-rows-[minmax(0,1fr)] [.full-role_&]:grid-cols-1 [.full-role_&]:grid-rows-[minmax(0,1fr)] ${state?.tab === "chat" ? "" : "hidden"}">
        <div class="${CARD} flex min-h-0 flex-col overflow-hidden">
            <!-- ข้อความ -->
            <div class="scroll-slim flex-1 space-y-2 overflow-y-auto px-3 py-4 sm:px-5" data-messages aria-live="polite" onclick="closePopovers(event)" onscroll="onChatScroll(this)">
                ${olderButton}
                ${divider("วันนี้")}
            </div>

            <!-- กำลังตอบกลับข้อความ -->
            <div class="hidden items-center gap-2 border-t border-white/5 bg-slate-950/60 px-3 py-2 text-xs text-slate-300" data-reply-bar>
                <span class="text-sky-300">↩</span>
                <span class="min-w-0 flex-1 truncate" data-reply-text></span>
                <button type="button" onclick="cancelReply()" class="rounded-full px-2 text-slate-400 hover:text-white" aria-label="ยกเลิกการตอบกลับ">✕</button>
            </div>

            <!-- กำลังแก้ข้อความ -->
            <div class="hidden items-center gap-2 border-t border-white/5 bg-slate-950/60 px-3 py-2 text-xs text-amber-200" data-edit-bar>
                <span>✎ กำลังแก้ข้อความ</span>
                <span class="min-w-0 flex-1 truncate text-slate-400" data-edit-text></span>
                <button type="button" onclick="cancelEdit()" class="rounded-full px-2 text-slate-400 hover:text-white" aria-label="ยกเลิกการแก้">✕</button>
            </div>

            <!-- ช่องพิมพ์ -->
            <form class="relative flex items-end gap-1.5 border-t border-white/5 bg-slate-950/40 p-2.5 sm:gap-2 sm:p-3" onsubmit="sendMessage(event)">
                ${stickerPicker}
                <button type="button" onclick="toggleStickers()" class="grid h-11 w-9 shrink-0 place-items-center rounded-full text-xl text-slate-400 transition hover:text-white" aria-label="สติกเกอร์">😊</button>
                <label class="grid h-11 w-9 shrink-0 cursor-pointer place-items-center rounded-full text-xl text-slate-400 transition hover:text-white" aria-label="ส่งรูป">
                    📷<input type="file" accept="image/*" class="sr-only" onchange="pickImage(this)" />
                </label>
                <label class="sr-only" for="chat-input">พิมพ์ข้อความ</label>
                <textarea id="chat-input" data-chat-input rows="1" placeholder="พิมพ์คุยกับ ${esc(state?.name)}..." onkeydown="onChatKey(event)" oninput="onChatInput(this)"
                    class="scroll-slim max-h-36 min-h-[2.75rem] flex-1 resize-none rounded-2xl border border-white/5 bg-slate-900/80 px-4 py-2.5 text-[15px] text-white placeholder:text-slate-500 ring-1 ring-inset ring-white/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/60"></textarea>
                <button type="submit" class="${BTN} h-11 w-11 shrink-0 rounded-full !p-0" aria-label="ส่ง">
                    <svg viewBox="0 0 24 24" class="h-5 w-5" fill="currentColor" aria-hidden="true"><path d="M3.4 20.4 21 12 3.4 3.6 3.4 10l12.6 2-12.6 2z"/></svg>
                </button>
            </form>
        </div>

        <!-- สถานะ (จอใหญ่อยู่ด้านข้าง จอเล็กพับเก็บ) -->
        <aside class="${CARD} hidden min-h-0 flex-col p-4 lg:flex" data-debug>
            <div class="scroll-slim flex-1 overflow-y-auto" data-status>${statusAside(state?.status)}</div>
            <div class="mt-4 flex flex-col gap-2 border-t border-white/5 pt-3">
                <label class="flex cursor-pointer items-center justify-between gap-2 text-xs text-slate-400">
                    แสดงตอนจด/เปลี่ยนอารมณ์
                    <input type="checkbox" class="h-4 w-4 accent-sky-500" data-notes-toggle onchange="toggleNotes(this.checked)" ${state?.showNotes ? "checked" : ""} />
                </label>
                <button type="button" class="${BTN_GHOST} text-xs" onclick="resetChat()">ล้างความจำระยะสั้น</button>
            </div>
        </aside>

        <details class="${CARD} p-3 lg:hidden" data-debug>
            <summary class="cursor-pointer text-xs font-semibold text-slate-300">อารมณ์และความสนิท</summary>
            <div class="mt-3" data-status-mobile>${statusAside(state?.status)}</div>
        </details>
    </section>
`;

export { chatPanel, bubble, note, typing, errorLine, statusAside, pacingNote, stateNote, correctionForm, divider, previewOf, unsentLine };
