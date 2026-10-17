// Talking to the MPA worker (or the local helper, which answers the same way).
import { settings } from "./store.js";

export const APP_VERSION = "1.0.0";
const PLACEHOLDER = /YOUR-SUBDOMAIN/i;

export function config() {
  return window.MPA_CONFIG || {};
}

export function apiBase() {
  const raw = settings.apiOverride() || config().api || "";
  return String(raw).trim().replace(/\/+$/, "");
}

export function isConfigured() {
  const base = apiBase();
  return Boolean(base) && !PLACEHOLDER.test(base) && /^https?:\/\//i.test(base);
}

export class ApiError extends Error {
  constructor(code, message, { status = 0, data = {} } = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.data = data;
  }
}

const memo = new Map();

async function request(path, { params, method = "GET", body, timeout = 25000, signal, cache = 0 } = {}) {
  if (!isConfigured()) throw new ApiError("not_connected", "MPA isn't connected to its worker yet.");
  const qs = params ? "?" + new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== "")) : "";
  const url = apiBase() + path + qs;
  if (cache && method === "GET") {
    const hit = memo.get(url);
    if (hit && hit.exp > Date.now()) return hit.data;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new DOMException("timeout", "TimeoutError")), timeout);
  const onAbort = () => ctrl.abort(signal.reason);
  if (signal) {
    if (signal.aborted) ctrl.abort(signal.reason);
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  let res;
  try {
    res = await fetch(url, {
      method,
      signal: ctrl.signal,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    if (signal && signal.aborted) throw new ApiError("aborted", "Cancelled.");
    if (ctrl.signal.aborted) throw new ApiError("timeout", `The worker took too long to answer (${Math.round(timeout / 1000)}s).`);
    throw new ApiError("unreachable", `Can't reach the worker at ${apiBase()}.`);
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    const d = data || {};
    throw new ApiError(d.error || `http_${res.status}`, d.message || `The worker answered HTTP ${res.status}.`, { status: res.status, data: d });
  }
  if (cache && method === "GET") memo.set(url, { data, exp: Date.now() + cache });
  return data;
}

export const api = {
  health: (deep = false, opts = {}) => request("/api/health", { params: { deep: deep ? 1 : "" }, timeout: 20000, ...opts }),
  search: (q, opts = {}) => request("/api/search", { params: { q }, cache: 5 * 60e3, ...opts }),
  episodes: (id, opts = {}) => request("/api/episodes", { params: { id }, cache: 10 * 60e3, ...opts }),
  info: (id, opts = {}) => request("/api/info", { params: { id }, cache: 60 * 60e3, timeout: 15000, ...opts }),
  sources: ({ id, epId, ep, mode }, opts = {}) => request("/api/sources", { params: { id, epId, ep, mode }, timeout: 30000, ...opts }),
  skip: ({ mal, ep, len }, opts = {}) => request("/api/skip", { params: { mal, ep, len }, cache: 60 * 60e3, timeout: 10000, ...opts }),
  complain: (payload, opts = {}) => request("/api/complaint", { method: "POST", body: payload, timeout: 20000, ...opts }),
};

// Shows seen in search results, so the anime page can show a title and poster right away.
const SHOW_KEY = "mpa:shows";
export const shows = {
  remember(list) {
    try {
      const all = JSON.parse(sessionStorage.getItem(SHOW_KEY) || "{}");
      for (const s of list) all[s.id] = { id: s.id, title: s.title, poster: s.poster, jname: s.jname, type: s.type, sub: s.sub, dub: s.dub, eps: s.eps };
      sessionStorage.setItem(SHOW_KEY, JSON.stringify(all));
    } catch {
      /* fine */
    }
  },
  get(id) {
    try {
      return JSON.parse(sessionStorage.getItem(SHOW_KEY) || "{}")[id] || null;
    } catch {
      return null;
    }
  },
};
