import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DATA_DIR } from "./profiles.js";

/* ------------------------------------ where the logo comes from */

// Drop your own logo.png (or .jpg / .webp) into data/ or the project folder; data/ wins.
// Square, at least 512×512, works best. No restart needed: every request looks again.
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const NAMES = [ "logo.png", "logo.jpg", "logo.jpeg", "logo.webp" ];
const SEARCH = [ DATA_DIR, ROOT ];
const DEFAULT_ICON = path.join(ROOT, "public", "icon-512.png");
const TYPES = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };

const APP_NAME = "Broker";

/** Paths anyone may load, even without the access key: phones fetch these without cookies */
export const PUBLIC_PATHS = new Set([ "/manifest.webmanifest", "/app-icon", "/icon.svg", "/icon-192.png", "/icon-512.png", "/favicon.ico" ]);

/** @returns {Promise<{ file: string, mtime: number, isCustom: boolean }>} */
async function currentIcon() {
    for (const dir of SEARCH) {
        for (const name of NAMES) {
            const file = path.join(dir, name);
            const info = await stat(file).catch(() => null);
            if (info?.isFile() && info.size > 0) return { file, mtime: Math.round(info.mtimeMs), isCustom: true };
        }
    }
    return { file: DEFAULT_ICON, mtime: 0, isCustom: false };
}

/** Width × height from a PNG header, so the manifest can state the real size */
function pngSize(buf) {
    if (!buf || buf.length < 24 || buf.toString("ascii", 1, 4) !== "PNG") return "";
    return `${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)}`;
}

/* ------------------------------------ responses */

async function sendIcon(res, url) {
    const icon = await currentIcon();
    const data = await readFile(icon.file);
    res.writeHead(200, {
        "content-type": TYPES[path.extname(icon.file).toLowerCase()] ?? "image/png",
        // ?v=<mtime> changes with every new logo, so that address may be cached; the bare one may not
        "cache-control": url.searchParams.has("v") ? "public, max-age=31536000, immutable" : "no-cache",
    });
    res.end(data);
}

async function sendManifest(res) {
    const icon = await currentIcon();
    const head = await readFile(icon.file).then((b) => b.subarray(0, 32)).catch(() => null);
    const src = `/app-icon?v=${icon.mtime}`;
    const type = TYPES[path.extname(icon.file).toLowerCase()] ?? "image/png";
    const size = pngSize(head) || "512x512";
    const manifest = {
        name: APP_NAME,
        short_name: APP_NAME,
        start_url: "/",
        display: "standalone",
        background_color: "#1b1c43",
        theme_color: "#0f172a",
        // Your own logo isn't marked maskable: Android would crop its edges into a circle
        icons: icon.isCustom
            ? [ { src, sizes: size, type, purpose: "any" } ]
            : [
                { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any maskable" },
                { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
            ],
    };
    res.writeHead(200, { "content-type": "application/manifest+json; charset=utf-8", "cache-control": "no-cache" });
    res.end(JSON.stringify(manifest, null, 4));
}

/**
 * Answers the manifest and icon requests.
 * @returns {Promise<boolean>} true when the request was handled here
 */
export async function handleAppIcon(req, res, url) {
    if (req.method !== "GET" && req.method !== "HEAD") return false;
    if (url.pathname === "/manifest.webmanifest") return sendManifest(res).then(() => true);
    if (url.pathname === "/app-icon" || url.pathname === "/favicon.ico") return sendIcon(res, url).then(() => true);
    return false;
}
