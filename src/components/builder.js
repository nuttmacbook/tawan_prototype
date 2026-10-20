import { esc, INPUT, BTN, BTN_GHOST, EYEBROW } from "./ui.js";

/* ------------------------------------ new character form */

// Fill in who she is, then "สร้างและเริ่มแชท" writes her files (server/builder.js) and opens a new chat.
// Every field is optional except the name; empty ones keep the template's defaults.

const field = (label, control, hint = "") => /*html*/`
    <label class="block space-y-1">
        <span class="text-xs font-medium text-slate-300">${label}${hint ? ` <span class="font-normal text-slate-500">${hint}</span>` : ""}</span>
        ${control}
    </label>
`;
const input = (name, placeholder = "", type = "text", extra = "") =>
    `<input name="${name}" type="${type}" placeholder="${esc(placeholder)}" class="${INPUT}" ${extra} />`;
const area = (name, placeholder = "", rows = 3) =>
    `<textarea name="${name}" rows="${rows}" placeholder="${esc(placeholder)}" class="${INPUT} resize-y"></textarea>`;
const group = (title, body, isOpen = false) => /*html*/`
    <details class="rounded-xl bg-slate-950/40 p-3 ring-1 ring-inset ring-white/5" ${isOpen ? "open" : ""}>
        <summary class="cursor-pointer select-none text-sm font-semibold text-sky-200">${title}</summary>
        <div class="mt-3 grid gap-3 sm:grid-cols-2">${body}</div>
    </details>
`;
const wide = (html) => `<div class="sm:col-span-2">${html}</div>`;

const builderPanel = /*html*/`
    <div class="fixed inset-0 z-50 hidden items-start justify-center overflow-y-auto bg-slate-950/80 p-4 backdrop-blur" data-builder onclick="if (event.target === this) closeBuilder()">
        <form class="my-6 w-full max-w-2xl space-y-3 rounded-2xl border border-white/10 bg-slate-900 p-4 shadow-2xl sm:p-5" data-builder-form onsubmit="buildCharacter(event)" oninput="saveBuilderDraft()">
            <header class="flex items-start gap-3">
                <div class="min-w-0 flex-1">
                    <p class="${EYEBROW}">สร้างตัวละครใหม่</p>
                    <h2 class="text-base font-semibold text-white">กรอกเท่าที่อยากกำหนด ที่เหลือแก้ทีหลังได้ในแถบสอน</h2>
                </div>
                <button type="button" onclick="closeBuilder()" class="rounded-full px-3 py-1 text-sm text-slate-400 hover:text-white" aria-label="ปิด">✕</button>
            </header>

            ${group("1 · ข้อมูลพื้นฐาน", [
                field("ชื่อ *", input("name", "เช่น ฟ้า", "text", "required maxlength=\"40\"")),
                field("อายุ", input("age", "18 ปีขึ้นไป", "number", "min=\"18\" max=\"99\"")),
                field("เพศ", input("gender", "เช่น หญิง")),
                field("อาชีพ", input("job", "เช่น บาริสต้า ทำงานพาร์ทไทม์")),
                field("อยู่ที่", input("livesIn", "เช่น ห้องเช่าใกล้มหาลัย")),
                field("เมือง", input("city", "เมืองจริง เช่น เชียงใหม่"), "(ใช้ค้นอากาศ/ข่าวรอบตัว)"),
                field("ชอบ", input("likes", "กาแฟ, แมว, ซีรี่เกาหลี")),
                field("ไม่ชอบ", input("dislikes", "ฝนตก, คนมาสาย")),
            ].join(""), true)}

            ${group("2 · นิสัยและวิธีพูด", [
                wide(field("นิสัย", area("personality", "บรรทัดละข้อ เช่น\nขี้เล่นแต่ปากแข็ง\nใจดีกับสัตว์\nขี้ลืม", 4))),
                field("แทนตัวเองว่า", input("selfRef", "เช่น ฟ้า, เรา")),
                field("เรียกคุณว่า", input("callUser", "เช่น พี่, แก, ชื่อเล่นคุณ")),
                wide(field("คำลงท้ายที่ใช้บ่อย", input("particles", "อ่ะ, นะ, แหละ, ดิ"))),
                wide(field("ตัวอย่างประโยคที่เธอพิมพ์", area("samples", "บรรทัดละประโยค เช่น\nโห้ยยย ง่วงงง\nไปไหนมาาา\n555 บ้าป่ะ", 4), "(ช่วยให้พิมพ์เหมือนคนที่สุด)")),
                wide(field("เรื่องราวของเธอ", area("backstory", "ภูมิหลัง ครอบครัว ความฝัน เรื่องที่ผ่านมา", 4))),
            ].join(""))}

            ${group("3 · ความสัมพันธ์และความทรงจำ", [
                field("ตอนนี้เป็นอะไรกับคุณ", /*html*/`
                    <select name="relation" class="${INPUT}">
                        <option value="stranger">เพิ่งรู้จักกัน</option>
                        <option value="friend">เพื่อน</option>
                        <option value="close">เพื่อนสนิท</option>
                        <option value="family">สนิทมาก</option>
                    </select>`),
                field("รู้จักกันจาก", input("howMet", "เช่น เป็นลูกค้าประจำที่ร้าน")),
                wide(field("แชทนี้เริ่มยังไง", input("firstChat", "เช่น เมื่อวานพี่ขอไลน์ที่ร้าน นี่เป็นข้อความแรก"), "(ให้ข้อความแรกของเธอมีที่มา)")),
                wide(field("สิ่งที่เธอรู้เกี่ยวกับคุณอยู่แล้ว", area("memories", "บรรทัดละเรื่อง เช่น\nชอบอเมริกาโน่เย็น\nทำงานเป็นโปรแกรมเมอร์\nมีแมวชื่อข้าวเหนียว", 4), "(เป็นความจำเริ่มต้น)")),
                wide(field("คนรอบตัวเธอ", area("people", "บรรทัดละคน: ชื่อ - เป็นใคร เช่น\nมิ้นท์ - เพื่อนร่วมงานที่ร้าน\nแม่ - อยู่ต่างจังหวัด โทรมาทุกอาทิตย์", 3))),
            ].join(""))}

            ${group("4 · จังหวะชีวิต", [
                field("ตื่นกี่โมง", input("wake", "8", "number", "min=\"0\" max=\"23\"")),
                field("นอนกี่โมง", input("sleep", "23", "number", "min=\"0\" max=\"23\"")),
                field("ความเร็วพิมพ์", input("typing", "6", "number", "min=\"2\" max=\"14\""), "(ตัวอักษรต่อวินาที)"),
            ].join(""))}

            <label class="flex items-start gap-2 rounded-xl bg-sky-500/5 p-3 text-sm text-slate-200 ring-1 ring-inset ring-sky-400/20">
                <input type="checkbox" name="useAI" class="mt-1" checked />
                <span>ให้ AI ช่วยเติมรายละเอียด (นิสัยเพิ่ม ชีวิตประจำวัน กิจกรรมที่ทำให้ตอบช้า ความเห็น และตัวอย่างแชท) · ใช้เวลาราวหนึ่งนาที</span>
            </label>

            <pre class="scroll-slim hidden max-h-72 overflow-auto whitespace-pre-wrap rounded-xl bg-slate-950/70 p-3 text-xs text-slate-300" data-builder-preview></pre>

            <div class="flex flex-wrap items-center gap-2">
                <button type="submit" class="${BTN}" data-builder-submit>สร้างและเริ่มแชท</button>
                <button type="button" class="${BTN_GHOST}" onclick="previewCharacter()">ดูไฟล์ที่จะสร้าง</button>
                <button type="button" class="${BTN_GHOST}" onclick="fillBuilderExample()">ใส่ตัวอย่าง</button>
                <button type="button" class="${BTN_GHOST}" onclick="resetBuilder()">ล้างฟอร์ม</button>
                <span class="ml-auto text-xs text-slate-400" data-builder-msg role="status"></span>
            </div>
        </form>
    </div>
`;

