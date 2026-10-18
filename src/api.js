/**
 * Calls the local server. Errors come back as { error } with a Thai message the UI can show as-is.
 * @param {string} path e.g. "/api/chat"
 * @param {object} [body] sends a POST when present
 */
async function call(path, body) {
    const res = await fetch(path, body === undefined
        ? {}
        : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

    let data = {};
    try {
        data = await res.json();
    } catch {}

    if (!res.ok) throw new Error(data?.error || `เซิร์ฟเวอร์ตอบ ${res.status}`);
    return data;
}

export const api = {
    bootstrap: () => call("/api/bootstrap"),
    status: () => call("/api/status"),
    brain: () => call("/api/brain"),
    setBrain: (mode) => call("/api/brain", { mode }),
    send: (clientId, id, text) => call("/api/send", { clientId, id, text }),
    read: (ids) => call("/api/read", { ids }),
    unsend: (id, text, time) => call("/api/unsend", { id, text, time }),
    edit: (id, text) => call("/api/edit", { id, text }),
    olderDay: (before) => call(`/api/history/day?before=${encodeURIComponent(before)}`),
    chat: (ids, context = {}) => call("/api/chat", { ids, ...context }),
    clearActivity: () => call("/api/pacing/clear", {}),
    pacing: (texts) => call("/api/pacing", { texts }),
    logicState: (since) => call(`/api/logic/state?since=${Number(since) || 0}`),
    logicRun: (prompt) => call("/api/logic/run", { prompt }),
    logicReset: () => call("/api/logic/reset", {}),
    logicFiles: () => call("/api/logic/files"),
    logicBackups: () => call("/api/logic/backups"),
    readCode: (path) => call(`/api/logic/file?path=${encodeURIComponent(path)}`),
    writeCode: (path, text) => call("/api/logic/file", { path, text }),
    restore: (id) => call("/api/logic/restore", { id }),
    restart: (backupId) => call("/api/restart", { backupId }),
    greet: () => call("/api/greet", {}),
    nudge: (minutes) => call("/api/nudge", { minutes }),
    reset: () => call("/api/reset", {}),
    teachings: () => call("/api/teachings"),
    teach: (lesson) => call("/api/teach", lesson),
    deleteTeaching: (trigger) => call("/api/teachings/delete", { trigger }),
    remember: (fact, topic) => call("/api/remember", { fact, topic }),
    correctStyle: (before, after, context) => call("/api/style/correct", { before, after, context }),
    addSamples: (text, speaker) => call("/api/style/samples", { text, speaker }),
    compact: () => call("/api/compact", {}),
    claim: (clientId) => call("/api/presence/claim", { clientId }),
    beat: (clientId, visible = true) => call("/api/presence/beat", { clientId, visible }),
    switchProfile: (id) => call("/api/profiles/switch", { id }),
    createProfile: (name, copy) => call("/api/profiles/create", { name, copy }),
    deleteProfile: (id) => call("/api/profiles/delete", { id }),
    snapshots: () => call("/api/snapshots"),
    createSnapshot: () => call("/api/snapshots/create", {}),
    restoreSnapshot: (id) => call("/api/snapshots/restore", { id }),
    react: (emoji, text, time, date) => call("/api/react", { emoji, text, time, date }),
    search: (q) => call(`/api/search?q=${encodeURIComponent(q)}`),
    upload: (data) => call("/api/upload", { data }),
    rotateKey: () => call("/api/remote/rotate", {}),
    pushKey: () => call("/api/push/key"),
    pushSubscribe: (subscription, label) => call("/api/push/subscribe", { subscription, label }),
    pushUnsubscribe: (endpoint) => call("/api/push/unsubscribe", { endpoint }),
    pushTest: () => call("/api/push/test", {}),
    importProfile: (pack) => call("/api/profiles/import", { pack }),
    backupInfo: () => call("/api/backup"),
    backupNow: () => call("/api/backup", {}),
    readFile: (name) => call(`/api/file?name=${encodeURIComponent(name)}`),
    writeFile: (name, text) => call("/api/file", { name, text }),
};
