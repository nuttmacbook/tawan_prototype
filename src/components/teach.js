import { esc, CARD, EYEBROW, INPUT, BTN, BTN_GHOST } from "./ui.js";

const FEELINGS = [ "ดีใจ", "อบอุ่น", "เขิน", "ตื่นเต้น", "เป็นห่วง", "งอน", "เหงา", "ขำ", "ภูมิใจ", "เสียใจ" ];

const FILES = [
    { id: "persona",   label: "ตัวตน",      hint: "ชื่อ นิสัย ชีวิตประจำวัน วิธีพูด — ไฟล์หลักที่ควรแก้" },
    { id: "style",     label: "สไตล์พิมพ์",   hint: "ตัวอย่าง ❌/✅ คำต้องห้าม คลังคำแชท และค่าการพิมพ์ — ตัวกำหนดว่าพิมพ์เหมือนคนแค่ไหน" },
    { id: "teachings", label: "สิ่งที่สอน",   hint: "ได้ยินแบบนี้ → รู้สึกแบบนี้ → ตอบแบบนี้" },
    { id: "relation",  label: "รู้จักกันยังไง", hint: "ความสัมพันธ์ของเธอกับคุณ (แชทของคุณเท่านั้น คนอื่นที่เพิ่มแชทเริ่มแบบเพิ่งรู้จัก)" },
    { id: "memory",    label: "ความจำ",     hint: "เรื่องที่จำได้เกี่ยวกับคุณ แยกตามหัวข้อ (แชทของคุณเท่านั้น)" },
    { id: "state",     label: "อารมณ์",     hint: "ค่าอารมณ์และความสนิท แก้ตัวเลขหรือเพิ่มอารมณ์ใหม่ได้" },
    { id: "threads",   label: "เรื่องค้าง",   hint: "เรื่องที่รอถามต่อ" },
    { id: "diary",     label: "ไดอารี่",     hint: "ชีวิตของตัวละครเอง" },
    { id: "journal",   label: "บันทึกรายวัน", hint: "สรุปความทรงจำของแต่ละวัน" },
    { id: "people",    label: "คนรอบตัว",   hint: "ชื่อและเรื่องของคนในชีวิตเธอ ให้เล่าถึงใครก็ชื่อเดิม" },
    { id: "opinions",  label: "ความเห็น",    hint: "สิ่งที่เธอเคยบอกว่าชอบ ไม่ชอบ หรือคิดยังไง บรรทัดล่างสุดของแต่ละเรื่องคือตอนนี้" },
    { id: "dates",     label: "วันสำคัญ",    hint: "วันเกิดและวันที่ควรจำ รูปแบบ - เดือน-วัน | เรื่อง (ทุกปี) หรือ - ปี-เดือน-วัน | เรื่อง (ครั้งเดียว)" },
    { id: "today",     label: "วันนี้",      hint: "ระบบเขียนใหม่ทุกเช้าจากการค้นเน็ต: อากาศ ซีรี่ เรื่องที่สนใจ แผนของวัน" },
];

const field = (label, control, hint = "") => /*html*/`
    <label class="block space-y-1.5">
        <span class="text-xs font-medium text-slate-300">${label}${hint ? ` <span class="font-normal text-slate-500">${hint}</span>` : ""}</span>
        ${control}
    </label>
`;

/* ------------------------------------ teach form */

