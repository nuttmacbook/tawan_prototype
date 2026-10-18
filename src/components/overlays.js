import { esc, INPUT } from "./ui.js";

const SCRIM = "fixed inset-0 z-50 hidden bg-slate-950/80 backdrop-blur";

/** Full-screen picture viewer; any click closes it */
const imageViewer = /*html*/`
    <div class="${SCRIM} cursor-zoom-out place-items-center p-4" data-image-viewer onclick="this.classList.add('hidden'); this.classList.remove('grid')">
        <img alt="รูปขนาดเต็ม" class="max-h-full max-w-full rounded-2xl object-contain" data-image-full />
    </div>
`;

const searchPanel = /*html*/`
    <div class="${SCRIM} items-start justify-center p-4 pt-16" data-search onclick="if (event.target === this) closeSearch()">
        <div class="flex max-h-[80vh] w-full max-w-lg flex-col gap-3 rounded-2xl border border-white/10 bg-slate-900 p-4 shadow-2xl">
            <div class="flex items-center gap-2">
                <input type="search" placeholder="ค้นหาข้อความในแชท" class="${INPUT}" data-search-input oninput="runSearch(this.value)" aria-label="ค้นหาข้อความ" />
                <button type="button" onclick="closeSearch()" class="rounded-full px-3 py-2 text-sm text-slate-400 hover:text-white" aria-label="ปิด">✕</button>
            </div>
            <div class="scroll-slim min-h-0 flex-1 space-y-1 overflow-y-auto" data-search-results>
                <p class="py-6 text-center text-sm text-slate-500">พิมพ์คำที่อยากหา</p>
            </div>
        </div>
    </div>
`;

/** @param {{ date: string, time: string, who: string, text: string }[]} results */
const searchResults = (results, query, name) => {
    if (!results?.length) return `<p class="py-6 text-center text-sm text-slate-500">ไม่พบ "${esc(query)}"</p>`;
    const q = String(query ?? "").toLowerCase();
    const mark = (text) => {
        const t = String(text ?? "");
        const i = t.toLowerCase().indexOf(q);
        if (i < 0 || !q) return esc(t);
        return `${esc(t.slice(0, i))}<mark class="rounded bg-sky-400/30 px-0.5 text-white">${esc(t.slice(i, i + q.length))}</mark>${esc(t.slice(i + q.length))}`;
    };
    return results.map((r) => /*html*/`
        <div class="rounded-xl px-3 py-2 hover:bg-white/5">
            <p class="text-[11px] text-slate-500"><span class="font-mono tabular-nums">${esc(r.date)} ${esc(r.time)}</span> · ${r.who === "user" ? "คุณ" : esc(name)}</p>
            <p class="break-words text-sm text-slate-200">${mark(r.text.replace(/\[รูป:[^\]]+\]/g, "📷").replace(/^\[ตอบกลับ "[^"]*"\]\s*/, "↩ "))}</p>
        </div>
    `).join("");
};

/** Shown on every other tab/device once this chat is opened somewhere else */
const elsewhereOverlay = /*html*/`
    <div class="${SCRIM} place-items-center p-6 text-center" data-elsewhere>
        <div class="max-w-xs space-y-4">
            <p class="text-4xl">📱</p>
            <p class="text-sm text-slate-200">แชทนี้เปิดใช้งานอยู่ในแท็บหรือเครื่องอื่น</p>
            <button type="button" onclick="useHere()" class="rounded-xl bg-sky-500 px-4 py-2.5 text-sm font-semibold text-slate-950 hover:bg-sky-400">ใช้ที่นี่แทน</button>
        </div>
    </div>
`;

const overlays = `${imageViewer}${searchPanel}${elsewhereOverlay}`;

export { overlays, searchResults };
