import { esc, CARD, EYEBROW, INPUT, BTN, BTN_GHOST, initial } from "./ui.js";

/* ------------------------------------ sign in / sign up */

/**
 * The first screen without an account. Signing up needs the invite code from whoever runs
 * the server, except for the very first account (the admin).
 * @param {{ hasUsers: boolean, mode?: "login" | "register" }} options
 */
const authScreen = ({ hasUsers, mode = hasUsers ? "login" : "register" }) => {
    const isRegister = mode === "register";
    const field = (label, control) => `<label class="block space-y-1"><span class="text-xs font-medium text-slate-300">${label}</span>${control}</label>`;
    return /*html*/`
        <div class="grid h-full place-items-center p-4">
            <form class="${CARD} w-full max-w-sm space-y-4 p-5" data-auth-form data-mode="${mode}" onsubmit="submitAuth(event)">
                <div>
                    <p class="${EYEBROW}">Broker</p>
                    <h1 class="text-lg font-semibold text-white">${isRegister ? (hasUsers ? "สมัครบัญชี" : "สร้างบัญชีแรก") : "เข้าสู่ระบบ"}</h1>
                    ${!hasUsers ? `<p class="mt-1 text-xs text-slate-400">บัญชีแรกเป็นผู้ดูแลระบบ และได้ตัวละครกับแชทเดิมในเครื่องนี้ทั้งหมด</p>` : ""}
                </div>
                ${isRegister ? field("ชื่อที่แสดง", `<input name="name" required maxlength="40" class="${INPUT}" placeholder="เช่น นัท" autocomplete="nickname" />`) : ""}
                ${field("ไอดี", `<input name="handle" required maxlength="20" class="${INPUT}" placeholder="a-z 0-9 _ ." autocomplete="username" autocapitalize="none" spellcheck="false" />`)}
                ${field("รหัสผ่าน", `<input name="password" type="password" required minlength="6" class="${INPUT}" autocomplete="${isRegister ? "new-password" : "current-password"}" />`)}
                ${isRegister && hasUsers ? field("รหัสเชิญ", `<input name="invite" required class="${INPUT}" placeholder="ขอจากคนที่เปิดเซิร์ฟเวอร์" autocapitalize="none" spellcheck="false" />`) : ""}
                <button type="submit" class="${BTN} w-full" data-auth-submit>${isRegister ? "สมัครและเข้าใช้" : "เข้าสู่ระบบ"}</button>
                <p class="min-h-4 text-xs text-rose-300" data-auth-msg role="alert"></p>
                ${hasUsers ? /*html*/`
                    <button type="button" class="w-full text-center text-xs text-sky-300 hover:text-sky-200" data-mode="${isRegister ? "login" : "register"}" onclick="showAuth(this.dataset.mode)">
                        ${isRegister ? "มีบัญชีแล้ว · เข้าสู่ระบบ" : "ยังไม่มีบัญชี · สมัคร"}
                    </button>` : ""}
            </form>
        </div>
    `;
};

/* ------------------------------------ no chat yet */

/** A new account has no chats: make a character, or find one (or a friend) */
const noChatCard = (me) => /*html*/`
    <div class="grid flex-1 place-items-center p-4">
        <div class="${CARD} w-full max-w-sm space-y-4 p-5 text-center">
            <p class="text-4xl">👋</p>
            <div>
                <h2 class="text-base font-semibold text-white">สวัสดี ${esc(me?.name)}</h2>
                <p class="mt-1 text-sm text-slate-400">ยังไม่มีแชท สร้างตัวละครของคุณเอง หรือค้นหาตัวละครที่คนอื่นเปิดให้คุยได้</p>
            </div>
            <div class="grid gap-2">
                <button type="button" class="${BTN}" onclick="openBuilder()">+ สร้างตัวละคร</button>
                <button type="button" class="${BTN_GHOST}" onclick="openPeople()">🔎 ค้นหาตัวละคร / เพื่อน</button>
                <button type="button" class="text-xs text-slate-500 hover:text-slate-300" onclick="logout()">ออกจากระบบ</button>
            </div>
        </div>
    </div>
`;

/* ------------------------------------ chat list (inside the header menu) */

const avatar = (name, tone = "from-pink-400 to-sky-500") =>
    `<span class="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-gradient-to-br ${tone} text-sm font-bold text-slate-950">${initial(name)}</span>`;

/**
 * Characters you made or added, then friends. Ids come from data, so they go in data-* (see CLAUDE.md).
 * @param {{ chats: object, profileId: string, isOwner: boolean, isPublic: boolean, me: object }} state
 */