const teachForm = /*html*/`
    <form class="${CARD} space-y-4 p-4 sm:p-5" onsubmit="saveTeaching(event)" data-teach-form>
        <header>
            <p class="${EYEBROW}">สอนวิธีตอบ</p>
            <h2 class="text-base font-semibold text-white">เมื่อได้ยินแบบนี้ ให้รู้สึกและตอบแบบไหน</h2>
        </header>

        ${field("เมื่อได้ยิน", `<input name="trigger" required class="${INPUT}" placeholder='เช่น "เหนื่อยจัง" หรือ เวลาพี่บ่นเรื่องงาน' />`)}

        <div class="space-y-1.5">
            ${field("ควรรู้สึก", `<input name="feeling" class="${INPUT}" placeholder="เช่น เป็นห่วง อยากให้กำลังใจ" data-feeling-input />`)}
            <div class="flex flex-wrap gap-1.5">
                ${FEELINGS.map((f) => /*html*/`
                    <button type="button" onclick="pickFeeling('${f}')" class="rounded-full bg-slate-950/60 px-2.5 py-1 text-xs text-slate-300 ring-1 ring-inset ring-white/10 transition hover:bg-sky-500/15 hover:text-sky-200 hover:ring-sky-400/30">${f}</button>
                `).join("")}
            </div>
        </div>

        ${field("ควรตอบแนวไหน", `<textarea name="response" rows="2" class="${INPUT} resize-y" placeholder="เช่น ถามว่าเกิดอะไรขึ้น ชวนพักกินของอร่อย"></textarea>`)}
        ${field("ตัวอย่างคำตอบ", `<textarea name="example" rows="2" class="${INPUT} resize-y" placeholder="โอ๋ ๆ พี่ไปเจออะไรมา เล่าให้ฟังหน่อย"></textarea>`, "(ไม่บังคับ)")}

        <div class="flex items-center gap-2">
            <button type="submit" class="${BTN}" data-teach-submit>บันทึกสิ่งที่สอน</button>
            <button type="reset" class="${BTN_GHOST}">ล้างฟอร์ม</button>
            <span class="ml-auto truncate text-xs text-emerald-300" data-teach-msg role="status"></span>
        </div>
    </form>
`;

const rememberForm = /*html*/`
    <form class="${CARD} space-y-3 p-4 sm:p-5" onsubmit="rememberFact(event)">
        <header>
            <p class="${EYEBROW}">ให้จำ</p>
            <h2 class="text-base font-semibold text-white">บอกเรื่องที่อยากให้รู้</h2>
        </header>
        <div class="flex gap-2">
            <input name="topic" class="${INPUT} !w-32 shrink-0" placeholder="หัวข้อ" list="memory-topics" />
            <datalist id="memory-topics">
                <option value="เกี่ยวกับผู้ใช้"></option>
                <option value="ความชอบ"></option>
                <option value="งาน"></option>
                <option value="ครอบครัว"></option>
                <option value="ชื่อเรียก"></option>
                <option value="มุกภายใน"></option>
            </datalist>
            <input name="fact" required class="${INPUT}" placeholder="เช่น พี่แพ้กุ้ง" />
        </div>
        <div class="flex items-center gap-2">
            <button type="submit" class="${BTN}">จำไว้</button>
            <span class="truncate text-xs text-emerald-300" data-remember-msg role="status"></span>
        </div>
    </form>
`;

const styleForm = /*html*/`
    <form class="${CARD} space-y-3 p-4 sm:p-5" onsubmit="addSamples(event)">
        <header>
            <p class="${EYEBROW}">สไตล์การพิมพ์</p>
            <h2 class="text-base font-semibold text-white">ใส่ตัวอย่างแชทจริง</h2>
            <p class="text-xs text-slate-400">วางข้อความแชทจริงเพื่อให้จับโทนและคำ ใช้เฉพาะข้อความของคุณเองหรือของคนที่ยินยอม ลิงก์ เบอร์ และอีเมลจะถูกลบให้ · รองรับไฟล์ส่งออกแชทของ LINE</p>
            <p class="mt-1 text-xs text-slate-400">อีกวิธี: ในแถบแชท (ปิด full role) กด ✎ ข้างข้อความของเธอ แล้วพิมพ์ว่าคนจริงจะพิมพ์ยังไง</p>
        </header>
        <textarea name="text" rows="4" required class="${INPUT} resize-y font-mono !text-xs" placeholder="กินไรยังอ่ะ&#10;555555 ไม่ไหว&#10;เดะโทรไป"></textarea>
        <div class="flex flex-wrap items-center gap-2">
            <input name="speaker" class="${INPUT} !w-48" placeholder="เก็บเฉพาะชื่อผู้พูด (ไม่บังคับ)" aria-label="ชื่อผู้พูดที่จะเก็บ" />
            <button type="submit" class="${BTN}">เพิ่มเป็นตัวอย่าง</button>
            <span class="truncate text-xs text-emerald-300" data-samples-msg role="status"></span>
        </div>
    </form>
`;

