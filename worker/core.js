/*
 * MPA worker core: the middleman between the MPA web app (GitHub Pages) and hianime.
 * worker.js is the Cloudflare entry point; local/server.mjs runs the same code on your computer.
 *
 * It does in JavaScript what ani-cli does with curl and sed:
 *   search page -> episode list -> episode servers -> ZokoAnime embed -> m3u8
 * and then relays the video through itself, because browsers can't set the Referer
 * header the stream host wants and the stream host doesn't send CORS headers.
 *
 * The scraping follows ani-cli (https://github.com/pystardust/ani-cli, GPL-3.0) v5.1.5.
 * When hianime changes and ani-cli ships a fix, port the same change here.
 *
 * Routes
 *   GET  /api/health[?deep=1]              setup status (and an upstream reachability check)
 *   GET  /api/search?q=naruto              [{ id, title, poster, type, sub, dub, eps }]
 *   GET  /api/episodes?id=naruto-677       { episodes: [{ n, id, title, filler }] }
 *   GET  /api/info?id=naruto-677           { title, poster, description } (best effort)
 *   GET  /api/sources?id=..&epId=..&mode=sub|dub   { master, subtitles, malId, ... }
 *   GET  /api/skip?mal=20&ep=1&len=1420    intro/outro times from aniskip
 *   POST /api/complaint                    files a GitHub issue (needs GITHUB_TOKEN)
 *   GET  /p?t=<token>&u=<url>              signed relay for playlists, segments, subtitles
 *
 * Settings (Cloudflare dashboard -> your worker -> Settings -> Variables and Secrets)
 *   SIGNING_KEY      secret, required. Any long random string. Signs relay links so the
 *                    worker can't be used as an open proxy.
 *   GITHUB_TOKEN     secret, optional. Fine-grained token with Issues: read and write on the
 *                    MPA repo. Without it, complaints fall back to a prefilled GitHub link.
 *   GITHUB_REPO      default lolesterrr/MPA-monsieur-pierre-aniCLI-
 *   ALLOWED_ORIGINS  comma separated, default * . e.g. https://lolesterrr.github.io,http://localhost:*
 *   BASE_URL         default https://hianime.at (same as ani-cli)
 *   COMPLAINTS_PER_10_MIN  per visitor, default 5
 */

export const VERSION = "1.0.0";

const DEFAULTS = {
  BASE_URL: "https://hianime.at",
  GITHUB_REPO: "lolesterrr/MPA-monsieur-pierre-aniCLI-",
  ANISKIP_URL: "https://api.aniskip.com",
  GITHUB_API: "https://api.github.com",
  TOKEN_TTL: 6 * 60 * 60,
};

// Same browser identity ani-cli uses.
export const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// The embed page ships its config as base64(json XOR "otaku-embed-v1").
const EMBED_KEY = [111, 116, 97, 107, 117, 45, 101, 109, 98, 101, 100, 45, 118, 49];

const COMPLAINT_KINDS = {
  video: "Video won't play",
  slow: "Slow or keeps buffering",
  subs: "Subtitles",
  wrong: "Wrong anime or episode",
  search: "Search",
  idea: "Idea or request",
  other: "Something else",
};

// ---------------------------------------------------------------------------
// small helpers

export class HttpError extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#039": "'", "#39": "'" };

export function decodeEntities(s) {
  return String(s || "").replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (m, e) => {
    const k = e.toLowerCase();
    if (k in ENTITIES) return ENTITIES[k];
    if (k[0] === "#") {
      const code = k[1] === "x" ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return m;
  });
}

