// Service worker: only shows push notifications. It never intercepts page requests,
// so the app always loads fresh from the server.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
    let data = {};
    try {
        data = event.data?.json() ?? {};
    } catch {
        data = { body: event.data?.text() ?? "" };
    }

    event.waitUntil((async () => {
        // An open, visible chat already shows the message; don't buzz on top of it
        const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
        if (windows.some((w) => w.visibilityState === "visible" && w.focused)) return;

        await self.registration.showNotification(data.title || "แชท", {
            body: data.body || "",
            tag: data.tag || "persona-chat",
            renotify: true,
            icon: "/app-icon",
            badge: "/icon-192.png",
            data: { url: "/" },
        });
    })());
});

// Tapping the notification brings the chat back, or opens it if it was closed
self.addEventListener("notificationclick", (event) => {
    event.notification.close();
    event.waitUntil((async () => {
        const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
        const open = windows.find((w) => new URL(w.url).origin === self.location.origin);
        if (open) return open.focus();
        return self.clients.openWindow(event.notification.data?.url || "/");
    })());
});