/* ------------------------------------ lessons */

const lessonCard = (t, i) => /*html*/`
    <article class="space-y-1.5 rounded-xl bg-slate-950/50 p-3 ring-1 ring-inset ring-white/5" data-lesson="${esc(t.trigger.toLowerCase())}">
        <div class="flex items-start gap-2">
            <h3 class="min-w-0 flex-1 text-sm font-semibold text-sky-200">${t.trigger.includes('"') ? esc(t.trigger) : `“${esc(t.trigger)}”`}</h3>
            <button type="button" onclick="editTeaching(${i})" class="rounded-lg px-2 py-0.5 text-xs text-slate-400 hover:bg-white/5 hover:text-white" aria-label="แก้">แก้</button>
            <button type="button" onclick="deleteTeaching(${i})" class="rounded-lg px-2 py-0.5 text-xs text-rose-300/80 hover:bg-rose-500/10 hover:text-rose-200" aria-label="ลบ">ลบ</button>
        </div>
        ${t.feeling ? `<p class="text-xs text-slate-300"><span class="text-slate-500">รู้สึก</span> ${esc(t.feeling)}</p>` : ""}
        ${t.response ? `<p class="text-xs text-slate-300"><span class="text-slate-500">ตอบ</span> ${esc(t.response)}</p>` : ""}
        ${t.example ? `<p class="rounded-lg bg-slate-800/70 px-2.5 py-1.5 text-xs text-slate-200">${esc(t.example)}</p>` : ""}
    </article>
`;

const lessonList = (teachings) => {
    const list = Array.isArray(teachings) ? teachings : [];
    if (!list.length) return `<p class="py-6 text-center text-sm text-slate-500">ยังไม่ได้สอนอะไรเลย ลองเริ่มจากฟอร์มด้านซ้าย</p>`;
    return list.map(lessonCard).reverse().join("");
};

const lessons = (state) => /*html*/`
    <section class="${CARD} flex min-h-0 flex-col p-4 sm:p-5">
        <header class="mb-3 flex items-end gap-3">
            <div class="min-w-0 flex-1">
                <p class="${EYEBROW}">สิ่งที่สอนแล้ว</p>
                <h2 class="text-base font-semibold text-white"><span class="font-mono tabular-nums" data-lesson-count>${state?.teachings?.length ?? 0}</span> เรื่อง</h2>
            </div>
            <input type="search" placeholder="ค้นหา" oninput="filterLessons(this.value)" class="${INPUT} !w-36 !py-1.5" aria-label="ค้นหาสิ่งที่สอน" />
        </header>
        <div class="scroll-slim max-h-[32rem] space-y-2 overflow-y-auto pr-1" data-lessons>${lessonList(state?.teachings)}</div>
    </section>
`;

/* ------------------------------------ coach */

// Ids come from the server's data, so they go in data-* and are read back with this.dataset
const coachItem = (s) => /*html*/`
    <article class="space-y-1.5 rounded-xl bg-slate-950/50 p-3 ring-1 ring-inset ring-white/5">
        <p class="text-sm text-amber-200">${esc(s?.problem ?? "")} <span class="text-xs text-slate-500">${esc(s?.date ?? "")}</span></p>
        ${s?.quote ? `<p class="rounded-lg bg-slate-800/70 px-2.5 py-1.5 text-xs text-slate-300">“${esc(s.quote)}”</p>` : ""}
        <p class="text-xs text-slate-300"><span class="text-slate-500">ถ้า</span> ${esc(s?.lesson?.trigger ?? "")}</p>
        ${s?.lesson?.response ? `<p class="text-xs text-slate-300"><span class="text-slate-500">ตอบแบบ</span> ${esc(s.lesson.response)}</p>` : ""}
        ${s?.lesson?.example ? `<p class="text-xs text-sky-200"><span class="text-slate-500">เช่น</span> ${esc(s.lesson.example)}</p>` : ""}
        <div class="flex gap-2 pt-1">
            <button type="button" class="${BTN} !py-1 !text-xs" data-coach-id="${esc(s?.id ?? "")}" data-accept="1" onclick="decideCoach(this)">สอนแบบนี้</button>
            <button type="button" class="${BTN_GHOST} !py-1 !text-xs" data-coach-id="${esc(s?.id ?? "")}" data-accept="0" onclick="decideCoach(this)">ไม่เอา</button>
        </div>
    </article>
`;