function attr(tag, name) {
  const m = String(tag || "").match(new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`, "i"));
  return m ? decodeEntities(m[1]) : "";
}

function stripTags(s) {
  return decodeEntities(String(s || "").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function b64ToBytes(b64) {
  let s = String(b64 || "").replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64url(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64urlText(s) {
  return bytesToB64url(enc.encode(s));
}

function textFromB64url(s) {
  return dec.decode(b64ToBytes(s));
}

/** All string values inside a parsed JSON value, joined. Used for "html in json" responses. */
function jsonStrings(v, out = []) {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => jsonStrings(x, out));
  else if (v && typeof v === "object") Object.values(v).forEach((x) => jsonStrings(x, out));
  return out;
}

/** hianime's theme API answers JSON with escaped HTML inside. Get the HTML back. */
export function unwrapHtml(text) {
  const t = String(text || "").trim();
  if (t.startsWith("{") || t.startsWith("[")) {
    try {
      return jsonStrings(JSON.parse(t)).join("\n");
    } catch {
      /* fall through to ani-cli's way */
    }
  }
  return t.replace(/\\"/g, '"').replace(/\\\//g, "/").replace(/\\n/g, "\n").replace(/\\/g, "");
}

// ---------------------------------------------------------------------------
// parsing (mirrors ani-cli's sed pipelines)

/**
 * Search results. ani-cli cuts the page at id="main-sidebar" (the top-10 sidebar repeats the
 * result markup), splits on <div class="film-detail"> and reads the slug and title from the
 * <h3 class="film-name"><a href=".../slug" title="Title"> that follows.
 */
export function parseSearch(html) {
  const page = String(html || "").split('id="main-sidebar"')[0].replace(/\r?\n/g, " ");
  const parts = page.split('<div class="film-detail">');
  const out = [];
  const seen = new Set();
  for (let i = 1; i < parts.length; i++) {
    const chunk = parts[i];
    const m = chunk.match(/<h3 class="film-name">\s*<a href="[^"]*\/([^"/]*)"\s*title="([^"]*)"/);
    if (!m) continue;
    const id = m[1].split("?")[0];
    if (seen.has(id)) continue;
    seen.add(id);
    const title = decodeEntities(m[2]);
    const item = { id, title };

    // Extras for the grid (ani-cli doesn't need them): the poster block sits right before
    // the detail block, so look at the tail of the previous chunk.
    const before = parts[i - 1].slice(-2500);
    const imgs = before.match(/<img\b[^>]*>/gi) || [];
    const img = imgs.reverse().find((t) => /poster/i.test(t) || attr(t, "alt") === title);
    if (img) {
      const src = attr(img, "data-src") || attr(img, "src");
      if (/^https?:\/\//i.test(src)) item.poster = src;
    }
    for (const kind of ["sub", "dub", "eps"]) {
      const t = before.match(new RegExp(`tick-${kind}[^>]*>([\\s\\S]*?)</div>`, "i"));
      const n = t && stripTags(t[1]).match(/\d+/);
      if (n) item[kind] = Number(n[0]);
    }
    const jname = chunk.match(/data-jname="([^"]*)"/);
    if (jname) item.jname = decodeEntities(jname[1]);
    const info = chunk.match(/<div class="fd-infor">([\s\S]*?)<\/div>/);
    if (info) {
      const bits = [...info[1].matchAll(/<span class="fdi-item[^"]*">([\s\S]*?)<\/span>/g)].map((x) => stripTags(x[1]));
      if (bits[0]) item.type = bits[0];
      if (bits[1]) item.duration = bits[1];
    }
    out.push(item);
  }
  return out;
}

/** Numeric id at the end of a slug, the way ani-cli does it: ${1##*-} */
export function numericId(slug) {
  const s = String(slug || "");
  const n = s.slice(s.lastIndexOf("-") + 1);
  return /^\d+$/.test(n) ? n : "";
}

/**
 * Episode list. ani-cli strips backslashes, splits on ep-item and keeps chunks that carry
 * data-number, data-id and a /watch/<slug>?ep= link (so other shows' links don't sneak in).
 */
export function parseEpisodes(text, slug) {
  const html = unwrapHtml(text);
  const parts = html.split("ep-item");
  const out = [];
  const seen = new Set();
  const watch = `/watch/${slug}?ep=`;
  for (let i = 1; i < parts.length; i++) {
    const chunk = parts[i];
    const number = chunk.match(/data-number="([^"]*)"/);
    const id = chunk.match(/data-id="([0-9]+)"/);
    // the start of the same tag (href, title) can sit before the class
    const tagStart = parts[i - 1].slice(parts[i - 1].lastIndexOf("<"));
    if (!number || !id || !(chunk.includes(watch) || tagStart.includes(watch))) continue;
    if (seen.has(id[1])) continue;
    seen.add(id[1]);
    const ep = { n: decodeEntities(number[1]).trim(), id: id[1] };
    const ownTag = tagStart + chunk.slice(0, chunk.indexOf(">") + 1);
    const title = attr(ownTag, "title") || attr((chunk.match(/class="ep-name[^"]*"[^>]*>/) || [""])[0], "title");
    if (title.trim()) ep.title = title.trim();
    if (/filler/i.test(ownTag)) ep.filler = true;
    out.push(ep);
  }
  const numeric = out.every((e) => /^\d+(\.\d+)?$/.test(e.n));
  if (numeric) out.sort((a, b) => Number(a.n) - Number(b.n));
  return out;
}

/** Server list for one episode: [{ type: "sub"|"dub"|..., name, hash, serverId }] */
export function parseServers(text) {
  const html = unwrapHtml(text);
  const parts = html.split("server-item");
  const out = [];
  for (let i = 1; i < parts.length; i++) {
    const chunk = parts[i].slice(0, 1500);
    const type = chunk.match(/data-type="([^"]*)"/);
    const name = chunk.match(/data-server-name="([^"]*)"/);
    const hash = chunk.match(/data-hash="([^"]*)"/);
    if (!type || !hash) continue;
    const id = chunk.match(/data-server-id="([^"]*)"/) || chunk.match(/data-id="([^"]*)"/);
    out.push({
      type: type[1].toLowerCase(),
      name: name ? decodeEntities(name[1]) : "",
      hash: hash[1],
      serverId: id ? id[1] : "",
    });
  }
  return out;
}

/** base64(json XOR "otaku-embed-v1") -> parsed config. Same as ani-cli's deobfuscate_blob. */
export function deobfuscate(blob) {
  const bytes = b64ToBytes(blob);
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = bytes[i] ^ EMBED_KEY[i % EMBED_KEY.length];
  return dec.decode(out);
}

/** Pull window.__P out of the embed page and decode it. */
export function extractPlayerConfig(html) {
  const m = String(html || "").match(/window\.__P\s*=\s*"([^"]*)"/);
  if (!m) return null;
  return deobfuscate(m[1]);
}

/**
 * Stream links out of the decoded player config. ani-cli takes the last "src" that contains
 * .m3u8 and the default subtitle. We return every candidate, ani-cli's pick first.
 */
export function parsePlayerConfig(jsonText) {
  const found = [];
  const subs = [];
  let data = null;
  try {
    data = JSON.parse(jsonText);
  } catch {
    data = null;
  }
  if (data) {
    const walk = (v, key) => {
      if (typeof v === "string") {
        if (/\.m3u8(\?|$|#)/i.test(v) && /^https?:\/\//i.test(v)) found.push(v);
        return;
      }
      if (Array.isArray(v)) {
        if (key === "subtitles" || key === "tracks" || key === "captions") {
          for (const t of v) {
            if (!t || typeof t !== "object") continue;
            const src = t.src || t.file || t.url;
            if (typeof src !== "string" || !/^https?:\/\//i.test(src)) continue;
            if (t.kind && !/sub|caption/i.test(t.kind)) continue;
            subs.push({
              url: src,
              label: String(t.label || t.name || t.lang || t.srclang || "Subtitles"),
              lang: String(t.srclang || t.lang || t.language || "").slice(0, 12),
              default: t.default === true || t.default === "true",
            });
          }
          return;
        }
        v.forEach((x) => walk(x, key));
        return;
      }
      if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, k);
    };
    walk(data, "");
  } else {
    // ani-cli's regexes, for configs that aren't strict JSON
    for (const m of String(jsonText).matchAll(/"src":"([^"]*\.m3u8[^"]*)"/g)) found.push(m[1].replace(/\\\//g, "/"));
    const block = String(jsonText).split('"subtitles":[')[1];
    if (block) {
      for (const t of block.split("}]")[0].split("},{")) {
        const src = t.match(/"src":"([^"]*)"/);
        if (src) {
          const label = t.match(/"label":"([^"]*)"/);
          subs.push({ url: src[1].replace(/\\\//g, "/"), label: label ? label[1] : "Subtitles", lang: "", default: /"default":true/.test(t) });
        }
      }
    }
  }
  const unique = [...new Set(found)];
  // ani-cli's greedy sed picks the last one; put it first
  const sources = unique.length ? [unique[unique.length - 1], ...unique.slice(0, -1)] : [];
  if (subs.length && !subs.some((s) => s.default)) {
    const en = subs.find((s) => /^en|english/i.test(s.lang || s.label));
    (en || subs[0]).default = true;
  }
  return { sources, subtitles: subs };
}

export function parseInfo(html) {
  const meta = (prop) => {
    const re = new RegExp(`<meta[^>]+(?:property|name)="${prop}"[^>]*>`, "i");
    const tag = String(html || "").match(re);
    return tag ? attr(tag[0], "content") : "";
  };
  const title = meta("og:title") || stripTags((String(html).match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || "");
  return {
    title: title.replace(/\s*[|\-–]\s*(watch|hianime).*$/i, "").trim() || null,
    poster: meta("og:image") || null,
    description: meta("og:description") || meta("description") || null,
  };
}

// ---------------------------------------------------------------------------
// HLS relay: signed tokens + playlist rewriting

const keyCache = new Map();

function hmacKey(secret) {
  let key = keyCache.get(secret);
  if (!key) {
    key = crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    keyCache.set(secret, key);
  }
  return key;
}

async function sign(secret, payload) {
  const key = await hmacKey(secret);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(payload)));
  return bytesToB64url(mac.slice(0, 18));
}

/** Token = exp.referer.hosts.sig  (referer and hosts base64url). */
export async function makeToken(secret, { referer = "", hosts = [], ttl = DEFAULTS.TOKEN_TTL, now = Date.now() }) {
  const exp = Math.floor(now / 1000) + ttl;
  const payload = `${exp}.${b64urlText(referer)}.${b64urlText([...new Set(hosts)].join(","))}`;
  return `${payload}.${await sign(secret, payload)}`;
}

export async function readToken(secret, token, now = Date.now()) {
  const parts = String(token || "").split(".");
  if (parts.length !== 4) return null;
  const payload = parts.slice(0, 3).join(".");
  const expected = await sign(secret, payload);
  if (!timingSafeEqual(expected, parts[3])) return null;
  const exp = Number(parts[0]);
  if (!Number.isFinite(exp) || exp * 1000 < now) return null;
  let referer, hosts;
  try {
    referer = textFromB64url(parts[1]);
    hosts = textFromB64url(parts[2]).split(",").filter(Boolean);
  } catch {
    return null;
  }
  return { exp, referer, hosts };
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function relayUrl(origin, token, url) {
  return `${origin}/p?t=${token}&u=${encodeURIComponent(url)}`;
}

const URI_ATTR = /URI="([^"]*)"/g;

/** Every absolute URL a playlist points at, resolved against its own address. */
export function playlistTargets(text, base) {
  const urls = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#")) {
      for (const m of line.matchAll(URI_ATTR)) urls.push(new URL(m[1], base).href);
    } else {
      urls.push(new URL(line, base).href);
    }
  }
  return urls;
}

/** Point every URI in an m3u8 at the relay. */
export function rewritePlaylist(text, base, toRelay) {
  return String(text)
    .split(/\r?\n/)
    .map((raw) => {
      const line = raw.trim();
      if (!line) return raw;
      if (line.startsWith("#")) {
        if (!line.includes('URI="')) return raw;
        return raw.replace(URI_ATTR, (_, u) => `URI="${toRelay(new URL(u, base).href)}"`);
      }
      return toRelay(new URL(line, base).href);
    })
    .join("\n");
}

const MEDIA_EXT = /\.(ts|m4s|mp4|m4a|m4v|aac|mp3|vtt|webvtt|srt|ass|jpe?g|png|webp|gif|key|bin)$/i;

function concatBytes(chunks) {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

function looksLikePlaylist(url, contentType) {
  return /mpegurl/i.test(contentType || "") || /\.m3u8?(\?|$)/i.test(new URL(url).pathname);
}

// ---------------------------------------------------------------------------
// tiny per-isolate memory: response cache and rate limits

const memo = new Map();

function memoGet(key) {
  const hit = memo.get(key);
  if (!hit) return undefined;
  if (hit.exp < Date.now()) {
    memo.delete(key);
    return undefined;
  }
  return hit.value;
}

function memoSet(key, value, ttlMs) {
  if (memo.size > 300) memo.delete(memo.keys().next().value);
  memo.set(key, { value, exp: Date.now() + ttlMs });
}

const buckets = new Map();

function rateLimited(key, limit, windowMs) {
  const now = Date.now();
  const b = buckets.get(key) || { n: 0, reset: now + windowMs };
  if (b.reset < now) {
    b.n = 0;
    b.reset = now + windowMs;
  }
  b.n++;
  buckets.set(key, b);
  if (buckets.size > 5000) buckets.delete(buckets.keys().next().value);
  return b.n > limit;
}

// ---------------------------------------------------------------------------
// HTTP plumbing

function originAllowed(origin, allowed) {
  if (!origin) return false;
  const list = String(allowed || "*").split(",").map((s) => s.trim()).filter(Boolean);
  return list.some((pattern) => {
    if (pattern === "*") return true;
    if (pattern === origin) return true;
    if (pattern.endsWith(":*")) {
      const prefix = pattern.slice(0, -2);
      return origin === prefix || (origin.startsWith(prefix + ":") && /^\d+$/.test(origin.slice(prefix.length + 1)));
    }
    return false;
  });
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  const allowed = env.ALLOWED_ORIGINS || "*";
  const h = {
    "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Range",
    "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  if (allowed.trim() === "*") h["Access-Control-Allow-Origin"] = "*";
  else if (originAllowed(origin, allowed)) h["Access-Control-Allow-Origin"] = origin;
  return h;
}

function json(request, env, status, data, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...corsHeaders(request, env), ...extra },
  });
}

function settings(env) {
  return {
    base: String(env.BASE_URL || DEFAULTS.BASE_URL).replace(/\/+$/, ""),
    repo: env.GITHUB_REPO || DEFAULTS.GITHUB_REPO,
    aniskip: String(env.ANISKIP_URL || DEFAULTS.ANISKIP_URL).replace(/\/+$/, ""),
    githubApi: String(env.GITHUB_API || DEFAULTS.GITHUB_API).replace(/\/+$/, ""),
    ttl: Number(env.TOKEN_TTL) > 0 ? Number(env.TOKEN_TTL) : DEFAULTS.TOKEN_TTL,
  };
}

export function isChallenge(status, text) {
  const t = String(text || "").slice(0, 20000);
  if (/<title>\s*Just a moment/i.test(t)) return true;
  return (status === 403 || status === 503 || status === 429) && /cf-chl|challenge-platform|cf_chl_opt|Attention Required/i.test(t);
}

function short(url) {
  try {
    const u = new URL(url);
    return u.host + u.pathname.slice(0, 40);
  } catch {
    return String(url).slice(0, 60);
  }
}

// ---------------------------------------------------------------------------
// the app

/**
 * createHandler({ upstream }) -> (request, env, ctx) => Response
 * upstream(url, init, kind) lets the local helper swap in curl-impersonate for page fetches.
 * kind is "page" for hianime/embed HTML and JSON, "media" for playlists, segments, subtitles.
 */
export function createHandler(hooks = {}) {
  const upstream = hooks.upstream || ((url, init) => fetch(url, init));

  async function getText(url, { referer, accept, ttl } = {}) {
    const cacheKey = ttl ? `t:${url}` : null;
    if (cacheKey) {
      const hit = memoGet(cacheKey);
      if (hit !== undefined) return hit;
    }
    let res;
    try {
      res = await upstream(
        url,
        {
          headers: {
            "User-Agent": UA,
            Accept: accept || "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
            ...(referer ? { Referer: referer } : {}),
          },
          redirect: "follow",
          signal: AbortSignal.timeout(12000),
        },
        "page",
      );
    } catch (e) {
      throw new HttpError(502, "unreachable", `Couldn't reach ${short(url)} (${e.name === "TimeoutError" ? "timed out" : e.message || "network error"}).`);
    }
    const text = await res.text();
    if (isChallenge(res.status, text)) {
      throw new HttpError(503, "blocked", "Cloudflare stopped the worker at the door (bot check). See the README section 'If Cloudflare blocks the worker'.");
    }
    if (!res.ok) throw new HttpError(502, "upstream", `hianime answered HTTP ${res.status} for ${short(url)}.`);
    if (cacheKey) memoSet(cacheKey, text, ttl);
    return text;
  }

  async function search(cfg, q, page) {
    const params = new URLSearchParams({ keyword: q });
    if (page > 1) params.set("page", String(page));
    const html = await getText(`${cfg.base}/search?${params}`, { ttl: 5 * 60e3 });
    return parseSearch(html);
  }

  async function episodes(cfg, slug) {
    const num = numericId(slug);
    if (!num) throw new HttpError(400, "bad_id", "That anime id doesn't end in a number.");
    const text = await getText(`${cfg.base}/api/theme/episode/list/${num}`, {
      accept: "application/json, text/javascript, */*; q=0.01",
      referer: `${cfg.base}/watch/${slug}`,
      ttl: 10 * 60e3,
    });
    return parseEpisodes(text, slug);
  }

  async function sources(request, env, cfg, { slug, epId, ep, mode }) {
    if (!env.SIGNING_KEY) throw new HttpError(501, "setup", "The worker has no SIGNING_KEY yet, so it can't relay video. Add it in the worker's settings.");
    let episodeId = epId;
    if (!episodeId) {
      const list = await episodes(cfg, slug);
      const hit = list.find((e) => e.n === ep);
      if (!hit) throw new HttpError(404, "no_episode", `Episode ${ep} isn't out (or isn't listed) yet.`);
      episodeId = hit.id;
    }
    const serversText = await getText(`${cfg.base}/api/theme/episode/servers?episodeId=${episodeId}`, {
      accept: "application/json, text/javascript, */*; q=0.01",
      referer: `${cfg.base}/watch/${slug}?ep=${episodeId}`,
      ttl: 5 * 60e3,
    });
    const servers = parseServers(serversText);
    const available = [...new Set(servers.map((s) => s.type))];
    // ani-cli only understands the ZokoAnime embed; the other servers use different players
    const server = servers.find((s) => s.type === mode && /zokoanime/i.test(s.name));
    if (!server) {
      const msg = available.includes(mode)
        ? `This episode has ${mode} on other servers, but not on ZokoAnime (the only player MPA understands).`
        : `No ${mode} for this episode. Available: ${available.join(", ") || "nothing"}.`;
      throw new HttpError(404, "no_source", msg, { available });
    }
    let embed;
    try {
      embed = dec.decode(b64ToBytes(server.hash)).trim();
    } catch {
      embed = "";
    }
    if (!/^https?:\/\//i.test(embed)) throw new HttpError(502, "bad_embed", "The server hash didn't decode to a link.");
    const embedUrl = new URL(embed);
    const referer = `${embedUrl.origin}/`;
    const mal = embed.match(/\/mal\/(\d+)\//);
    const page = await getText(embed, { referer: `${cfg.base}/` });
    const config = extractPlayerConfig(page);
    if (!config) throw new HttpError(502, "no_config", "The embed page changed: window.__P is missing. ani-cli probably needs an update too.");
    const parsed = parsePlayerConfig(config);
    if (!parsed.sources.length) throw new HttpError(502, "no_m3u8", "The player config has no m3u8 link.");

    const origin = new URL(request.url).origin;
    const hosts = [...parsed.sources, ...parsed.subtitles.map((s) => s.url)].map((u) => new URL(u).host);
    const token = await makeToken(env.SIGNING_KEY, { referer, hosts, ttl: cfg.ttl });
    return {
      id: slug,
      epId: episodeId,
      mode,
      available,
      malId: mal ? Number(mal[1]) : null,
      master: relayUrl(origin, token, parsed.sources[0]),
      alternates: parsed.sources.slice(1).map((u) => relayUrl(origin, token, u)),
      subtitles: parsed.subtitles.map((s) => ({ ...s, url: relayUrl(origin, token, s.url) })),
      expires: Math.floor(Date.now() / 1000) + cfg.ttl,
    };
  }

  async function relay(request, env, cfg) {
    const url = new URL(request.url);
    if (!env.SIGNING_KEY) return json(request, env, 501, { error: "setup", message: "SIGNING_KEY is missing." });
    const tok = await readToken(env.SIGNING_KEY, url.searchParams.get("t"));
    if (!tok) return json(request, env, 403, { error: "bad_token", message: "This link expired or wasn't made by this worker. Reload the episode." });
    let target;
    try {
      target = new URL(url.searchParams.get("u") || "");
    } catch {
      return json(request, env, 400, { error: "bad_url", message: "Missing target." });
    }
    if (!/^https?:$/.test(target.protocol) || !tok.hosts.includes(target.host)) {
      return json(request, env, 403, { error: "not_allowed", message: "That host isn't part of this stream." });
    }
    const headers = { "User-Agent": UA, Accept: "*/*", "Accept-Language": "en-US,en;q=0.9" };
    if (tok.referer) {
      headers.Referer = tok.referer;
      headers.Origin = tok.referer.replace(/\/$/, "");
    }
    const range = request.headers.get("Range");
    if (range) headers.Range = range;
    let res;
    try {
      res = await upstream(target.href, { method: request.method === "HEAD" ? "HEAD" : "GET", headers, redirect: "follow" }, "media");
    } catch (e) {
      return json(request, env, 502, { error: "unreachable", message: `Couldn't reach ${target.host}: ${e.message || "network error"}` });
    }
    const cors = corsHeaders(request, env);
    const finalUrl = res.url || target.href;
    const type = res.headers.get("Content-Type") || "";
    let body = res.body;
    let playlist = null;
    if (res.ok && request.method !== "HEAD" && body) {
      if (looksLikePlaylist(finalUrl, type)) {
        playlist = await res.text();
      } else if (!/^(video|audio|image)\//i.test(type) && !MEDIA_EXT.test(new URL(finalUrl).pathname)) {
        // some hosts serve playlists as text/plain from paths without .m3u8: peek at the start
        const reader = body.getReader();
        const first = await reader.read();
        const head = first.value ? dec.decode(first.value.slice(0, 32)) : "";
        if (/^\uFEFF?\s*#EXTM3U/.test(head)) {
          const chunks = first.value ? [first.value] : [];
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
          }
          playlist = dec.decode(concatBytes(chunks));
        } else {
          body = new ReadableStream({
            start(c) {
              if (first.done) c.close();
              else c.enqueue(first.value);
            },
            async pull(c) {
              const { done, value } = await reader.read();
              if (done) c.close();
              else c.enqueue(value);
            },
            cancel(reason) {
              return reader.cancel(reason);
            },
          });
        }
      }
    }
    if (playlist !== null) {
      const text = playlist.replace(/^\uFEFF/, "");
      if (!text.trimStart().startsWith("#EXTM3U")) {
        return new Response(text, { status: res.status, headers: { "Content-Type": type || "text/plain", ...cors } });
      }
      const origin = url.origin;
      const hosts = new Set(tok.hosts);
      const before = hosts.size;
      playlistTargets(text, finalUrl).forEach((t) => hosts.add(new URL(t).host));
      hosts.add(new URL(finalUrl).host);
      const token = hosts.size === before ? url.searchParams.get("t") : await makeToken(env.SIGNING_KEY, { referer: tok.referer, hosts: [...hosts], ttl: cfg.ttl });
      return new Response(rewritePlaylist(text, finalUrl, (u) => relayUrl(origin, token, u)), {
        status: 200,
        headers: { "Content-Type": "application/vnd.apple.mpegurl", "Cache-Control": "no-store", ...cors },
      });
    }
    const out = new Headers(cors);
    for (const h of ["Content-Type", "Content-Length", "Content-Range", "Accept-Ranges", "Last-Modified", "ETag"]) {
      const v = res.headers.get(h);
      if (v) out.set(h, v);
    }
    if (/\.vtt(\?|$)/i.test(finalUrl) && !/vtt/i.test(type)) out.set("Content-Type", "text/vtt; charset=utf-8");
    out.set("Cache-Control", res.ok ? "public, max-age=3600" : "no-store");
    return new Response(request.method === "HEAD" ? null : body, { status: res.status, headers: out });
  }

  async function skipTimes(cfg, mal, ep, len) {
    const params = new URLSearchParams();
    params.append("types[]", "op");
    params.append("types[]", "ed");
    params.append("types[]", "recap");
    params.append("episodeLength", String(len || 0));
    let res;
    try {
      res = await upstream(`${cfg.aniskip}/v2/skip-times/${mal}/${ep}?${params}`, { headers: { "User-Agent": "MPA" }, signal: AbortSignal.timeout(8000) }, "page");
    } catch {
      return { found: false };
    }
    if (!res.ok) return { found: false };
    const data = await res.json().catch(() => null);
    if (!data || !data.found || !Array.isArray(data.results)) return { found: false };
    const out = { found: true };
    for (const r of data.results) {
      if (!r || !r.interval) continue;
      out[r.skipType] = { start: r.interval.startTime, end: r.interval.endTime };
    }
    return out;
  }

  async function complaint(request, env, cfg) {
    const ip = request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For") || "local";
    const limit = Number(env.COMPLAINTS_PER_10_MIN) > 0 ? Number(env.COMPLAINTS_PER_10_MIN) : 5;
    if (rateLimited(`c:${ip}`, limit, 10 * 60e3)) throw new HttpError(429, "slow_down", "Pierre is still reading your last complaints. Try again in a few minutes.");
    const raw = await request.text();
    if (raw.length > 20000) throw new HttpError(413, "too_long", "That complaint is longer than Pierre's attention span.");
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      throw new HttpError(400, "bad_json", "Couldn't read that.");
    }
    if (body.website) return json(request, env, 200, { ok: true, number: 0 }); // honeypot: pretend it worked
    const kind = COMPLAINT_KINDS[body.kind] ? body.kind : "other";
    const message = clean(body.message, 3000);
    if (message.length < 3) throw new HttpError(400, "empty", "Write at least a few words, Pierre can't read minds. Only snacks.");
    if (Number(body.elapsed) > 0 && Number(body.elapsed) < 1500) throw new HttpError(400, "too_fast", "That was fast. Too fast. Try again.");
    const dupKey = `d:${ip}:${message.slice(0, 200)}`;
    if (memoGet(dupKey)) throw new HttpError(409, "duplicate", "Pierre already has this one on his desk.");
    const issue = complaintIssue(kind, message, body);
    if (!env.GITHUB_TOKEN) {
      throw new HttpError(501, "not_configured", "The complaint desk isn't connected to GitHub yet.", { fallback: issueLink(cfg.repo, issue) });
    }
    const res = await upstream(
      `${cfg.githubApi}/repos/${cfg.repo}/issues`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.GITHUB_TOKEN}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
          "User-Agent": "MPA-worker",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify(issue),
      },
      "api",
    );
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new HttpError(502, "github", `GitHub said ${res.status}${detail ? ": " + clean(detail, 160) : ""}.`, { fallback: issueLink(cfg.repo, issue) });
    }
    const made = await res.json();
    memoSet(dupKey, true, 10 * 60e3);
    return json(request, env, 201, { ok: true, number: made.number, url: made.html_url });
  }

  async function handle(request, env = {}, ctx) {
    const url = new URL(request.url);
    const cfg = settings(env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    try {
      if (url.pathname === "/p") return await relay(request, env, cfg);

      if (url.pathname === "/api/complaint") {
        if (request.method !== "POST") throw new HttpError(405, "method", "POST a complaint here.");
        return await complaint(request, env, cfg);
      }

      if (request.method !== "GET" && request.method !== "HEAD") throw new HttpError(405, "method", "Only GET here.");
      const ip = request.headers.get("CF-Connecting-IP") || "local";
      if (url.pathname.startsWith("/api/") && rateLimited(`a:${ip}`, 240, 60e3)) {
        throw new HttpError(429, "slow_down", "Too many requests. Pierre needs a nap. Try again in a minute.");
      }
      const p = url.searchParams;

      switch (url.pathname) {
        case "/":
        case "/api":
        case "/api/health": {
          const out = {
            ok: true,
            name: "MPA worker",
            version: VERSION,
            base: cfg.base,
            signing: Boolean(env.SIGNING_KEY),
            complaints: Boolean(env.GITHUB_TOKEN),
            repo: cfg.repo,
          };
          if (p.get("deep")) {
            try {
              await getText(`${cfg.base}/search?keyword=one+piece`, { ttl: 60e3 });
              out.upstream = "ok";
            } catch (e) {
              out.upstream = e.code || "error";
              out.upstreamMessage = e.message;
            }
          }
          return json(request, env, 200, out);
        }
        case "/api/search": {
          const q = clean(p.get("q"), 100);
          if (!q) throw new HttpError(400, "empty", "Search for something.");
          const page = Math.max(1, Math.min(20, Number(p.get("page")) || 1));
          return json(request, env, 200, { q, page, results: await search(cfg, q, page) });
        }
        case "/api/episodes": {
          const id = slugParam(p.get("id"));
          return json(request, env, 200, { id, episodes: await episodes(cfg, id) });
        }
        case "/api/info": {
          const id = slugParam(p.get("id"));
          let info = { title: null, poster: null, description: null };
          try {
            info = parseInfo(await getText(`${cfg.base}/${id}`, { ttl: 60 * 60e3 }));
          } catch (e) {
            if (e.code === "blocked") throw e;
          }
          return json(request, env, 200, { id, ...info });
        }
        case "/api/sources": {
          const id = slugParam(p.get("id"));
          const mode = p.get("mode") === "dub" ? "dub" : "sub";
          const epId = /^\d{1,12}$/.test(p.get("epId") || "") ? p.get("epId") : "";
          const ep = clean(p.get("ep"), 12);
          if (!epId && !ep) throw new HttpError(400, "no_episode", "Which episode?");
          return json(request, env, 200, await sources(request, env, cfg, { slug: id, epId, ep, mode }));
        }
        case "/api/skip": {
          const mal = /^\d{1,9}$/.test(p.get("mal") || "") ? p.get("mal") : "";
          const ep = /^\d{1,5}$/.test(p.get("ep") || "") ? p.get("ep") : "";
          if (!mal || !ep) return json(request, env, 200, { found: false });
          const len = Math.max(0, Math.min(36000, Math.round(Number(p.get("len")) || 0)));
          return json(request, env, 200, await skipTimes(cfg, mal, ep, len), { "Cache-Control": "public, max-age=86400" });
        }
        default:
          throw new HttpError(404, "not_found", "Nothing here. Pierre checked under the sofa.");
      }
    } catch (e) {
      if (e instanceof HttpError) return json(request, env, e.status, { error: e.code, message: e.message, ...(e.extra || {}) });
      console.error(e && e.stack ? e.stack : e);
      return json(request, env, 500, { error: "internal", message: "Something broke inside the worker." });
    }
  }

  return handle;
}

