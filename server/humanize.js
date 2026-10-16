/* ------------------------------------ settings */

// Defaults when style.md has no "## ตั้งค่าการพิมพ์" section
const DEFAULTS = {
    maiToMai: true,       // ไหม → มั้ย
    dropPolite: true,     // ค่ะ/คะ/ครับ at the end of a bubble
    dropPeriod: true,
    calmBang: true,       // at most one "!" and often none
    dropQuestion: 0.3,    // chance to drop a trailing "?"
    typo: 0.04,           // chance of a typo followed by a "*fix" bubble
};

const LABELS = {
    maiToMai: "แปลงไหมเป็นมั้ย",
    dropPolite: "ตัดค่ะครับ",
    dropPeriod: "ตัดจุดท้ายประโยค",
    calmBang: "ลดเครื่องหมายตกใจ",
    dropQuestion: "ตัดเครื่องหมายคำถามท้าย",
    typo: "พิมพ์ผิดแล้วแก้",
};

/**
 * Reads the "ตั้งค่าการพิมพ์" lines from style.md. "ใช่/ไม่" become booleans, numbers stay numbers.
 * @param {string} style
 */
export function styleSettings(style) {
    const out = { ...DEFAULTS };
    for (const [ key, label ] of Object.entries(LABELS)) {
        const raw = String(style ?? "").match(new RegExp(`-\\s*${label}\\s*[:：]\\s*(\\S+)`))?.[1];
        if (raw == null) continue;
        if (/^(ใช่|yes|true|เปิด)$/i.test(raw)) out[key] = typeof DEFAULTS[key] === "number" ? 1 : true;
        else if (/^(ไม่|no|false|ปิด)$/i.test(raw)) out[key] = typeof DEFAULTS[key] === "number" ? 0 : false;
        else if (Number.isFinite(Number(raw))) out[key] = Math.min(1, Math.max(0, Number(raw)));
    }
    return out;
}

/* ------------------------------------ rewrites */

// Thai marks that sit on the consonant before them; removing that consonant would orphan them
const COMBINING = /[ัิ-ฺ็-๎]/;
const CONSONANT = /[ก-ฮ]/;

/**
 * Drops one consonant from a word, like a missed key, and returns [ typo bubble, "*fix" bubble ].
 * Only touches space-separated words or short bubbles, so the fix stays readable.
 */
function makeTypo(text) {
    const words = text.split(" ");
    const candidates = words
        .map((w, i) => ({ w, i }))
        .filter(({ w }) => Array.from(w).length >= 3 && Array.from(w).length <= 12 && /[฀-๿]/.test(w));
    if (!candidates.length) return null;

    const { w, i } = candidates[Math.floor(Math.random() * candidates.length)];
    const chars = Array.from(w);
    const spots = chars
        .map((c, k) => k)
        .filter((k) => k > 0 && CONSONANT.test(chars[k]) && !COMBINING.test(chars[k + 1] ?? ""));
    if (!spots.length) return null;

    const k = spots[Math.floor(Math.random() * spots.length)];
    const broken = [ ...chars.slice(0, k), ...chars.slice(k + 1) ].join("");
    const typoWords = [ ...words ];
    typoWords[i] = broken;
    return [ typoWords.join(" "), `*${w}` ];
}

/**
 * Light clean-up after the model answers: removes the written-Thai habits that make chat feel stiff.
 * Keeps it subtle on purpose; heavy rewriting would look staged.
 * @param {string[]} bubbles
 * @param {string} style contents of style.md
 * @param {{ allowTypo?: boolean }} [options] turn typos off for serious moments
 * @returns {string[]}
 */
export function humanize(bubbles, style, { allowTypo = true } = {}) {
    const s = styleSettings(style);
    let out = (Array.isArray(bubbles) ? bubbles : []).map((b) => {
        let t = String(b ?? "").trim();
        if (s.maiToMai) t = t.replace(/ไหม(?=$|[\s?!.,)])/g, "มั้ย");
        if (s.dropPolite) t = t.replace(/\s*(นะ)?(ค่ะ|คะ|ครับ)(?=[\s?!.]*$)/, (_, na) => (na ? "นะ" : ""));
        if (s.dropPeriod) t = t.replace(/(?<!\.)\.$/, "");
        if (s.calmBang) {
            t = t.replace(/!{2,}/g, "!");
            if (Math.random() < 0.5) t = t.replace(/!$/, "");
        }
        if (s.dropQuestion && Math.random() < s.dropQuestion) t = t.replace(/\?$/, "");
        return t.trim();
    }).filter(Boolean);

    // A typo needs a later bubble to fix it, and never in messages with numbers (hotlines, times)
    if (allowTypo && s.typo > 0 && Math.random() < s.typo && out.length) {
        const i = Math.floor(Math.random() * out.length);
        if (!/\d/.test(out[i])) {
            const typo = makeTypo(out[i]);
            if (typo) out = [ ...out.slice(0, i), ...typo, ...out.slice(i + 1) ];
        }
    }
    return out;
}

