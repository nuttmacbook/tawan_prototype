import { currentId } from "./profiles.js";

/* ------------------------------------ live updates for the open page */

// Everything she says gets a number, per character. The open page listens (Server-Sent Events)
// and, when it comes back from a locked screen, asks for what it missed. Before this, a reply
// written while the phone was locked, or a message she sent on her own, only showed after a reload.

const KEEP = 100;
// Numbers start over when the server restarts; the page tells the two apart by this
export const BOOT = Math.random().toString(36).slice(2, 10);
const KEEPALIVE_MS = 20000;   // tunnels and phones drop a silent connection
const feeds = new Map();

// The page names its own character: a tab left on one character must not get another's messages
// after you switch on a different device
const idOf = (id) => (/^[\w-]{1,64}$/.test(String(id ?? "")) ? String(id) : currentId());
const feed = (id) => {
    id = idOf(id);
    if (!feeds.has(id)) feeds.set(id, { seq: 0, events: [], listeners: new Set() });
    return feeds.get(id);
};

/**
 * Records something she said and tells every open page of this character.
 * @param {{ type: "reply" | "say", bubbles: string[], unsend?: number[], replyTo?: string[], reaction?: string, req?: string }} event
 *   req: the page request that asked for it, so that page doesn't show it twice
 * @returns {number} its number
 */
export function publish(event) {
    const f = feed();
    const item = {
        seq: ++f.seq,
        boot: BOOT,
        at: Date.now(),
        type: event?.type === "reply" ? "reply" : "say",
        bubbles: Array.isArray(event?.bubbles) ? event.bubbles.map(String) : [],
        unsend: Array.isArray(event?.unsend) ? event.unsend : [],
        replyTo: Array.isArray(event?.replyTo) ? event.replyTo.map(String) : [],
        reaction: String(event?.reaction ?? ""),
        req: String(event?.req ?? "").slice(0, 64),
    };
    f.events.push(item);
    if (f.events.length > KEEP) f.events.shift();
    const line = `data: ${JSON.stringify(item)}\n\n`;
    for (const res of f.listeners) res.write(line);
    return item.seq;
}

/** The latest number, for a page that just loaded everything from the log */
export const latestSeq = (id) => feed(id).seq;

/** What a page missed after `after` */
export const eventsSince = (after, id) => {
    const f = feed(id);
    const n = Number(after) || 0;
    // After a server restart the numbers start again; a page ahead of us has missed nothing we know of
    return { boot: BOOT, seq: f.seq, events: n > f.seq ? [] : f.events.filter((e) => e.seq > n) };
};

/** An open EventSource connection for the current character */
export function stream(req, res, id) {
    const f = feed(id);
    res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store, no-transform",
        connection: "keep-alive",
        // Proxies (nginx, some tunnels) would otherwise hold the events back
        "x-accel-buffering": "no",
    });
    res.write(`retry: 3000\n: hello ${f.seq}\n\n`);
    f.listeners.add(res);
    const keepalive = setInterval(() => res.write(": ping\n\n"), KEEPALIVE_MS);
    const close = () => {
        clearInterval(keepalive);
        f.listeners.delete(res);
    };
    req.on("close", close);
    res.on("error", close);
}