const coachList = (suggestions) => {
    const list = Array.isArray(suggestions) ? suggestions : [];
    if (!list.length) return `<p class="py-4 text-center text-sm text-slate-500">ยังไม่มีข้อเสนอ โค้ชจะอ่านแชทของเมื่อวานให้วันละครั้ง</p>`;
    return [ ...list ].reverse().map(coachItem).join("");
};

const coachCard = (state) => /*html*/`
    <section class="${CARD} space-y-3 p-4 sm:p-5">
        <header class="flex items-end gap-3">
            <div class="min-w-0 flex-1">
                <p class="${EYEBROW}">โค้ชตรวจแชท</p>
                <h2 class="text-base font-semibold text-white">ตรงไหนที่เธอยังไม่เหมือนคน</h2>
                <p class="text-xs text-slate-400">กด "สอนแบบนี้" แล้วจะกลายเป็นสิ่งที่สอน ไม่กดก็ไม่มีอะไรเปลี่ยน</p>
            </div>
            <button type="button" class="${BTN_GHOST}" onclick="reviewCoach()" data-coach-review>ตรวจตอนนี้</button>
        </header>
        <p class="text-xs text-slate-400" data-coach-msg role="status"></p>
        <div class="scroll-slim max-h-[28rem] space-y-2 overflow-y-auto pr-1" data-coach-list>${coachList(state?.coach)}</div>
    </section>
`;

/* ------------------------------------ file editor */

const fileEditor = (state) => /*html*/`
    <section class="${CARD} space-y-3 p-4 sm:p-5">
        <header class="flex flex-wrap items-end gap-3">
            <div class="min-w-0 flex-1">
                <p class="${EYEBROW}">พัฒนาตัวตน</p>
                <h2 class="text-base font-semibold text-white">แก้ไฟล์ .md โดยตรง</h2>
                <p class="text-xs text-slate-400" data-file-hint>${FILES.find((f) => f.id === state?.file)?.hint ?? ""}</p>
            </div>
            <button type="button" class="${BTN_GHOST} text-xs" onclick="compactMemory()" data-compact-btn>✨ จัดระเบียบความจำ</button>
        </header>

        <div class="flex flex-wrap gap-1.5" role="tablist" aria-label="เลือกไฟล์">
            ${FILES.map((f) => /*html*/`
                <button type="button" role="tab" data-file-btn="${f.id}" aria-selected="${f.id === state?.file}" onclick="openFile('${f.id}')"
                    class="rounded-full px-3 py-1 text-xs font-medium text-slate-300 ring-1 ring-inset ring-white/10 transition hover:text-white aria-selected:bg-sky-500/15 aria-selected:text-sky-200 aria-selected:ring-sky-400/40">
                    ${f.label}
                </button>
            `).join("")}
        </div>

        <textarea data-file-text spellcheck="false" oninput="markFileDirty()" aria-label="เนื้อหาไฟล์"
            class="scroll-slim h-[26rem] w-full resize-y rounded-xl border border-white/5 bg-slate-950/70 p-4 font-mono text-[13px] leading-relaxed text-slate-200 ring-1 ring-inset ring-white/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/60"></textarea>

        <div class="flex items-center gap-2">
            <button type="button" class="${BTN}" onclick="saveFile()" data-file-save>บันทึกไฟล์</button>
            <button type="button" class="${BTN_GHOST}" onclick="openFile()">โหลดใหม่</button>
            <button type="button" class="${BTN_GHOST}" onclick="refreshToday()" data-today-refresh ${state?.file === "today" ? "" : "hidden"}>ค้นเน็ตใหม่ตอนนี้</button>
            <span class="ml-auto truncate text-xs text-slate-400" data-file-msg role="status">มีผลทันทีในข้อความถัดไป</span>
        </div>
    </section>
`;

/* ------------------------------------ snapshots */

