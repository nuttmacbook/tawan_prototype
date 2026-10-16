import { esc, CARD, EYEBROW, BTN, BTN_GHOST } from "./ui.js";

const SUGGESTIONS = [
    "ให้มะลิอ่านข้อความช้าลงตอนกลางคืน",
    "ตอนงอน ให้ตอบสั้นแค่คำเดียว",
    "เพิ่มอารมณ์ \"หึง\" ที่ขึ้นเมื่อพี่พูดถึงคนอื่น",
    "ความสนิทเพิ่มเร็วขึ้นสองเท่า",
    "เปลี่ยนสีแชทของผู้ใช้เป็นสีชมพู",
];

const TOOL_LABEL = {
    Read: "อ่าน",
    Edit: "แก้",
    Write: "เขียน",
    Glob: "ค้นหาไฟล์",
    Grep: "ค้นหาในโค้ด",
};

/* ------------------------------------ run log */

/**
 * One event from the editlogic run, as it streams in from Claude Code.
 * @param {{ kind: string, text?: string, tool?: string, file?: string, pattern?: string, changed?: string[], needsRestart?: boolean, backupId?: string }} e
 */
const logicEvent = (e) => {
    if (e?.kind === "user") {
        return /*html*/`
            <div class="flex justify-end pt-2">
                <p class="max-w-[90%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-sky-500 px-3.5 py-2 text-sm text-slate-950">${esc(e.text)}</p>
            </div>
        `;
    }
    if (e?.kind === "text") {
        return `<p class="whitespace-pre-wrap text-sm leading-relaxed text-slate-200">${esc(e.text)}</p>`;
    }
    if (e?.kind === "tool") {
        const isWrite = e.tool === "Edit" || e.tool === "Write";
        return /*html*/`
            <div class="flex items-center gap-2 text-xs ${isWrite ? "text-amber-200" : "text-slate-500"}">
                <span class="font-mono">${isWrite ? "✎" : "·"}</span>
                <span>${esc(TOOL_LABEL[e.tool] ?? e.tool)}</span>
                <span class="truncate font-mono">${esc(e.file || e.pattern)}</span>
            </div>
        `;
    }
    if (e?.kind === "error") {
        return `<p class="rounded-xl bg-rose-500/10 px-3 py-2 text-xs text-rose-200 ring-1 ring-inset ring-rose-400/20">${esc(e.text)}</p>`;
    }
    if (e?.kind === "finished") {
        const changed = Array.isArray(e.changed) ? e.changed : [];
        return /*html*/`
            <div class="space-y-2 rounded-xl bg-slate-950/60 p-3 ring-1 ring-inset ring-white/5">
                <p class="text-xs font-semibold text-emerald-300">${changed.length ? `✓ แก้ ${changed.length} ไฟล์` : "✓ เสร็จแล้ว (ไม่ได้แก้ไฟล์)"}</p>
                ${changed.map((f) => `<p class="truncate font-mono text-[11px] text-slate-400">${esc(f)}</p>`).join("")}
                <div class="flex flex-wrap gap-2 pt-1">
                    ${e.needsRestart
                        ? `<button type="button" class="${BTN} !py-1.5 text-xs" onclick="restartServer('${esc(e.backupId)}')">↻ รีสตาร์ทให้ใช้โค้ดใหม่</button>`
                        : changed.length ? `<button type="button" class="${BTN} !py-1.5 text-xs" onclick="location.reload()">↻ โหลดหน้าใหม่</button>` : ""}
                    ${changed.length ? `<button type="button" class="${BTN_GHOST} !py-1.5 text-xs" onclick="restoreBackup('${esc(e.backupId)}')">↶ ย้อนกลับ</button>` : ""}
                </div>
            </div>
        `;
    }
    return "";
};

const working = /*html*/`
    <div class="flex items-center gap-2 text-xs text-slate-400" data-logic-working>
        <span class="flex gap-1"><span class="typing-dot h-1.5 w-1.5 rounded-full bg-sky-300"></span><span class="typing-dot h-1.5 w-1.5 rounded-full bg-sky-300"></span><span class="typing-dot h-1.5 w-1.5 rounded-full bg-sky-300"></span></span>
        Claude กำลังแก้ระบบ...
    </div>
`;

/* ------------------------------------ backups */

const backupList = (backups) => {
    const list = Array.isArray(backups) ? backups : [];
    if (!list.length) return `<p class="text-xs text-slate-500">ยังไม่มี</p>`;
    return list.slice(0, 12).map((b) => /*html*/`
        <div class="flex items-center gap-2 text-xs">
            <span class="shrink-0 font-mono tabular-nums text-slate-500">${esc(b.id.slice(5, 16).replace("T", " "))}</span>
            <span class="min-w-0 flex-1 truncate text-slate-300" title="${esc(b.label)}">${esc(b.label)}</span>
            <button type="button" onclick="restoreBackup('${esc(b.id)}')" class="shrink-0 rounded-lg px-2 py-0.5 text-sky-300 hover:bg-sky-500/10">ย้อน</button>
        </div>
    `).join("");
};

