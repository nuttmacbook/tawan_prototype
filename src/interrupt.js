/**
 * Decides whether a message you send while she's typing makes her stop, the way a person would.
 * No brain call: it has to answer instantly, between two bubbles.
 */

const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|‍|️|\s)+$/u;

// Replies that need nothing back: a laugh, a nod, "ok"
const FILLER = /^(?:5{3,}\+*|ฮ่า+|ฮา+|อือ+|อื้อ+|อืม+|เออ+|โอเค|ok(?:ay)?|ค่ะ|ครับ|จ้า+|จ้ะ|งับ|ฮะ|อ๋อ+|อ่อ+|จริง(?:ดิ|ด้วย)?|ใช่|ช่าย|นั่นสิ|นั่นดิ|555+|lol)[\s!.~ๆ]*$/i;

// A question, a change of plan, or a feeling: a friend looks up from what they were typing
const ASKS = /[?？]|มั้ย|ไหม|ป่ะ|ปะ$|หรอ|เหรอ|อะไร|ยังไง|ทำไม|ที่ไหน|เมื่อไหร่|ตอนไหน|ใคร|กี่|ได้ป่าว|ได้ไหม|ไง$/;
const URGENT = /เดี๋ยว|รอก่อน|หยุด|ช่วย|ด่วน|ขอโทษ|เศร้า|ร้องไห้|เหนื่อย|เครียด|โกรธ|งอน|เสียใจ|ไม่ไหว|ป่วย|เจ็บ|กลัว|ไม่สบาย/;

const LONG_CHARS = 25;
const SHORT_CHARS = 12;

/**
 * @param {string} text the message as sent, may hold [รูป:..] or [ตอบกลับ ".."]
 * @returns {boolean} true when she should stop typing and look at it
 */
export function shouldInterrupt(text) {
    const raw = String(text ?? "").trim();
    if (!raw) return false;
    // A picture, or a reply aimed at one of her messages, is meant to be looked at
    if (/\[รูป:/.test(raw) || /^\[ตอบกลับ "/.test(raw)) return true;
    if (EMOJI_ONLY.test(raw)) return false;
    if (FILLER.test(raw)) return false;
    if (ASKS.test(raw) || URGENT.test(raw)) return true;
    const length = Array.from(raw).length;
    if (length >= LONG_CHARS) return true;
    return length >= SHORT_CHARS;
}