function slugParam(v) {
  const s = String(v || "").trim();
  if (!/^[a-z0-9][a-z0-9-]{0,200}$/i.test(s)) throw new HttpError(400, "bad_id", "That doesn't look like an anime id.");
  return s;
}

function clean(v, max) {
  return String(v || "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim()
    .slice(0, max);
}

function cell(v, max = 300) {
  return clean(v, max).replace(/\r?\n/g, " ").replace(/\|/g, "\\|").replace(/@/g, "@\u200b") || "-";
}

export function complaintIssue(kind, message, body = {}) {
  const c = body.context && typeof body.context === "object" ? body.context : {};
  const label = COMPLAINT_KINDS[kind] || COMPLAINT_KINDS.other;
  const firstLine = message.split(/\r?\n/)[0].slice(0, 70);
  const quoted = message
    .replace(/@/g, "@\u200b")
    .split(/\r?\n/)
    .map((l) => `> ${l}`)
    .join("\n");
  const rows = [
    ["Kind", label],
    ["Page", c.page],
    ["Anime", c.title ? `${c.title}${c.id ? ` (\`${c.id}\`)` : ""}` : c.id],
    ["Episode", c.ep ? `${c.ep}${c.mode ? ` (${c.mode})` : ""}` : ""],
    ["Error", c.error],
    ["Worker", c.api],
    ["Browser", c.ua],
    ["App", c.app],
    ["Contact", body.contact],
  ].filter(([, v]) => v);
  const table = ["| | |", "|---|---|", ...rows.map(([k, v]) => `| ${k} | ${cell(v)} |`)].join("\n");
  return {
    title: `[${label}] ${firstLine}`,
    body: `${quoted}\n\n${table}\n\n_Filed at the MPA complaint desk. Monsieur Pierre has read it. Probably._`,
    labels: ["complaint", kind],
  };
}

export function issueLink(repo, issue) {
  const q = new URLSearchParams({ title: issue.title, body: issue.body.slice(0, 6000), labels: issue.labels.join(",") });
  return `https://github.com/${repo}/issues/new?${q}`;
}