/* ------------------------------------ mirroring and repetition */

const PARTICLES = [ "นะ", "อ่ะ", "อะ", "จ้า", "ครับ", "ค่ะ", "แหละ", "ดิ", "เลย", "ป่ะ" ];

/**
 * How the user types, so she can match their rhythm the way friends drift toward each other.
 * @param {string[]} texts the user's recent messages
 * @returns {string} prompt lines, or "" when there's too little to go on
 */
export function userStyleNote(texts) {
    const list = (texts ?? []).map((t) => String(t ?? "").trim()).filter((t) => t && !t.startsWith("[ระบบ"));
    if (list.length < 3) return "";

    const avg = Math.round(list.reduce((n, t) => n + Array.from(t).length, 0) / list.length);
    const laughs = list.filter((t) => /555|ฮ่า|ขำ/.test(t)).length / list.length;
    const emoji = list.filter((t) => /\p{Extended_Pictographic}/u.test(t)).length / list.length;
    const stretched = list.filter((t) => /([฀-๿a-z])\1{2,}/i.test(t)).length / list.length;
    const particles = PARTICLES
        .map((p) => [ p, list.filter((t) => t.endsWith(p)).length ])
        .filter(([ , n ]) => n > 0)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([ p ]) => p);

    const lines = [
        `- ผู้ใช้พิมพ์เฉลี่ย ${avg} ตัวอักษรต่อข้อความ${avg < 15 ? " (สั้นมาก ตอบสั้นตาม)" : avg > 60 ? " (ยาว ตอบยาวขึ้นได้)" : ""}`,
        laughs > 0.25 ? "- ผู้ใช้หัวเราะ 555 บ่อย เล่นมุกได้" : "",
        emoji > 0.3 ? "- ผู้ใช้ใช้อีโมจิบ่อย" : emoji === 0 ? "- ผู้ใช้แทบไม่ใช้อีโมจิ ใช้ให้น้อยลง" : "",
        stretched > 0.2 ? "- ผู้ใช้ชอบลากเสียง (เช่น ง่วงงง)" : "",
        particles.length ? `- ผู้ใช้ลงท้ายบ่อยด้วย: ${particles.join(", ")}` : "",
    ].filter(Boolean);

    return lines.join("\n");
}

/** First few characters of a bubble, which is where AI repetition shows ("โห...", "อ้าว...") */
const openerOf = (t) => Array.from(String(t ?? "").trim().split(/[\s!?.]/)[0] ?? "").slice(0, 5).join("");

/**
 * Warns her about openers and phrases she keeps reusing.
 * @param {string[]} bubbles her recent bubbles, oldest first
 * @returns {string}
 */
export function repetitionNote(bubbles) {
    const list = (bubbles ?? []).map((b) => String(b ?? "").trim()).filter(Boolean).slice(-12);
    if (list.length < 3) return "";

    const counts = new Map();
    for (const o of list.map(openerOf).filter((o) => o.length >= 2)) counts.set(o, (counts.get(o) ?? 0) + 1);
    const repeated = [ ...counts ].filter(([ , n ]) => n >= 2).map(([ o, n ]) => `"${o}" (${n} ครั้ง)`);

    const lines = [
        repeated.length ? `- คุณเพิ่งขึ้นต้นด้วย ${repeated.join(", ")} ซ้ำแล้ว รอบนี้ห้ามขึ้นต้นแบบนั้น` : "",
        `- ข้อความล่าสุดของคุณ (ห้ามพูดซ้ำหรือใช้โครงประโยคเดิม): ${list.slice(-5).map((b) => `"${b}"`).join(" · ")}`,
    ].filter(Boolean);
    return lines.join("\n");
}
