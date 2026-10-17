// Small helpers shared by every view.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ESC[c]);

/** Build an element from an HTML string (first element child). */
export function el(markup) {
  const t = document.createElement("template");
  t.innerHTML = markup.trim();
  return t.content.firstElementChild;
}

export function fmtTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const s = Math.floor(sec % 60);
  const m = Math.floor(sec / 60) % 60;
  const h = Math.floor(sec / 3600);
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

export function minutesLeft(t, d) {
  if (!d) return "";
  const left = Math.max(0, Math.round((d - t) / 60));
  return left <= 1 ? "almost done" : `${left} min left`;
}

/** Slug without its trailing id, as a fallback title: "attack-on-sofa-101" -> "Attack On Sofa" */
export function titleFromSlug(slug) {
  return String(slug || "")
    .replace(/-\d+$/, "")
    .split("-")
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

/** Episode name without a leading "Episode 3:" that some sites put in the title. */
export function epName(title, n) {
  const t = String(title || "").trim();
  const stripped = t.replace(new RegExp(`^(episode|ep\\.?)\\s*${String(n).replace(".", "\\.")}\\s*[:\\-\u2013\u2014.]?\\s*`, "i"), "");
  return /^(episode|ep\.?)\s*\d+$/i.test(stripped) ? "" : stripped;
}

export const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function toast(message, { timeout = 3200 } = {}) {
  let box = $("#toasts");
  if (!box) {
    box = el('<div id="toasts" role="status" aria-live="polite"></div>');
    document.body.append(box);
  }
  const t = el(`<div class="toast">${esc(message)}</div>`);
  box.append(t);
  setTimeout(() => t.classList.add("out"), timeout);
  setTimeout(() => t.remove(), timeout + 400);
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = el("<textarea readonly></textarea>");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.append(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}