const chatListMenu = (state) => {
    const bots = state?.chats?.bots ?? [];
    const friends = state?.chats?.friends ?? [];
    const requests = state?.chats?.incoming?.length ?? 0;
    const row = (b) => /*html*/`
        <div class="flex items-center gap-1">
            <button type="button" data-id="${esc(b.id)}" onclick="switchProfile(this.dataset.id)"
                class="flex min-w-0 flex-1 items-center gap-2.5 rounded-xl px-2 py-2 text-left text-sm transition hover:bg-white/5 ${b.id === state?.profileId ? "bg-sky-500/10 ring-1 ring-inset ring-sky-400/30" : ""}">
                ${avatar(b.name)}
                <span class="min-w-0 flex-1">
                    <span class="block truncate text-white">${esc(b.name)}</span>
                    <span class="block truncate text-[11px] text-slate-500">${b.isOwner ? `ของฉัน${b.isPublic ? " · สาธารณะ" : " · ส่วนตัว"}` : "ตัวละครของคนอื่น"}</span>
                </span>
                ${b.id === state?.profileId ? `<span class="text-xs text-sky-300">✓</span>` : ""}
            </button>
            ${b.id === state?.profileId ? "" : b.isOwner
                ? `<button type="button" data-debug data-id="${esc(b.id)}" data-name="${esc(b.name)}" onclick="deleteProfile(this.dataset.id, this.dataset.name)" class="rounded-lg px-2 py-1 text-xs text-rose-300/70 hover:bg-rose-500/10 hover:text-rose-200" aria-label="ลบ ${esc(b.name)}">ลบ</button>`
                : `<button type="button" data-id="${esc(b.id)}" data-name="${esc(b.name)}" onclick="removeChat(this.dataset.id, this.dataset.name)" class="rounded-lg px-2 py-1 text-xs text-slate-500 hover:bg-white/5 hover:text-slate-300" aria-label="เอา ${esc(b.name)} ออกจากรายการ">ออก</button>`}
        </div>
    `;
    const friendRow = (f) => /*html*/`
        <button type="button" data-id="${esc(f.id)}" onclick="openDm(this.dataset.id)"
            class="flex w-full min-w-0 items-center gap-2.5 rounded-xl px-2 py-2 text-left text-sm transition hover:bg-white/5">
            ${avatar(f.name, "from-emerald-300 to-sky-400")}
            <span class="min-w-0 flex-1">
                <span class="block truncate text-white">${esc(f.name)} <span class="text-[11px] text-slate-500">@${esc(f.handle)}</span></span>
                <span class="block truncate text-[11px] text-slate-500">${f.last ? `${f.last.isMine ? "คุณ: " : ""}${esc(f.last.text)}` : "ยังไม่ได้คุยกัน"}</span>
            </span>
            ${f.unread ? `<span class="grid h-5 min-w-5 place-items-center rounded-full bg-sky-500 px-1.5 text-[11px] font-bold text-slate-950">${Number(f.unread)}</span>` : ""}
        </button>
    `;
    return /*html*/`
        <p class="px-2 pb-1 pt-1 ${EYEBROW}">ตัวละคร</p>
        ${bots.map(row).join("") || `<p class="px-2 py-1 text-xs text-slate-500">ยังไม่มี</p>`}
        <button type="button" onclick="createProfile(false)" class="w-full rounded-xl px-2 py-2 text-left text-sm text-sky-300 hover:bg-white/5">+ สร้างตัวละคร</button>
        ${state?.isOwner ? /*html*/`
            <button type="button" data-debug onclick="createProfile(true)" class="w-full rounded-xl px-2 py-2 text-left text-sm text-slate-300 hover:bg-white/5">⧉ คัดลอกตัวนี้ (ไม่เอาความจำ)</button>
            <label class="flex cursor-pointer items-center gap-2 rounded-xl px-2 py-2 text-sm text-slate-300 hover:bg-white/5">
                <input type="checkbox" ${state?.isPublic ? "checked" : ""} onchange="setPublic(this.checked)" />
                <span>ให้คนอื่นค้นเจอและเพิ่มแชทกับ${esc(state?.name)}ได้ <span class="block text-[11px] text-slate-500">ปิดแล้วคนใหม่ค้นไม่เจอ คนที่เพิ่มไว้แล้วยังคุยต่อได้</span></span>
            </label>` : ""}
        <a href="/api/profiles/history" download class="block w-full rounded-xl px-2 py-2 text-left text-sm text-slate-300 hover:bg-white/5">⬇ โหลดประวัติแชทนี้</a>
        <div class="my-1 h-px bg-white/5"></div>
        <p class="px-2 pb-1 pt-1 ${EYEBROW}">เพื่อน</p>
        ${friends.map(friendRow).join("") || `<p class="px-2 py-1 text-xs text-slate-500">ยังไม่มีเพื่อน</p>`}
        <button type="button" onclick="openPeople()" class="flex w-full items-center gap-2 rounded-xl px-2 py-2 text-left text-sm text-sky-300 hover:bg-white/5">
            🔎 ค้นหาเพื่อน / ตัวละคร
            ${requests ? `<span class="ml-auto rounded-full bg-pink-500 px-2 text-[11px] font-bold text-slate-950">${requests} คำขอ</span>` : ""}
        </button>
    `;
};

