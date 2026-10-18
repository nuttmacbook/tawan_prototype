/** Escapes text before it goes into innerHTML; chat text comes from the model and the user */
const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const CARD = "rounded-2xl border border-white/5 bg-slate-900/70 ring-1 ring-inset ring-sky-400/10 backdrop-blur shadow-[0_20px_60px_-30px_rgba(14,165,233,0.35)]";
const EYEBROW = "text-[10px] font-semibold uppercase tracking-[0.18em] text-sky-400/70 sm:text-[11px]";
const INPUT = "w-full min-w-0 rounded-xl border border-white/5 bg-slate-950/60 px-3.5 py-2.5 text-sm text-white placeholder:text-slate-500 ring-1 ring-inset ring-white/5 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/60";
const BTN = "inline-flex items-center justify-center gap-2 rounded-xl bg-sky-500 px-4 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-sky-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300 disabled:cursor-not-allowed disabled:opacity-50";
const BTN_GHOST = "inline-flex items-center justify-center gap-2 rounded-xl px-3 py-2 text-sm font-medium text-slate-300 ring-1 ring-inset ring-white/10 transition hover:bg-white/5 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/60 disabled:opacity-50";

const divider = /*html*/`<div class="h-px bg-gradient-to-r from-transparent via-sky-500/30 to-transparent"></div>`;

/** First letter of the persona's name for the avatar circle */
const initial = (name) => esc(Array.from(String(name ?? "?"))[0] ?? "?");

export { esc, CARD, EYEBROW, INPUT, BTN, BTN_GHOST, divider, initial };
