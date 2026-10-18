import { esc, CARD, EYEBROW, initial } from "./ui.js";

const TABS = [
    { id: "chat",  label: "แชท",      icon: "💬" },
    { id: "teach", label: "สอน",      icon: "✎" },
    { id: "logic", label: "editlogic", icon: "⚙" },
];

const BRAINS = [
    { id: "claude-code", title: "Claude ในเครื่อง", hint: "ใช้ Claude Code ที่ล็อกอินไว้ ไม่ต้องมี API key" },
    { id: "api",         title: "API key",          hint: "ใช้ ANTHROPIC_API_KEY ในไฟล์ .env" },
];

/** Readiness line for one brain option, so the user knows why it may fail before trying */
const brainState = (id, brain) => {
    if (id === "claude-code") {
        const cc = brain?.claudeCode ?? {};
        if (!cc.installed) return { ok: false, text: "ไม่พบ Claude Code ในเครื่อง" };
        if (!cc.loggedIn) return { ok: false, text: "ยังไม่ได้ล็อกอิน (พิมพ์ claude ใน terminal)" };
        return { ok: true, text: `พร้อม · ${esc(cc.model)}${cc.method ? ` · ${esc(cc.method)}` : ""}` };
    }
    const apiReady = Boolean(brain?.api?.ready);
    return { ok: apiReady, text: apiReady ? `พร้อม · ${esc(brain?.api?.model)}` : "ยังไม่ได้ใส่ key ใน .env" };
};

const brainPicker = (brain) => {
    const mode = brain?.mode ?? "claude-code";
    const current = BRAINS.find((b) => b.id === mode) ?? BRAINS[0];
    const isReady = brainState(mode, brain).ok;

    const option = (b) => {
        const s = brainState(b.id, brain);
        const isActive = b.id === mode;
        return /*html*/`
            <button type="button" onclick="setBrain('${b.id}')"
                class="flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left transition hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/60 ${isActive ? "bg-sky-500/10 ring-1 ring-inset ring-sky-400/30" : ""}">
                <span class="mt-1.5 h-2 w-2 shrink-0 rounded-full ${s.ok ? "bg-emerald-400" : "bg-amber-400"}"></span>
                <span class="min-w-0">
                    <span class="block text-sm font-semibold text-white">${b.title}${isActive ? " ✓" : ""}</span>
                    <span class="block text-xs text-slate-400">${b.hint}</span>
                    <span class="mt-0.5 block truncate text-[11px] ${s.ok ? "text-emerald-300/80" : "text-amber-300/80"}">${s.text}</span>
                </span>
            </button>
        `;
    };

    return /*html*/`
        <details class="group relative" data-brain-menu>
            <summary class="flex cursor-pointer list-none items-center gap-2 rounded-full bg-slate-950/60 px-3 py-1.5 text-xs font-medium text-slate-200 ring-1 ring-inset ring-white/10 transition hover:ring-sky-400/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/60 [&::-webkit-details-marker]:hidden">
                <span class="h-1.5 w-1.5 rounded-full ${isReady ? "bg-emerald-400" : "bg-amber-400"}"></span>
                <span class="hidden sm:inline">สมอง:</span> ${current.title}
                <span class="text-slate-500 transition group-open:rotate-180">▾</span>
            </summary>
            <div class="absolute right-0 z-30 mt-2 w-[min(20rem,calc(100vw-2rem))] space-y-1 rounded-2xl border border-white/10 bg-slate-900/95 p-2 shadow-2xl backdrop-blur">
                ${BRAINS.map(option).join("")}
                <button type="button" onclick="refreshBrain()" class="w-full rounded-lg px-3 py-1.5 text-left text-[11px] text-slate-500 hover:text-slate-300">↻ ตรวจสอบสถานะอีกครั้ง</button>
            </div>
        </details>
    `;
};

