import os from "node:os";

/* ------------------------------------ where a request comes from */

const LOOPBACK = /^(127\.|::1$|::ffff:127\.)/;

// Proxies such as cloudflared connect from 127.0.0.1, so the socket alone can't tell a tunnel
// visitor from you. Any forwarding header means the request came from outside this computer.
const PROXY_HEADERS = [ "cf-connecting-ip", "cf-ray", "x-forwarded-for", "x-forwarded-host", "x-real-ip", "forwarded" ];

export const isLocal = (req) =>
    LOOPBACK.test(req?.socket?.remoteAddress ?? "") &&
    !PROXY_HEADERS.some((h) => req?.headers?.[h] != null);

/**
 * Who to count wrong keys against. Forwarding headers are only believed when the request came
 * through cloudflared on this computer; from the LAN anyone could type them and dodge the limit.
 */
export const clientIp = (req) => {
    const socketIp = String(req?.socket?.remoteAddress ?? "");
    if (!LOOPBACK.test(socketIp)) return socketIp;
    return String(req?.headers?.["cf-connecting-ip"] ?? req?.headers?.["x-forwarded-for"] ?? socketIp).split(",")[0].trim();
};

export const isHttps = (req) =>
    req?.headers?.["x-forwarded-proto"] === "https" || String(req?.headers?.["cf-visitor"] ?? "").includes("https");

export const lanAddresses = () =>
    Object.values(os.networkInterfaces())
        .flat()
        .filter((a) => a && a.family === "IPv4" && !a.internal)
        .map((a) => a.address);

/* ------------------------------------ requests from other websites */

/** "Example.com:3939" → "example.com", "[::1]:3939" → "[::1]" */
export const hostNameOf = (host) => {
    const h = String(host ?? "").trim().toLowerCase();
    if (h.startsWith("[")) return h.slice(0, h.indexOf("]") + 1);
    return h.replace(/:\d+$/, "");
};

/**
 * A page on any other website can make your browser send requests to localhost, and a DNS trick
 * can even make it read the answers. This builds the check for "is this Host header really us?".
 * @param {{ isLan?: boolean, isQuickTunnel?: boolean, publicUrl?: string, extraHosts?: string[], lanNames?: () => string[] }} options
 * @returns {(req: import("node:http").IncomingMessage) => boolean}
 */
export function makeHostCheck({ isLan = false, isQuickTunnel = false, publicUrl = "", extraHosts = [], lanNames = lanAddresses } = {}) {
    let publicHost = "";
    try {
        publicHost = publicUrl ? new URL(publicUrl).hostname.toLowerCase() : "";
    } catch {}
    const extra = extraHosts.map((h) => String(h).trim().toLowerCase()).filter(Boolean);
    let cache = { at: 0, list: [] };
    const lan = () => {
        if (Date.now() - cache.at > 60000) cache = { at: Date.now(), list: lanNames() };
        return cache.list;
    };

    return (req) => {
        const name = hostNameOf(req?.headers?.host);
        if ([ "localhost", "127.0.0.1", "[::1]" ].includes(name)) return true;
        if (isLan && lan().includes(name)) return true;
        if (isQuickTunnel && name.endsWith(".trycloudflare.com")) return true;
        if (publicHost && name === publicHost) return true;
        return extra.includes(name);
    };
}

/**
 * Changes must come from the app's own page. Browsers mark requests from other sites
 * (Sec-Fetch-Site, Origin), and can't send a JSON body to another site without asking first,
 * so a page elsewhere can't post here behind your back.
 */
export function isOwnPage(req) {
    const headers = req?.headers ?? {};
    const site = String(headers["sec-fetch-site"] ?? "");
    if (site && site !== "same-origin" && site !== "none") return false;
    const origin = headers.origin;
    if (origin != null) {
        try {
            // "null" (sandboxed frames, file pages) fails to parse and is refused too
            if (new URL(origin).host.toLowerCase() !== String(headers.host ?? "").toLowerCase()) return false;
        } catch {
            return false;
        }
    }
    return /^application\/json\b/i.test(String(headers["content-type"] ?? ""));
}
