// Everything MPA remembers lives in this browser's localStorage. No accounts, nothing on a server.
// Every read and write is wrapped, because private windows and blocked storage throw.

const PREFIX = "mpa:";

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function remove(key) {
  try {
    localStorage.removeItem(PREFIX + key);
  } catch {
    /* nothing to do */
  }
}

const DEFAULT_PREFS = { mode: "sub", quality: -1, subs: "default", autoplay: true, autoskip: false };

export const prefs = {
  get() {
    return { ...DEFAULT_PREFS, ...read("prefs", {}) };
  },
  set(patch) {
    const next = { ...prefs.get(), ...patch };
    write("prefs", next);
    return next;
  },
};

// Shows you've started: newest first, one entry per show.
export const history = {
  all() {
    const list = read("history", []);
    return Array.isArray(list) ? list : [];
  },
  get(id) {
    return history.all().find((h) => h.id === id) || null;
  },
  save(entry) {
    const list = history.all().filter((h) => h.id !== entry.id);
    list.unshift({ ...entry, at: Date.now() });
    write("history", list.slice(0, 40));
  },
  forget(id) {
    write("history", history.all().filter((h) => h.id !== id));
    const p = read("progress", {});
    for (const k of Object.keys(p)) if (k.startsWith(id + "#")) delete p[k];
    write("progress", p);
  },
};

// Where you stopped in each episode.
export const progress = {
  key: (id, n) => `${id}#${n}`,
  get(id, n) {
    return read("progress", {})[progress.key(id, n)] || null;
  },
  save(id, n, t, d) {
    const all = read("progress", {});
    all[progress.key(id, n)] = { t: Math.round(t), d: Math.round(d), at: Date.now() };
    const keys = Object.keys(all);
    if (keys.length > 600) {
      keys.sort((a, b) => all[a].at - all[b].at).slice(0, keys.length - 600).forEach((k) => delete all[k]);
    }
    write("progress", all);
  },
  watched(id, n) {
    const p = progress.get(id, n);
    return Boolean(p && p.d && p.t / p.d > 0.9);
  },
  started(id, n) {
    const p = progress.get(id, n);
    return Boolean(p && p.t > 20);
  },
};

export const recent = {
  all: () => read("recent", []),
  add(q) {
    const list = recent.all().filter((x) => x.toLowerCase() !== q.toLowerCase());
    list.unshift(q);
    write("recent", list.slice(0, 8));
  },
  clear: () => remove("recent"),
};

export const settings = {
  apiOverride: () => read("api", ""),
  setApiOverride: (url) => (url ? write("api", url) : remove("api")),
  pierreAwake: () => read("pierre", true) !== false,
  setPierreAwake: (on) => write("pierre", Boolean(on)),
};