const tabs = (active) => /*html*/`
    <nav class="grid grid-cols-3 gap-1 rounded-2xl bg-slate-950/60 p-1 ring-1 ring-inset ring-white/5" role="tablist" aria-label="สลับแถบ" data-debug>
        ${TABS.map((t) => /*html*/`
            <button type="button" role="tab" data-tab-btn="${t.id}" aria-selected="${t.id === active}" onclick="switchTab('${t.id}')"
                class="flex items-center justify-center gap-1.5 rounded-xl px-2 py-2 text-sm font-semibold text-slate-400 transition hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/60 aria-selected:bg-sky-500 aria-selected:text-slate-950 aria-selected:shadow-[0_8px_24px_-12px_rgba(14,165,233,0.8)] sm:gap-2 sm:px-4">
                <span aria-hidden="true">${t.icon}</span><span class="truncate">${t.label}</span>
            </button>
        `).join("")}
    </nav>
`;

/** Debug line under the name: relationship stage and strongest feeling right now */
const subline = (status) => {
    const top = [ ...(status?.moods ?? []) ].sort((a, b) => b.value - a.value)[0];
    const parts = [ status?.stage, top ? `รู้สึก${top.name}` : "" ].filter(Boolean);
    return esc(parts.join(" · "));
};

/** Mask button that flips full role on and off; stays visible (but faint) in full role so it can be undone */
const fullRoleButton = (isOn) => /*html*/`
    <button type="button" onclick="toggleFullRole()" data-full-role-btn aria-pressed="${isOn}"
        title="โหมด full role: ซ่อนทุกอย่างที่บอกว่าเป็น AI (Ctrl+Shift+F)"
        class="grid h-8 w-8 shrink-0 place-items-center rounded-full text-base ring-1 ring-inset transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/60 ${isOn
            ? "text-slate-600 opacity-40 ring-transparent hover:opacity-100"
            : "bg-slate-950/60 text-slate-300 ring-white/10 hover:ring-pink-400/40"}">
        🎭
    </button>
`;

const linkBox = (u) => `<p class="mt-1 select-all break-all rounded-lg bg-slate-950/70 p-2 font-mono text-[11px] text-sky-200">${esc(u)}</p>`;

/** Links for other devices: the Cloudflare tunnel (anywhere) and the LAN (same Wi-Fi) */
const remoteLinks = (lan) => {
    const parts = [];
    if (lan?.tunnel) {
        parts.push(`<p class="mt-1 text-xs text-emerald-300">🌐 จากที่ไหนก็ได้ (Cloudflare Tunnel)</p>${linkBox(lan.tunnel)}`);
    } else if (lan?.isTunnelOn) {
        parts.push(`<p class="mt-1 text-xs text-slate-400">🌐 กำลังเปิด tunnel... ปิดเมนูแล้วเปิดใหม่ในอีกสักครู่</p>`);
    }
    if (lan?.urls?.length) parts.push(`<p class="mt-2 text-xs text-slate-400">📶 Wi-Fi เดียวกัน</p>${lan.urls.map(linkBox).join("")}`);
    if (!parts.length) {
        return `<p class="mt-1 text-xs text-slate-400">ใส่ <span class="font-mono text-sky-200">TUNNEL=1</span> (เปิดจากที่ไหนก็ได้ ต้องติดตั้ง cloudflared) หรือ <span class="font-mono text-sky-200">ALLOW_LAN=1</span> (Wi-Fi เดียวกัน) ในไฟล์ .env แล้วเปิดแอปใหม่</p>`;
    }
    return /*html*/`
        ${parts.join("")}
        <p class="mt-2 text-[11px] text-slate-500">ลิงก์มีรหัสอยู่ข้างใน ใครได้ไปก็เข้าแชทได้ อย่าแชร์ · เปิดครั้งเดียว เครื่องนั้นจะจำไว้</p>
        <button type="button" onclick="rotateKey()" class="mt-1 rounded-lg px-2 py-1 text-[11px] text-rose-300 hover:bg-rose-500/10">เปลี่ยนรหัส (ทุกเครื่องที่เคยเปิดต้องเปิดลิงก์ใหม่)</button>
    `;
};

/**
 * Character switcher plus app things (notifications, phone link). Opens from the avatar/name.
 * Delete and copy are debug-only so full role still feels like a plain chat app.
 */