/** Who's signed in, and the admin's invite code */
const accountMenu = (me) => /*html*/`
    <div class="my-1 h-px bg-white/5"></div>
    <div class="flex items-center gap-2 px-2 py-1.5 text-sm">
        <span class="min-w-0 flex-1 truncate text-slate-300">${esc(me?.name)} <span class="text-xs text-slate-500">@${esc(me?.handle)}${me?.isAdmin ? " · ผู้ดูแลระบบ" : ""}</span></span>
        <button type="button" onclick="logout()" class="rounded-lg px-2 py-1 text-xs text-slate-400 hover:bg-white/5 hover:text-white">ออกจากระบบ</button>
    </div>
    ${me?.isAdmin ? /*html*/`
        <details class="rounded-xl px-2 py-1 text-sm text-slate-300" ontoggle="if (this.open) loadInvite()">
            <summary class="cursor-pointer py-1 hover:text-white">🎟 รหัสเชิญเพื่อนมาสมัคร</summary>
            <p class="mt-1 select-all rounded-lg bg-slate-950/70 p-2 font-mono text-sm text-sky-200" data-invite>…</p>
            <button type="button" onclick="rotateInvite()" class="mt-1 rounded-lg px-2 py-1 text-[11px] text-rose-300 hover:bg-rose-500/10">เปลี่ยนรหัส (รหัสเดิมใช้ไม่ได้อีก)</button>
        </details>` : ""}
`;

/* ------------------------------------ find people and characters */

const peoplePanel = /*html*/`
    <div class="fixed inset-0 z-50 hidden items-start justify-center bg-slate-950/80 p-4 pt-12 backdrop-blur" data-people onclick="if (event.target === this) closePeople()">
        <div class="flex max-h-[85vh] w-full max-w-lg flex-col gap-3 rounded-2xl border border-white/10 bg-slate-900 p-4 shadow-2xl">
            <div class="flex items-center gap-2">
                <input type="search" placeholder="ชื่อ หรือ @ไอดี ของเพื่อน / ชื่อตัวละคร" class="${INPUT}" data-people-input oninput="searchPeople(this.value)" aria-label="ค้นหาเพื่อนหรือตัวละคร" />
                <button type="button" onclick="closePeople()" class="rounded-full px-3 py-2 text-sm text-slate-400 hover:text-white" aria-label="ปิด">✕</button>
            </div>
            <div class="scroll-slim min-h-0 flex-1 space-y-3 overflow-y-auto" data-people-body></div>
        </div>
    </div>
`;

const STATUS_LABEL = { friend: "เป็นเพื่อนแล้ว", requested: "ส่งคำขอแล้ว", incoming: "เขาขอเป็นเพื่อน" };

/**
 * Requests waiting for you, then search results.
 * @param {{ incoming: object[], results: { people: object[], bots: object[] } | null, query: string }} data
 */
