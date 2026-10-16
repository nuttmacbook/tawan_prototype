import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import webpush from "web-push";
import { DATA_DIR, loadSettings, saveSettings } from "./profiles.js";

/* ------------------------------------ setup */

// Phones and browsers that asked for notifications; shared by every character
const SUBS_FILE = path.join(DATA_DIR, "push.json");
// Push services ask for a contact; nothing is ever sent to it
const CONTACT = process.env.PUSH_CONTACT || "mailto:persona-agent@example.com";

let isReady = false;

/** Creates the app's push keys once and keeps them in settings, so existing subscriptions stay valid */
async function ensureKeys() {
    const settings = await loadSettings();
    let keys = settings?.webPush;
    if (!keys?.publicKey || !keys?.privateKey) {
        keys = webpush.generateVAPIDKeys();
        await saveSettings({ webPush: keys });
    }
    if (!isReady) {
        webpush.setVapidDetails(CONTACT, keys.publicKey, keys.privateKey);
        isReady = true;
    }
    return keys;
}

export const publicKey = async () => (await ensureKeys()).publicKey;

/* ------------------------------------ subscriptions */

async function loadSubs() {
    try {
        const list = JSON.parse(await readFile(SUBS_FILE, "utf8"));
        return Array.isArray(list) ? list.filter((s) => s?.endpoint) : [];
    } catch {
        return [];
    }
}

const saveSubs = (list) => writeFile(SUBS_FILE, `${JSON.stringify(list, null, 1)}\n`);

/**
 * Remembers a browser's push subscription (replacing an older one from the same endpoint).
 * @param {{ endpoint: string, keys: { p256dh: string, auth: string } }} sub
 * @param {string} label e.g. "มือถือ" so the list is readable
 */
export async function subscribe(sub, label = "") {
    if (!/^https:\/\//.test(String(sub?.endpoint ?? "")) || !sub?.keys?.p256dh || !sub?.keys?.auth) {
        throw new Error("ข้อมูลการแจ้งเตือนไม่ถูกต้อง");
    }
    await ensureKeys();
    const list = (await loadSubs()).filter((s) => s.endpoint !== sub.endpoint);
    list.push({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, label: String(label).slice(0, 60), at: Date.now() });
    await saveSubs(list);
    return list.length;
}

export async function unsubscribe(endpoint) {
    const list = await loadSubs();
    await saveSubs(list.filter((s) => s.endpoint !== String(endpoint ?? "")));
}

export const subscriptionCount = async () => (await loadSubs()).length;

/* ------------------------------------ sending */

/**
 * Sends one notification to every subscribed device. Subscriptions the push service
 * says are gone (404/410) are dropped, so uninstalled phones don't pile up.
 * @param {{ title: string, body: string, tag?: string }} message
 * @returns {Promise<number>} devices reached
 */
export async function notifyAll({ title, body, tag = "persona-chat" }) {
    const list = await loadSubs();
    if (!list.length) return 0;
    await ensureKeys();

    const payload = JSON.stringify({ title: String(title ?? "").slice(0, 80), body: String(body ?? "").slice(0, 200), tag });
    let reached = 0;
    const dead = new Set();
    await Promise.all(list.map(async (sub) => {
        try {
            await webpush.sendNotification(sub, payload, { TTL: 6 * 3600, urgency: "high" });
            reached++;
        } catch (err) {
            if (err?.statusCode === 404 || err?.statusCode === 410) dead.add(sub.endpoint);
            else console.error("  ⚠ ส่งแจ้งเตือนไม่สำเร็จ:", err?.statusCode ?? "", err?.body ?? err?.message ?? err);
        }
    }));
    if (dead.size) await saveSubs(list.filter((s) => !dead.has(s.endpoint)));
    return reached;
}

/** How a chat message reads on a lock screen: pictures and stickers become words */
export const previewText = (bubbles) =>
    (Array.isArray(bubbles) ? bubbles : [ bubbles ])
        .map((b) => String(b ?? "").replace(/\[รูป:[^\]]+\]/g, "📷 รูป").trim())
        .filter(Boolean)
        .join("\n");