const profileMenu = (state) => {
    const list = Array.isArray(state?.profiles) ? state.profiles : [];
    const lan = state?.lan;
    return /*html*/`
        <div class="absolute left-0 top-full z-30 mt-2 hidden w-[min(19rem,calc(100vw-2rem))] space-y-1 rounded-2xl border border-white/10 bg-slate-900/95 p-2 shadow-2xl backdrop-blur" data-profile-menu>
            <p class="px-2 pb-1 pt-1 ${EYEBROW}">แชท</p>
            ${list.map((p) => /*html*/`
                <div class="flex items-center gap-1">
                    <button type="button" data-id="${esc(p.id)}" onclick="switchProfile(this.dataset.id)"
                        class="flex min-w-0 flex-1 items-center gap-2.5 rounded-xl px-2 py-2 text-left text-sm transition hover:bg-white/5 ${p.id === state?.profileId ? "bg-sky-500/10 ring-1 ring-inset ring-sky-400/30" : ""}">
                        <span class="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-pink-400 to-sky-500 text-sm font-bold text-slate-950">${initial(p.name)}</span>
                        <span class="truncate text-white">${esc(p.name)}</span>
                        ${p.id === state?.profileId ? `<span class="ml-auto text-xs text-sky-300">✓</span>` : ""}
                    </button>
                    ${p.id === state?.profileId ? "" : `<button type="button" data-debug data-id="${esc(p.id)}" data-name="${esc(p.name)}" onclick="deleteProfile(this.dataset.id, this.dataset.name)" class="rounded-lg px-2 py-1 text-xs text-rose-300/70 hover:bg-rose-500/10 hover:text-rose-200" aria-label="ลบ ${esc(p.name)}">ลบ</button>`}
                </div>
            `).join("")}
            <button type="button" onclick="createProfile(false)" class="w-full rounded-xl px-2 py-2 text-left text-sm text-sky-300 hover:bg-white/5">+ ตัวละครใหม่</button>
            <button type="button" data-debug onclick="createProfile(true)" class="w-full rounded-xl px-2 py-2 text-left text-sm text-slate-300 hover:bg-white/5">⧉ คัดลอกตัวนี้ (ไม่เอาความจำ)</button>
            <div class="my-1 h-px bg-white/5"></div>
            <div data-notify-area></div>
            ${state?.isLocal ? /*html*/`
                <details class="rounded-xl px-2 py-1 text-sm text-slate-300" data-remote>
                    <summary class="cursor-pointer py-1 hover:text-white">📱 เปิดบนมือถือ / จากข้างนอก</summary>
                    <div data-remote-body>${remoteLinks(lan)}</div>
                </details>
            ` : ""}
        </div>
    `;
};

const header = (state) => /*html*/`
    <header class="${CARD} relative z-20 flex flex-col gap-3 p-3 sm:p-4">
        <div class="flex items-center gap-2 sm:gap-3">
            <div class="relative flex min-w-0 flex-1">
                <button type="button" onclick="toggleProfileMenu(event)" class="flex min-w-0 items-center gap-3 rounded-2xl text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/60" aria-label="เลือกแชท">
                    <span class="relative grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-pink-400 to-sky-500 text-lg font-bold text-slate-950 shadow-lg sm:h-12 sm:w-12" data-avatar>
                        ${initial(state?.name)}
                        <span class="absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full border-2 border-slate-900 bg-slate-500 transition-colors" data-online-dot></span>
                    </span>
                    <span class="min-w-0">
                        <span class="hidden sm:block ${EYEBROW}" data-debug>Broker</span>
                        <span class="flex items-center gap-1 truncate text-base font-semibold leading-tight text-white sm:text-lg"><span class="truncate" data-name>${esc(state?.name)}</span><span class="text-xs text-slate-500">▾</span></span>
                        <span class="block truncate text-xs text-slate-400">
                            <span data-presence>ออนไลน์</span><span data-debug> · <span data-subline>${subline(state?.status)}</span></span>
                        </span>
                    </span>
                </button>
                ${profileMenu(state)}
            </div>
            <button type="button" onclick="openSearch()" class="grid h-8 w-8 shrink-0 place-items-center rounded-full text-base text-slate-400 transition hover:bg-white/5 hover:text-white" aria-label="ค้นหาข้อความ">🔍</button>
            <div data-brain data-debug>${brainPicker(state?.brain)}</div>
            <div data-full-role-slot>${fullRoleButton(state?.isFullRole)}</div>
        </div>
        ${tabs(state?.tab ?? "chat")}
    </header>
`;

export { header, brainPicker, subline, fullRoleButton, remoteLinks };