const snapshotList = (snapshots) => {
    const list = Array.isArray(snapshots) ? snapshots : [];
    if (!list.length) return `<p class="text-xs text-slate-500">ยังไม่มี · ระบบสำรองให้เองวันละครั้ง และก่อนแก้ไฟล์หรือจัดระเบียบความจำ</p>`;
    return list.slice(0, 15).map((x) => /*html*/`
        <div class="flex items-center gap-2 text-xs">
            <span class="shrink-0 font-mono tabular-nums text-slate-500">${esc(x.id.slice(5, 16).replace(/^(\d{2})-(\d{2})-(\d{2})-(\d{2})$/, "$1/$2 $3:$4"))}</span>
            <span class="min-w-0 flex-1 truncate text-slate-300" title="${esc(x.label)}">${esc(x.label)}</span>
            <button type="button" data-id="${esc(x.id)}" onclick="restoreSnapshot(this.dataset.id)" class="shrink-0 rounded-lg px-2 py-0.5 text-sky-300 hover:bg-sky-500/10">ย้อน</button>
        </div>
    `).join("");
};

const snapshotsCard = (state) => /*html*/`
    <section class="${CARD} space-y-3 p-4 sm:p-5">
        <header class="flex items-end gap-3">
            <div class="min-w-0 flex-1">
                <p class="${EYEBROW}">จุดสำรองความจำ</p>
                <h2 class="text-base font-semibold text-white">ย้อนความจำของ ${esc(state?.name)}</h2>
                <p class="text-xs text-slate-400">สำรองตัวตน สไตล์ ความจำ อารมณ์ ไดอารี่ และประวัติแชท (ไม่รวมรูป) · ก่อนย้อนจะสำรองสถานะปัจจุบันไว้ให้ก่อน</p>
            </div>
            <button type="button" class="${BTN_GHOST} shrink-0 text-xs" onclick="createSnapshot()">สำรองตอนนี้</button>
        </header>
        <div class="space-y-1.5" data-snapshots>${snapshotList(state?.snapshots)}</div>
    </section>
`;

/* ------------------------------------ move, share, back up */

const portableCard = (state) => /*html*/`
    <section class="${CARD} space-y-3 p-4 sm:p-5">
        <header>
            <p class="${EYEBROW}">ย้าย · แชร์ · สำรอง</p>
            <h2 class="text-base font-semibold text-white">ไฟล์ตัวละคร</h2>
            <p class="text-xs text-slate-400">ตัวละครหนึ่งตัวเป็นไฟล์ <span class="font-mono">.persona.json</span> ไฟล์เดียว ใช้ย้ายเครื่อง อัปเดตแอป หรือส่งให้เพื่อน</p>
        </header>

        <div class="grid gap-2 sm:grid-cols-2">
            <div class="space-y-1.5 rounded-xl bg-slate-950/50 p-3 ring-1 ring-inset ring-white/5">
                <p class="text-sm font-semibold text-white">ทั้งหมด</p>
                <p class="text-xs text-slate-400">ตัวตน สไตล์ สิ่งที่สอน ความจำ อารมณ์ ไดอารี่ และประวัติแชท สำหรับย้ายเครื่องหรือเก็บสำรอง</p>
                <label class="flex items-center gap-2 text-xs text-slate-400"><input type="checkbox" class="h-3.5 w-3.5 accent-sky-500" data-export-images /> รวมรูปที่ส่งด้วย (ไฟล์ใหญ่ขึ้น)</label>
                <button type="button" class="${BTN} w-full !py-2 text-xs" onclick="exportProfile('full')">⬇ ดาวน์โหลดทั้งหมด</button>
            </div>
            <div class="space-y-1.5 rounded-xl bg-slate-950/50 p-3 ring-1 ring-inset ring-white/5">
                <p class="text-sm font-semibold text-white">แค่ตัวตน</p>
                <p class="text-xs text-slate-400">ตัวตน สไตล์ และสิ่งที่สอนเท่านั้น ไม่มีความจำหรือแชทของคุณ ปลอดภัยสำหรับส่งให้คนอื่น</p>
                <button type="button" class="${BTN_GHOST} w-full !py-2 text-xs" onclick="exportProfile('identity')">⬇ ดาวน์โหลดแค่ตัวตน</button>
            </div>
        </div>

        <label class="flex cursor-pointer items-center justify-center gap-2 rounded-xl border border-dashed border-white/15 px-3 py-3 text-sm text-slate-300 transition hover:border-sky-400/50 hover:text-white">
            ⬆ นำเข้าไฟล์ตัวละคร (สร้างเป็นตัวใหม่ ไม่ทับของเดิม)
            <input type="file" accept=".json,application/json" class="sr-only" onchange="importProfile(this)" />
        </label>

        <div class="space-y-1 rounded-xl bg-slate-950/50 p-3 ring-1 ring-inset ring-white/5" data-backup-box>
            <p class="text-sm font-semibold text-white">สำรองไปโฟลเดอร์นอก</p>
            <p class="text-xs text-slate-400" data-backup-info>กำลังโหลด...</p>
            <div class="hidden" data-backup-btn>
                <button type="button" class="${BTN_GHOST} !py-1.5 text-xs" onclick="backupNow()">สำรองตอนนี้</button>
            </div>
        </div>
        <p class="truncate text-xs text-emerald-300" data-portable-msg role="status"></p>
    </section>
`;

