// Finding web links in chat text, shared by the page (clickable links) and the server
// (which links she may send). One rule in one place, so both always agree on where a link ends.

// Thai is often typed straight after a link with no space, so Thai letters end a link
const RAW_LINK = /https?:\/\/[^\s<>"'฀-๿]+/g;

/** Drops punctuation that ends the sentence, not the link; keeps ")" when the link opened one (Foo_(band)) */
export function trimLink(raw) {
    let url = String(raw ?? "");
    for (;;) {
        const last = url.at(-1);
        if (/[.,!?:;\]'"]/.test(last)) url = url.slice(0, -1);
        else if (last === ")" && (url.match(/\(/g) ?? []).length < (url.match(/\)/g) ?? []).length) url = url.slice(0, -1);
        else break;
    }
    return url;
}

/**
 * @param {string} text
 * @returns {{ url: string, index: number }[]} links in order, with where each starts
 */
export function findLinks(text) {
    const out = [];
    for (const m of String(text ?? "").matchAll(RAW_LINK)) {
        const url = trimLink(m[0]);
        if (/^https?:\/\/[^/?#]+\.[^/?#]/.test(url)) out.push({ url, index: m.index });
    }
    return out;
}