const peopleBody = ({ incoming = [], results = null, query = "" }) => {
    const section = (title, body) => `<div class="space-y-1"><p class="px-1 ${EYEBROW}">${title}</p>${body}</div>`;
    const person = (p, actions) => /*html*/`
        <div class="flex items-center gap-2.5 rounded-xl px-2 py-2 hover:bg-white/5">
            ${avatar(p.name, "from-emerald-300 to-sky-400")}
            <span class="min-w-0 flex-1 text-sm"><span class="block truncate text-white">${esc(p.name)}</span><span class="block truncate text-[11px] text-slate-500">@${esc(p.handle)}</span></span>
            ${actions}
        </div>
    `;
    const small = "rounded-lg px-2.5 py-1 text-xs font-semibold";
    const parts = [];
    if (incoming.length) {
        parts.push(section("คำขอเป็นเพื่อน", incoming.map((p) => person(p, /*html*/`
            <button type="button" data-id="${esc(p.id)}" onclick="answerFriend(this.dataset.id, true)" class="${small} bg-sky-500 text-slate-950 hover:bg-sky-400">รับ</button>
            <button type="button" data-id="${esc(p.id)}" onclick="answerFriend(this.dataset.id, false)" class="${small} text-slate-400 hover:bg-white/5">ไม่รับ</button>
        `)).join("")));
    }
    if (!results) {
        if (!parts.length) parts.push(`<p class="py-6 text-center text-sm text-slate-500">พิมพ์ชื่อ หรือ @ไอดี ที่เพื่อนใช้สมัคร หรือชื่อตัวละครที่เปิดเป็นสาธารณะ</p>`);
        return parts.join("");
    }
    const people = results.people ?? [];
    const bots = results.bots ?? [];
    if (!people.length && !bots.length) parts.push(`<p class="py-6 text-center text-sm text-slate-500">ไม่พบ "${esc(query)}"</p>`);
    if (people.length) {
        parts.push(section("คน", people.map((p) => person(p, p.status === "friend"
            ? `<button type="button" data-id="${esc(p.id)}" onclick="openDm(this.dataset.id)" class="${small} text-sky-300 hover:bg-white/5">แชท</button>`
            : p.status === "incoming"
                ? `<button type="button" data-id="${esc(p.id)}" onclick="answerFriend(this.dataset.id, true)" class="${small} bg-sky-500 text-slate-950 hover:bg-sky-400">รับเป็นเพื่อน</button>`
                : p.status
                    ? `<span class="text-[11px] text-slate-500">${STATUS_LABEL[p.status] ?? ""}</span>`
                    : `<button type="button" data-id="${esc(p.id)}" onclick="requestFriend(this.dataset.id)" class="${small} bg-sky-500 text-slate-950 hover:bg-sky-400">+ เพิ่มเพื่อน</button>`)).join("")));
    }
    if (bots.length) {
        parts.push(section("ตัวละคร", bots.map((b) => /*html*/`
            <div class="flex items-center gap-2.5 rounded-xl px-2 py-2 hover:bg-white/5">
                ${avatar(b.name)}
                <span class="min-w-0 flex-1 text-sm"><span class="block truncate text-white">${esc(b.name)}</span><span class="block truncate text-[11px] text-slate-500">${b.isOwner ? "ของฉัน" : `สร้างโดย ${esc(b.owner?.name ?? "")}`}</span></span>
                ${b.hasChat
                    ? `<button type="button" data-id="${esc(b.id)}" onclick="switchProfile(this.dataset.id)" class="${small} text-sky-300 hover:bg-white/5">เปิดแชท</button>`
                    : `<button type="button" data-id="${esc(b.id)}" onclick="addChat(this.dataset.id)" class="${small} bg-sky-500 text-slate-950 hover:bg-sky-400">+ เพิ่มแชท</button>`}
            </div>
        `).join("")));
    }
    return parts.join("");
};

/* ------------------------------------ chat with a friend */

const dmPanel = /*html*/`
    <div class="fixed inset-0 z-40 hidden flex-col bg-slate-950" data-dm>
        <div class="mx-auto flex h-full w-full max-w-3xl flex-col gap-3 px-4 py-3 sm:px-6 sm:py-5">
            <header class="${CARD} flex items-center gap-3 p-3">
                <button type="button" onclick="closeDm()" class="rounded-full px-2 py-1 text-lg text-slate-400 hover:text-white" aria-label="กลับ">←</button>
                <span class="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-emerald-300 to-sky-400 text-lg font-bold text-slate-950" data-dm-avatar></span>
                <span class="min-w-0 flex-1">
                    <span class="block truncate text-base font-semibold text-white" data-dm-name></span>
                    <span class="block truncate text-xs text-slate-400" data-dm-handle></span>
                </span>
            </header>
            <div class="${CARD} scroll-slim flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto p-3 sm:p-4" data-dm-messages></div>
            <form class="flex items-end gap-2" onsubmit="sendDm(event)">
                <textarea rows="1" class="${INPUT} max-h-40 resize-none" placeholder="พิมพ์ข้อความ" data-dm-input
                    onkeydown="if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); this.form.requestSubmit(); }"></textarea>
                <button type="submit" class="${BTN}">ส่ง</button>
            </form>
        </div>
    </div>
`;

const dmTime = (at) => new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

/** One message between two people */
const dmBubble = (m, myId) => {
    const isMine = m?.from === myId;
    return /*html*/`
        <div class="flex ${isMine ? "justify-end" : "justify-start"}" data-dm-msg="${esc(m?.id)}">
            <div class="flex max-w-[80%] items-end gap-1.5 ${isMine ? "flex-row-reverse" : ""}">
                <p class="whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2 text-sm ${isMine ? "rounded-br-md bg-sky-500 text-slate-950" : "rounded-bl-md bg-slate-800 text-slate-100"}">${esc(m?.text)}</p>
                <span class="shrink-0 pb-0.5 font-mono text-[10px] text-slate-500">${dmTime(m?.at)}</span>
            </div>
        </div>
    `;
};

export { authScreen, noChatCard, chatListMenu, accountMenu, peoplePanel, peopleBody, dmPanel, dmBubble };