/* ------------------------------------ app settings */

/**
 * One row per setting. The list (labels, limits) comes from the server, so a new setting
 * only needs adding in server/config.js.
 * @param {{ fields?: { key: string, type: string, label: string, min?: number, max?: number }[], values?: object }} config
 */
const configFields = (config) => {
    const fields = Array.isArray(config?.fields) ? config.fields : [];
    if (!fields.length) return `<p class="text-xs text-slate-500">กำลังโหลด...</p>`;
    return fields.map((f) => {
        const value = config?.values?.[f.key];
        const control = f.type === "bool"
            ? `<input type="checkbox" class="h-4 w-4 shrink-0 accent-sky-500" data-config-key="${esc(f.key)}" ${value ? "checked" : ""} />`
            : `<input type="number" inputmode="numeric" class="${INPUT} !w-28 shrink-0 !py-1.5 text-right" data-config-key="${esc(f.key)}" min="${Number(f.min ?? 0)}" max="${Number(f.max ?? 0)}" value="${esc(value)}" />`;
        return /*html*/`
            <label class="flex items-center gap-3 text-xs text-slate-300">
                <span class="min-w-0 flex-1">${esc(f.label)}</span>
                ${control}
            </label>
        `;
    }).join("");
};

const settingsCard = (state) => /*html*/`
    <section class="${CARD} space-y-3 p-4 sm:p-5">
        <header>
            <p class="${EYEBROW}">ตั้งค่าแอป</p>
            <h2 class="text-base font-semibold text-white">จังหวะทัก · ความจำ · แจ้งเตือน</h2>
            <p class="text-xs text-slate-400">ใช้กับทุกตัวละคร มีผลทันทีไม่ต้องรีสตาร์ท · ค่าเริ่มต้นมาจากไฟล์ .env</p>
        </header>
        <div class="space-y-2" data-config-fields>${configFields(state?.config)}</div>
        <div class="flex items-center gap-2">
            <button type="button" class="${BTN} !py-2 text-xs" onclick="saveConfig()">บันทึกการตั้งค่า</button>
            <span class="truncate text-xs text-slate-400" data-config-msg role="status"></span>
        </div>
    </section>
`;

const teachPanel = (state) => /*html*/`
    <section data-tab-panel="teach" class="scroll-slim min-h-0 flex-1 space-y-3 overflow-y-auto pb-2 ${state?.tab === "teach" ? "" : "hidden"}">
        <div class="grid gap-3 lg:grid-cols-2">
            <div class="space-y-3">
                ${teachForm}
                ${rememberForm}
                ${styleForm}
            </div>
            ${lessons(state)}
        </div>
        ${coachCard(state)}
        ${fileEditor(state)}
        <div class="grid gap-3 lg:grid-cols-2">
            ${snapshotsCard(state)}
            ${portableCard(state)}
        </div>
        ${settingsCard(state)}
    </section>
`;

export { teachPanel, lessonList, snapshotList, configFields, coachList, FILES };