/* ------------------------------------ panel */

const logicPanel = (state) => /*html*/`
    <section data-tab-panel="logic" data-debug class="scroll-slim min-h-0 flex-1 overflow-y-auto pb-2 ${state?.tab === "logic" ? "" : "hidden"}">
        <div class="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">

            <!-- สั่งแก้ด้วยภาษาคน -->
            <div class="${CARD} flex min-h-[32rem] flex-col p-4 sm:p-5">
                <header class="mb-3 flex items-start gap-3">
                    <div class="min-w-0 flex-1">
                        <p class="${EYEBROW}">editlogic</p>
                        <h2 class="text-base font-semibold text-white">สั่งแก้เงื่อนไขของระบบ</h2>
                        <p class="text-xs text-slate-400">Claude ในเครื่องอ่านและแก้โค้ดได้ แต่รันคำสั่งไม่ได้ · สำรองไฟล์ให้ก่อนทุกครั้ง</p>
                    </div>
                    <button type="button" class="${BTN_GHOST} shrink-0 text-xs" onclick="resetLogic()">เริ่มใหม่</button>
                </header>

                <div class="scroll-slim flex-1 space-y-2.5 overflow-y-auto rounded-xl bg-slate-950/40 p-3 ring-1 ring-inset ring-white/5" data-logic-log>
                    <p class="text-xs text-slate-500" data-logic-empty>เล่าว่าอยากให้ระบบทำงานต่างจากเดิมยังไง เช่น ตอบช้าลง อารมณ์หายช้าลง หรือเปลี่ยนหน้าตา</p>
                </div>

                <div class="mt-3 flex flex-wrap gap-1.5">
                    ${SUGGESTIONS.map((s) => /*html*/`
                        <button type="button" onclick="useLogicSuggestion(this)" class="rounded-full bg-slate-950/60 px-2.5 py-1 text-[11px] text-slate-300 ring-1 ring-inset ring-white/10 transition hover:text-sky-200 hover:ring-sky-400/30">${esc(s)}</button>
                    `).join("")}
                </div>

                <form class="mt-3 flex items-end gap-2" onsubmit="runLogic(event)">
                    <textarea data-logic-input rows="2" placeholder="อยากให้แก้อะไร..." onkeydown="onLogicKey(event)" aria-label="สิ่งที่อยากให้แก้"
                        class="scroll-slim max-h-40 min-h-[3rem] flex-1 resize-y rounded-2xl border border-white/5 bg-slate-950/70 px-4 py-2.5 text-sm text-white placeholder:text-slate-500 ring-1 ring-inset ring-white/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/60"></textarea>
                    <button type="submit" class="${BTN}" data-logic-send>สั่งแก้</button>
                </form>
            </div>

            <!-- ดู/แก้โค้ดเอง -->
            <div class="space-y-3">
                <section class="${CARD} space-y-3 p-4 sm:p-5">
                    <header class="flex flex-wrap items-end gap-2">
                        <div class="min-w-0 flex-1">
                            <p class="${EYEBROW}">โค้ดระบบ</p>
                            <h2 class="text-base font-semibold text-white">ดูหรือแก้เอง</h2>
                        </div>
                        <select data-code-select onchange="openCode(this.value)" aria-label="เลือกไฟล์โค้ด"
                            class="max-w-full rounded-xl border border-white/5 bg-slate-950/70 px-3 py-1.5 font-mono text-xs text-slate-200 ring-1 ring-inset ring-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/60">
                        </select>
                    </header>
                    <textarea data-code-text spellcheck="false" oninput="markCodeDirty()" aria-label="เนื้อหาโค้ด"
                        class="scroll-slim h-[22rem] w-full resize-y whitespace-pre rounded-xl border border-white/5 bg-slate-950/80 p-4 font-mono text-[12px] leading-relaxed text-slate-200 ring-1 ring-inset ring-white/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/60"></textarea>
                    <div class="flex flex-wrap items-center gap-2">
                        <button type="button" class="${BTN}" onclick="saveCode()">บันทึก</button>
                        <button type="button" class="${BTN_GHOST}" onclick="openCode()">โหลดใหม่</button>
                        <button type="button" class="${BTN_GHOST}" onclick="restartServer()">↻ รีสตาร์ทเซิร์ฟเวอร์</button>
                        <span class="ml-auto truncate text-xs text-slate-400" data-code-msg role="status"></span>
                    </div>
                </section>

                <section class="${CARD} space-y-2 p-4 sm:p-5">
                    <p class="${EYEBROW}">จุดย้อนกลับ</p>
                    <div class="space-y-1.5" data-backups>${backupList(state?.backups)}</div>
                </section>
            </div>
        </div>
    </section>
`;

export { logicPanel, logicEvent, backupList, working as logicWorking };
