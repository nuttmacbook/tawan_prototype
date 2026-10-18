/* ------------------------------------ comparing Thai text without a word splitter */

/** Lower-case text with spaces, punctuation and symbols removed */
export const normalize = (text) => String(text ?? "").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");

/**
 * Thai has no spaces between words, so similarity is measured with 3-letter chunks:
 * "ชาบู" and "ชวนกินชาบู" share "ชาบ" and "าบู" without needing a word splitter.
 * Digits are left out, so "3 ทุ่ม" and "4 ทุ่ม" count as the same topic.
 */
export const gramsOf = (text) => {
    const chars = Array.from(normalize(text).replace(/\d+/g, ""));
    const out = new Set();
    for (let i = 0; i + 3 <= chars.length; i++) out.add(chars.slice(i, i + 3).join(""));
    return out;
};

export const overlap = (a, b) => {
    let n = 0;
    for (const g of a) if (b.has(g)) n++;
    return n;
};

/** 0–1: how much two texts share, by their 3-letter chunks (Dice coefficient) */
export const similarity = (a, b) => {
    const [ x, y ] = [ gramsOf(a), gramsOf(b) ];
    if (!x.size || !y.size) return normalize(a) === normalize(b) ? 1 : 0;
    return (2 * overlap(x, y)) / (x.size + y.size);
};