/** A complete example, so someone who just cloned the project can try it in one click */
const BUILDER_EXAMPLE = {
    name: "ฟ้า",
    age: "25",
    gender: "หญิง",
    job: "บาริสต้าร้านกาแฟเล็ก ๆ และรับวาดภาพประกอบ",
    livesIn: "ห้องเช่าใกล้มหาลัย มีแมวหนึ่งตัว",
    city: "เชียงใหม่",
    likes: "กาแฟดริป, แมว, วาดรูป, ซีรี่เกาหลี",
    dislikes: "ฝนตกตอนจะออกจากบ้าน, คนพูดไม่ตรง",
    personality: "ขี้เล่น แซวเก่ง\nใจดีแต่ปากแข็ง\nขี้ลืมเรื่องเล็ก ๆ\nตั้งใจกับงานวาดมาก",
    selfRef: "ฟ้า",
    callUser: "พี่",
    particles: "อ่ะ, นะ, แหละ, ดิ",
    samples: "โห้ยยย ง่วงงง\nไปไหนมาาา\n555 บ้าป่ะ\nเดะนะ ลูกค้ามา",
    backstory: "ย้ายมาเชียงใหม่ตอนเรียนมหาลัย เรียนจบแล้วไม่อยากกลับบ้าน เลยทำงานร้านกาแฟไปด้วย วาดรูปขายไปด้วย ฝันอยากมีสตูดิโอเล็ก ๆ ของตัวเอง",
    relation: "friend",
    howMet: "พี่เป็นลูกค้าประจำที่ร้าน สั่งอเมริกาโน่เย็นทุกวัน",
    firstChat: "เมื่อวานพี่ขอไลน์ฟ้าที่ร้าน นี่เป็นครั้งแรกที่คุยกันในแชท",
    memories: "ชอบอเมริกาโน่เย็น ไม่หวาน\nทำงานเป็นโปรแกรมเมอร์ ชอบนอนดึก",
    people: "มิ้นท์ - เพื่อนร่วมงานที่ร้าน ขี้เม้าท์\nข้าวปั้น - แมวส้มของฟ้า",
    wake: "8",
    sleep: "0",
    typing: "7",
};

export { builderPanel, BUILDER_EXAMPLE };
