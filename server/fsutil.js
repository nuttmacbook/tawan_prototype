import { readFile, writeFile, rename, rm } from "node:fs/promises";
import crypto from "node:crypto";

/* ------------------------------------ one writer per file */

// Every read-modify-write of the same file waits for the previous one,
// so a message sent while she's answering can't be dropped by an older copy of the list.
const queues = new Map();

/**
 * Runs fn after every earlier call for the same key has finished.
 * @template T
 * @param {string} key usually the file path
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export function withFileLock(key, fn) {
    const previous = queues.get(key) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    const tail = run.catch(() => {});
    queues.set(key, tail);
    // Drop the entry once nothing else is queued, so the map doesn't grow forever
    tail.then(() => {
        if (queues.get(key) === tail) queues.delete(key);
    });
    return run;
}

/* ------------------------------------ crash-safe writes */

/**
 * Writes to a temporary file first and then renames it over the target.
 * A crash or power cut mid-write leaves either the old file or the new one, never half of each.
 * @param {string} file
 * @param {string | Buffer} data
 */
export async function writeAtomic(file, data) {
    const tmp = `${file}.${process.pid}-${crypto.randomBytes(4).toString("hex")}.tmp`;
    try {
        await writeFile(tmp, data);
        await rename(tmp, file);
    } catch (err) {
        await rm(tmp, { force: true }).catch(() => {});
        throw err;
    }
}

/** Missing files read as empty */
export async function readText(file) {
    try {
        return await readFile(file, "utf8");
    } catch {
        return "";
    }
}

/**
 * Read, change and write one text file as a single locked step.
 * @param {string} file
 * @param {(text: string) => string | null | undefined | Promise<string | null | undefined>} change
 *   returns the new content, or null/undefined to leave the file as it is
 * @returns {Promise<string>} the content now on disk
 */
export function updateText(file, change) {
    return withFileLock(file, async () => {
        const before = await readText(file);
        const after = await change(before);
        if (after == null || after === before) return before;
        await writeAtomic(file, after);
        return after;
    });
}
