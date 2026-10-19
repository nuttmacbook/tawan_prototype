/* ------------------------------------ settings */

// Defaults when style.md has no "## ตั้งค่าการพิมพ์" section
const DEFAULTS = {
    maiToMai: true,       // ไหม → มั้ย
    dropPolite: true,     // ค่ะ/คะ/ครับ at the end of a bubble
    dropPeriod: true,
    calmBang: true,       // at most one "!" and often none
    dropQuestion: 0.3,    // chance to drop a trailing "?"
    typo: 0.04,           // chance of a typo followed by a "*fix" bubble
    rethink: false,       // a message arriving before her first bubble shows: drop the reply and think again (one more brain call)
    typoUnsend: 0.5,      // share of typos fixed by unsending the bubble and sending it again, instead of "*fix"
    hesitate: 0.08,       // chance she starts typing, stops, and starts again before her first bubble
};

const LABELS = {
    maiToMai: "แปลงไหมเป็นมั้ย",
    dropPolite: "ตัดค่ะครับ",
    dropPeriod: "ตัดจุดท้ายประโยค",
    calmBang: "ลดเครื่องหมายตกใจ",
    dropQuestion: "ตัดเครื่องหมายคำถามท้าย",
    typo: "พิมพ์ผิดแล้วแก้",
    rethink: "คิดใหม่เมื่อถูกพิมพ์แทรก",
    typoUnsend: "พิมพ์ผิดแล้วยกเลิกส่ง",
    hesitate: "พิมพ์แล้วลบ",
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
export function humanize(bubbles, style, options = {}) {
    return humanizeReply(bubbles, style, options).bubbles;
}

/**
 * humanize() plus the little things a person does while sending:
 * unsend: indexes of bubbles she sends and then takes back (a typo she resends correctly)
 * hesitate: she starts typing, stops, and starts again before the first bubble
 * @param {string[]} bubbles
 * @param {string} style contents of style.md
 * @param {{ allowTypo?: boolean }} [options] off for serious moments: no typos, no hesitation games
 * @returns {{ bubbles: string[], unsend: number[], hesitate: boolean }}
 */
export function humanizeReply(bubbles, style, { allowTypo = true } = {}) {
    const s = styleSettings(style);
    const unsend = [];
    let out = (Array.isArray(bubbles) ? bubbles : []).map((b) => {
        let t = String(b ?? "").trim();
        // Not the silk kind: ผ้าไหม, เส้นไหม, หนอนไหม are words, not the question particle.
        // Never inside [ตอบกลับ "..."] or a link: a quote or an address must stay exact
        if (s.maiToMai) {
            t = t.split(/(\[[^\]]*\]|https?:\/\/\S+)/)
                .map((part, i) => (i % 2 ? part : part.replace(/(?<!ผ้า|เส้น|หนอน|ใย)ไหม(?=$|[\s?!.,)])/g, "มั้ย")))
                .join("");
        }
        if (s.dropPolite) t = t.replace(/\s*(นะ)?(ค่ะ|คะ|ครับ)(?=[\s?!.]*$)/, (_, na) => (na ? "นะ" : ""));
        if (s.dropPeriod) t = t.replace(/(?<!\.)\.$/, "");
        if (s.calmBang) {
            t = t.replace(/!{2,}/g, "!");
            if (Math.random() < 0.5) t = t.replace(/!$/, "");
        }
        if (s.dropQuestion && Math.random() < s.dropQuestion) t = t.replace(/\?$/, "");
        return t.trim();
    }).filter(Boolean);

    // A typo needs a later bubble to fix it, and never in messages with numbers (hotlines, times),
    // links (a broken link) or app tokens like [ส่งรูป:...] / [ตอบกลับ "..."]
    if (allowTypo && s.typo > 0 && Math.random() < s.typo && out.length) {
        const i = Math.floor(Math.random() * out.length);
        if (!/\d|\[|https?:/.test(out[i])) {
            const typo = makeTypo(out[i]);
            if (typo && Math.random() < s.typoUnsend) {
                // Sent with the typo, taken back, then sent again correctly
                out = [ ...out.slice(0, i), typo[0], out[i], ...out.slice(i + 1) ];
                unsend.push(i);
            } else if (typo) {
                out = [ ...out.slice(0, i), ...typo, ...out.slice(i + 1) ];
            }
        }
    }
    const hesitate = allowTypo && out.length > 0 && Math.random() < s.hesitate;
    return { bubbles: out, unsend, hesitate };
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

/* ------------------------------------ the shape of this turn */

// Thai questions usually end in a particle, not "?"
const QUESTION_END = new RegExp(
    // A bare "ยัง" is an answer; "กินข้าวยัง" is a question
    "(?:\\?|หรอ|เหรอ|ป่ะ|ปะ|มั้ย|ไหม|เปล่า|ป่าว|รึยัง|(?<=\\S)ยัง)\\s*[?!~.]*$" +
    // "ไปไหนมา", "ทำไรอยู่", "เรื่องไรอ่ะ": the question word, then a particle or two
    // "ไม่ไปไหน", "ไม่มีใคร", "ไม่รู้ทำไม" are statements
    "|(?<!ไม่(?:ได้)?ไป|ไม่มี|ไม่รู้|ไม่รู้ว่า)(?:ไหน|(?<!เป็น)ไร|ยังไง|ใคร|เมื่อไหร่|ทำไม|กี่โมง)(?:มา|อยู่|อ่ะ|อะ|ล่ะ|นะ|กัน|ดี|บ้าง|เนี่ย|เลย)*\\s*[?!~.]*$",
);
export const isQuestion = (t) => QUESTION_END.test(String(t ?? "").trim());

// Not "สบาย" (ไม่สบาย, สบายดี) and not "ไปนอนได้แล้ว" said out of care
const GOODBYE = /ฝันดี|ไปนอน(?:ละ|ก่อน|แล้วนะ)|นอนละ|นอนก่อนนะ|(?<!ส)บายย*|ไว้คุยกัน|ไปก่อนนะ|ไปละ|เจอกันพรุ่งนี้|good ?night|\bgn\b/i;
const bubblesOf = (t) => String(t?.text ?? "").split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
// Lines the app adds ("[ระบบ: ...]") aren't something the user typed
const typedBy = (t) => String(t?.text ?? "").split("\n").filter((l) => l.trim() && !/^\[ระบบ/.test(l.trim()));

/**
 * How this turn should go, from the shape of the chat so far. Each rule fixes something that made her
 * read like a bot in real chats: the same question again, four bubbles for "โอเค",
 * a question at the end of every reply, and saying goodbye over and over.
 * @param {{ role: string, text: string }[]} turns short-term memory, oldest first, the current user turn last
 * @returns {{ note: string, maxBubbles: number }}
 */
export function rhythmFor(turns) {
    const list = Array.isArray(turns) ? turns : [];
    const mine = list.filter((t) => t?.role === "assistant").slice(-6);
    const users = list.filter((t) => t?.role === "user");
    const now = typedBy(users.at(-1));
    const chars = now.reduce((n, l) => n + Array.from(l).length, 0);
    const asks = now.some(isQuestion);
    const lines = [];

    // Her length follows yours: a one-word message doesn't get a speech
    let maxBubbles = !now.length ? 3 : chars <= 12 ? 2 : chars <= 40 ? 3 : 4;
    if (asks) maxBubbles = Math.min(4, maxBubbles + 1);
    if (now.length && chars <= 12 && !asks) lines.push("- ผู้ใช้พิมพ์สั้นมาก ตอบสั้นตาม 1–2 bubble หรือแค่กดรีแอคก็พอ");

    const asked = [ ...new Set(mine.flatMap(bubblesOf).filter(isQuestion)) ].slice(-6);
    if (asked.length) lines.push(`- คำถามที่คุณถามไปแล้ว (ห้ามถามซ้ำหรือถามความหมายเดียวกัน ถ้าผู้ใช้ตอบแล้วให้ต่อจากคำตอบนั้น): ${asked.map((q) => `"${q}"`).join(" · ")}`);

    const endsAsking = mine.slice(-3).filter((t) => isQuestion(bubblesOf(t).at(-1))).length;
    if (endsAsking >= 2) lines.push("- คุณปิดท้ายด้วยคำถามติดกันหลายรอบแล้ว รอบนี้ไม่ต้องถาม เล่าเรื่องตัวเองหรือแสดงความเห็นแทน");

    // Once you've both said goodnight, one short line (or nothing) ends it. Only the exchange just
    // before this message counts: last night's goodnight shouldn't cut this morning short.
    const last = list.at(-2);
    const before = list.at(-3);
    const saidBye = last?.role === "assistant" && [ last, before?.role === "user" ? before : null ]
        .some((t) => t && GOODBYE.test(String(t.text ?? "")));
    if (saidBye && now.length && chars <= 15) {
        lines.push("- บอกลากันไปแล้ว ถ้าจะตอบ ตอบสั้นมาก 1 bubble หรือกดรีแอค หรืออ่านแล้วไม่ตอบ ห้ามบอกลาซ้ำหรือเปิดเรื่องใหม่");
        maxBubbles = 1;
    }
    return { note: lines.join("\n"), maxBubbles };
}

/**
 * Keeps a reply within the turn's length. Extra bubbles go into the last one, so nothing she meant
 * to say is lost; the prompt already asks for fewer, this only catches a model that ignored it.
 */
export function capBubbles(bubbles, max) {
    const list = Array.isArray(bubbles) ? bubbles : [];
    if (!(max > 0) || list.length <= max) return list;
    // A sticker or a quote token only works at the start of its own bubble, so those extras are dropped
    const extra = list.slice(max - 1)
        .map((b, i) => (i ? String(b ?? "").replace(/^\[ตอบกลับ "[^"]*"\]\s*/, "") : b))
        .filter((b, i) => !i || !/^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\u200d|\ufe0f|\s)+$/u.test(b));
    return [ ...list.slice(0, max - 1), extra.join(" ") ];
}
