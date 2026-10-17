// A fake hianime for tests and offline demos.
//
// It serves the same shapes ani-cli 5.1.5 scrapes (search page, theme episode/server API,
// ZokoAnime embed with window.__P, an HLS stream that insists on the embed's Referer) plus a
// mock GitHub issues API and a mock aniskip. The catalog is made up.
//
//   node test/fake-hianime.mjs          # starts on 127.0.0.1:9101-9104 and prints the URLs
//
// Ports: 9101 hianime, 9102 embed host, 9103 stream CDN, 9104 GitHub + aniskip mocks.

import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { randomBytes, createCipheriv } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const KEY = [111, 116, 97, 107, 117, 45, 101, 109, 98, 101, 100, 45, 118, 49]; // "otaku-embed-v1"

export const CATALOG = [
  { slug: "attack-on-sofa-101", title: "Attack on Sofa", jname: "Shingeki no Sofa", type: "TV", eps: 12, dub: 12, mal: 101, hue: 12 },
  { slug: "fullmetal-napper-202", title: "Fullmetal Napper", jname: "Hagane no Napper", type: "TV", eps: 24, dub: 0, mal: 202, hue: 40 },
  { slug: "spy-x-kitty-303", title: "Spy x Kitty", jname: "Spy x Neko", type: "TV", eps: 8, dub: 4, mal: 303, hue: 200 },
  { slug: "death-nap-404", title: "Death Nap", jname: "Desu Nappu", type: "TV", eps: 6, dub: 0, mal: 404, hue: 280 },
  { slug: "my-nap-academia-505", title: "My Nap Academia", jname: "Boku no Nap Academia", type: "TV", eps: 10, dub: 10, mal: 505, hue: 150 },
  { slug: "pierres-bizarre-adventure-606", title: "Pierre's Bizarre Adventure & Friends", jname: "Pierre no Kimyou na Bouken", type: "OVA", eps: 3, dub: 0, mal: 606, hue: 330 },
  { slug: "demon-napper-707", title: "Demon Napper", jname: "Kimetsu no Napper", type: "TV", eps: 26, dub: 26, mal: 707, hue: 0 },
  { slug: "the-lazy-cat-movie-808", title: "The Lazy Cat Movie", jname: "Namakemono Neko", type: "Movie", eps: 1, dub: 1, mal: 808, hue: 60 },
];

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#039;").replace(/</g, "&lt;");
const numId = (slug) => slug.slice(slug.lastIndexOf("-") + 1);

export function obfuscate(json) {
  const bytes = Buffer.from(json, "utf8");
  for (let i = 0; i < bytes.length; i++) bytes[i] ^= KEY[i % KEY.length];
  return bytes.toString("base64");
}

function card(a, host) {
  return `
  <div class="flw-item">
    <div class="film-poster">
      <div class="tick ltr">
        <div class="tick-item tick-sub"><i class="fas fa-closed-captioning mr-1"></i>${a.eps}</div>
        ${a.dub ? `<div class="tick-item tick-dub"><i class="fas fa-microphone mr-1"></i>${a.dub}</div>` : ""}
        <div class="tick-item tick-eps">${a.eps}</div>
      </div>
      <img data-src="${host.cdn}/posters/${a.slug}.svg" class="film-poster-img lazyload" alt="${esc(a.title)}">
      <a href="/watch/${a.slug}" class="film-poster-ahref item-qtip" title="${esc(a.title)}" data-id="${numId(a.slug)}"><i class="fas fa-play"></i></a>
    </div>
    <div class="film-detail">
      <h3 class="film-name">
        <a href="/${a.slug}" title="${esc(a.title)}" class="dynamic-name" data-jname="${esc(a.jname)}">${esc(a.title)}</a>
      </h3>
      <div class="fd-infor"><span class="fdi-item">${a.type}</span><span class="dot"></span><span class="fdi-item fdi-duration">${a.type === "Movie" ? "1h 40m" : "24m"}</span></div>
    </div>
    <div class="clearfix"></div>
  </div>`;
}

function searchPage(q, host) {
  const hits = CATALOG.filter((a) => (a.title + " " + a.jname).toLowerCase().includes(q.toLowerCase()));
  return `<!DOCTYPE html><html><head><title>Search results for ${esc(q)} - HiAnime</title></head><body>
<div id="header"><a href="/home"><img src="${host.hianime}/images/logo.png" alt="HiAnime"></a></div>
<section class="block_area block_area_category"><div class="film_list-wrap">${hits.map((a) => card(a, host)).join("")}
</div></section>
<div id="main-sidebar"><section class="block_area block_area_sidebar"><h2 class="cat-heading">Top 10</h2>
<ul><li><div class="film-detail"><h3 class="film-name"><a href="/sidebar-only-999" title="Sidebar Only">Sidebar Only</a></h3></div></li></ul>
${card(CATALOG[0], host)}
</section></div></body></html>`;
}

function infoPage(a, host) {
  return `<!DOCTYPE html><html><head><title>Watch ${esc(a.title)} English Sub/Dub online Free on HiAnime</title>
<meta property="og:title" content="${esc(a.title)}">
<meta property="og:image" content="${host.cdn}/posters/${a.slug}.svg">
<meta name="description" content="${esc(a.title)} is a made-up show about a cat who naps. Episode ${a.eps} is mostly napping.">
</head><body><h2 class="film-name dynamic-name">${esc(a.title)}</h2></body></html>`;
}

function episodeList(a) {
  const items = [];
  for (let n = 1; n <= a.eps; n++) {
    const id = `${numId(a.slug)}${String(n).padStart(3, "0")}`;
    const filler = n % 7 === 0 ? " ssl-item-filler" : "";
    items.push(
      `<a title="${esc(`Episode ${n}: The Nap ${n === 1 ? "Begins" : "Continues"}`)}" class="ssl-item ep-item${filler}" data-number="${n}" data-id="${id}" href="/watch/${a.slug}?ep=${id}"><div class="ssli-order" title="">${n}</div><div class="ssli-detail"><div class="ep-name e-dynamic-name" title="The Nap">The Nap</div></div><div class="ssli-btn"><div class="btn btn-circle"><i class="fas fa-play"></i></div></div><div class="clearfix"></div></a>`,
    );
  }
  // something from another show in the same response, which must be ignored
  items.push(`<a title="Elsewhere" class="ssl-item ep-item" data-number="99" data-id="999999" href="/watch/some-other-show-1?ep=999999"></a>`);
  return JSON.stringify({ status: true, html: `<div class="ss-list">${items.join("\n")}</div>`, totalItems: a.eps });
}

function serverList(a, n, host) {
  const items = [];
  const embed = (type) => `${host.embed}/embed/mal/${a.mal}/${n}/${type}?k=${randomBytes(4).toString("hex")}`;
  const hash = (u) => Buffer.from(u).toString("base64");
  for (const type of n <= a.dub ? ["sub", "dub"] : ["sub"]) {
    items.push(`<div class="item server-item" data-type="${type}" data-id="${numId(a.slug)}${n}" data-server-id="4" data-server-name="MegaPlay" data-hash="${hash("https://example.invalid/other")}"><a href="javascript:;" class="btn">MegaPlay</a></div>`);
    items.push(`<div class="item server-item" data-type="${type}" data-id="${numId(a.slug)}${n}" data-server-id="9" data-server-name="ZokoAnime" data-hash="${hash(embed(type))}"><a href="javascript:;" class="btn">ZokoAnime</a></div>`);
  }
  return JSON.stringify({ status: true, html: `<div class="player-servers">${items.join("\n")}</div>` });
}

function embedPage(show, n, type, host) {
  const base = `${host.cdn}/hls/${show}/${n}/${type}`;
  const config = {
    v: 1,
    title: `Episode ${n}`,
    sources: [{ src: `${base}/master.m3u8`, type: "hls" }],
    subtitles: [
      { src: `${host.cdn}/subs/${show}/${n}/es.vtt`, label: "Español", srclang: "es", default: false },
      { src: `${host.cdn}/subs/${show}/${n}/en.vtt`, label: "English", srclang: "en", default: true },
    ],
    thumbnails: `${host.cdn}/thumbs/${show}.vtt`,
  };
  return `<!DOCTYPE html><html><head><title>ZokoAnime player</title></head><body><div id="player"></div>
<script>window.__P="${obfuscate(JSON.stringify(config))}";</script><script src="/assets/player.js"></script></body></html>`;
}

function poster(a) {
  const t = esc(a.title);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="420" viewBox="0 0 300 420">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${a.hue},70%,62%)"/><stop offset="1" stop-color="hsl(${(a.hue + 60) % 360},65%,32%)"/></linearGradient></defs>
<rect width="300" height="420" fill="url(#g)"/>
<circle cx="230" cy="90" r="46" fill="rgba(255,255,255,.18)"/><circle cx="70" cy="330" r="80" fill="rgba(0,0,0,.12)"/>
<text x="24" y="360" font-family="Helvetica,Arial,sans-serif" font-size="30" font-weight="700" fill="#fff">${t.length > 18 ? t.slice(0, 17) + "…" : t}</text>
<text x="24" y="392" font-family="Helvetica,Arial,sans-serif" font-size="16" fill="rgba(255,255,255,.8)">${a.type} · ${a.eps} ep</text></svg>`;
}

/**
 * Make a 12 second HLS stream with ffmpeg: 720p AES-128 encrypted, 360p clear.
 * codec "h264" (TS segments, what real hosts serve) or "vp9" (fMP4 + Opus, for test browsers
 * like Playwright's Chromium that ship without H.264).
 */
export function ensureMedia(codec = "h264", dir = join(tmpdir(), `mpa-fake-media-${codec}`)) {
  const marker = join(dir, "ready");
  if (existsSync(marker)) return dir;
  for (const q of ["720", "360"]) mkdirSync(join(dir, q), { recursive: true });
  writeFileSync(join(dir, "720", "key.bin"), randomBytes(16));
  writeFileSync(join(dir, "720", "keyinfo.txt"), `key.bin\n${join(dir, "720", "key.bin")}\n`);
  const common = ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i"];
  const hls = ["-f", "hls", "-hls_time", "2", "-hls_playlist_type", "vod"];
  const enc =
    codec === "vp9"
      ? ["-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8", "-b:v", "700k", "-g", "48", "-keyint_min", "48", "-pix_fmt", "yuv420p", "-c:a", "libopus", "-b:a", "64k", ...hls, "-hls_segment_type", "fmp4", "-hls_fmp4_init_filename", "init.mp4"]
      : ["-c:v", "libx264", "-preset", "veryfast", "-g", "48", "-keyint_min", "48", "-sc_threshold", "0", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "64k", ...hls];
  const ext = codec === "vp9" ? "m4s" : "ts";
  // ffmpeg can't encrypt fMP4 HLS, so for vp9 the 720p segments get encrypted below instead
  const keyFlags = codec === "vp9" ? [] : ["-hls_key_info_file", join(dir, "720", "keyinfo.txt")];
  for (const [q, size, extra] of [
    ["720", "1280x720", keyFlags],
    ["360", "640x360", []],
  ]) {
    execFileSync("ffmpeg", [
      ...common, `testsrc2=size=${size}:rate=24`, "-f", "lavfi", "-i", "sine=frequency=330:sample_rate=48000",
      "-t", "12", ...enc, ...extra, "-hls_segment_filename", join(dir, q, `seg%03d.${ext}`), join(dir, q, "index.m3u8"),
    ]);
  }
  if (codec === "vp9") {
    const key = readFileSync(join(dir, "720", "key.bin"));
    const iv = Buffer.alloc(16);
    for (const f of readdirSync(join(dir, "720")).filter((x) => x.endsWith(".m4s"))) {
      const path = join(dir, "720", f);
      const c = createCipheriv("aes-128-cbc", key, iv);
      writeFileSync(path, Buffer.concat([c.update(readFileSync(path)), c.final()]));
    }
    const list = join(dir, "720", "index.m3u8");
    const text = readFileSync(list, "utf8").replace(/(#EXT-X-MAP:[^\n]*\n)/, `$1#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x${iv.toString("hex")}\n`);
    writeFileSync(list, text);
  }
  writeFileSync(marker, "ok");
  return dir;
}

const VTT = (lang) =>
  lang === "es"
    ? "WEBVTT\n\n00:00:00.500 --> 00:00:04.000\nBonjour. Soy Monsieur Pierre.\n\n00:00:04.500 --> 00:00:09.000\nEsta es una prueba.\n"
    : "WEBVTT\n\n00:00:00.500 --> 00:00:04.000\nBonjour. I'm Monsieur Pierre.\n\n00:00:04.500 --> 00:00:09.000\nThis is a test stream. Nobody is napping. Yet.\n";

function send(res, status, body, type = "text/html; charset=utf-8", extra = {}) {
  res.writeHead(status, { "Content-Type": type, ...extra });
  res.end(body);
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server.address().port));
  });
}

/**
 * startFake({ ports, blocked }) -> { host, stop, issues, requests, setBlocked }
 * ports: [hianime, embed, cdn, mocks]; pass 0s to pick free ports.
 */
export async function startFake({ ports = [9101, 9102, 9103, 9104], blocked = false, media = true, codec = process.env.FAKE_CODEC || "h264" } = {}) {
  const state = { blocked, issues: [], requests: [] };
  const mediaDir = media ? ensureMedia(codec) : null;
  const host = {};

  const hianime = createServer((req, res) => {
    const url = new URL(req.url, host.hianime);
    state.requests.push({ server: "hianime", path: url.pathname + url.search, headers: req.headers });
    if (state.blocked || url.searchParams.get("keyword") === "blocked") {
      return send(res, 503, "<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><div id=\"cf-chl\">Checking your browser</div><script src=\"/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1\"></script></body></html>");
    }
    if (url.pathname === "/search") return send(res, 200, searchPage(url.searchParams.get("keyword") || "", host));
    let m = url.pathname.match(/^\/api\/theme\/episode\/list\/(\d+)$/);
    if (m) {
      const a = CATALOG.find((x) => numId(x.slug) === m[1]);
      return a ? send(res, 200, episodeList(a), "application/json") : send(res, 200, JSON.stringify({ status: false, html: "" }), "application/json");
    }
    if (url.pathname === "/api/theme/episode/servers") {
      const id = url.searchParams.get("episodeId") || "";
      const a = CATALOG.find((x) => id.startsWith(numId(x.slug)) && id.length === numId(x.slug).length + 3);
      if (!a) return send(res, 200, JSON.stringify({ status: false, html: "" }), "application/json");
      return send(res, 200, serverList(a, Number(id.slice(-3)), host), "application/json");
    }
    m = url.pathname.match(/^\/([a-z0-9-]+)$/);
    const a = m && CATALOG.find((x) => x.slug === m[1]);
    if (a) return send(res, 200, infoPage(a, host));
    return send(res, 404, "<h1>404</h1>");
  });

  const embed = createServer((req, res) => {
    const url = new URL(req.url, host.embed);
    state.requests.push({ server: "embed", path: url.pathname, headers: req.headers });
    const m = url.pathname.match(/^\/embed\/mal\/(\d+)\/(\d+)\/(sub|dub)$/);
    if (!m) return send(res, 404, "nope");
    const a = CATALOG.find((x) => String(x.mal) === m[1]);
    return send(res, 200, embedPage(a ? a.slug : "unknown", m[2], m[3], host));
  });

  const cdn = createServer((req, res) => {
    const url = new URL(req.url, host.cdn);
    state.requests.push({ server: "cdn", path: url.pathname, headers: req.headers });
    if (url.pathname.startsWith("/posters/")) {
      const a = CATALOG.find((x) => url.pathname === `/posters/${x.slug}.svg`);
      return a ? send(res, 200, poster(a), "image/svg+xml") : send(res, 404, "");
    }
    // the stream host only talks to people who came from the embed page
    if (req.headers.referer !== `${host.embed}/`) return send(res, 403, "Forbidden: wrong referer", "text/plain");
    let m = url.pathname.match(/^\/subs\/[^/]+\/\d+\/(en|es)\.vtt$/);
    if (m) return send(res, 200, VTT(m[1]), "text/vtt");
    m = url.pathname.match(/^\/hls\/[^/]+\/\d+\/(sub|dub)\/(.+)$/);
    if (!m || !mediaDir) return send(res, 404, "", "text/plain");
    const file = m[2];
    if (file === "master.m3u8") {
      const codecs = codec === "vp9" ? ["vp09.00.31.08,opus", "vp09.00.30.08,opus"] : ["avc1.640020,mp4a.40.2", "avc1.64001e,mp4a.40.2"];
      return send(res, 200, `#EXTM3U\n#EXT-X-VERSION:${codec === "vp9" ? 7 : 3}\n#EXT-X-STREAM-INF:BANDWIDTH=1400000,RESOLUTION=1280x720,CODECS="${codecs[0]}"\n720/index.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=640x360,CODECS="${codecs[1]}"\n360/index.m3u8\n`, "application/vnd.apple.mpegurl");
    }
    if (!/^(720|360)\/(index\.m3u8|seg\d{3}\.(ts|m4s)|init\.mp4|key\.bin)$/.test(file)) return send(res, 404, "", "text/plain");
    const path = join(mediaDir, file);
    if (!existsSync(path)) return send(res, 404, "", "text/plain");
    const type = file.endsWith(".m3u8") ? "application/vnd.apple.mpegurl" : file.endsWith(".ts") ? "video/mp2t" : /\.(m4s|mp4)$/.test(file) ? "video/mp4" : "application/octet-stream";
    const data = readFileSync(path);
    const range = req.headers.range && req.headers.range.match(/bytes=(\d+)-(\d*)/);
    if (range) {
      const start = Number(range[1]);
      const end = range[2] ? Number(range[2]) : data.length - 1;
      return send(res, 206, data.subarray(start, end + 1), type, { "Content-Range": `bytes ${start}-${end}/${data.length}`, "Accept-Ranges": "bytes" });
    }
    return send(res, 200, data, type, { "Accept-Ranges": "bytes" });
  });

  const mocks = createServer((req, res) => {
    const url = new URL(req.url, host.mocks);
    state.requests.push({ server: "mocks", path: url.pathname, headers: req.headers });
    if (req.method === "POST" && /^\/repos\/[^/]+\/[^/]+\/issues$/.test(url.pathname)) {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        if (req.headers.authorization !== "Bearer test-github-token") return send(res, 401, JSON.stringify({ message: "Bad credentials" }), "application/json");
        const issue = JSON.parse(body);
        const number = state.issues.length + 1;
        state.issues.push({ ...issue, number, path: url.pathname });
        send(res, 201, JSON.stringify({ number, html_url: `https://github.com${url.pathname.replace("/repos", "")}/${number}` }), "application/json");
      });
      return;
    }
    const m = url.pathname.match(/^\/v2\/skip-times\/(\d+)\/(\d+)$/);
    if (m) {
      if (Number(m[2]) % 2 === 0) return send(res, 200, JSON.stringify({ found: false, results: [], message: "No skip times found", statusCode: 404 }), "application/json");
      return send(res, 200, JSON.stringify({ found: true, results: [{ interval: { startTime: 1.5, endTime: 5 }, skipType: "op", skipId: "x", episodeLength: 12 }], message: "Successfully found skip times", statusCode: 200 }), "application/json");
    }
    return send(res, 404, "{}", "application/json");
  });

  const servers = [hianime, embed, cdn, mocks];
  const bound = [];
  for (let i = 0; i < servers.length; i++) bound.push(await listen(servers[i], ports[i]));
  host.hianime = `http://127.0.0.1:${bound[0]}`;
  host.embed = `http://127.0.0.1:${bound[1]}`;
  host.cdn = `http://127.0.0.1:${bound[2]}`;
  host.mocks = `http://127.0.0.1:${bound[3]}`;

  return {
    host,
    issues: state.issues,
    requests: state.requests,
    mediaDir,
    setBlocked: (v) => (state.blocked = v),
    stop: () => Promise.all(servers.map((s) => new Promise((r) => s.close(r)))),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const fake = await startFake();
  console.log("fake hianime  ", fake.host.hianime);
  console.log("embed host    ", fake.host.embed);
  console.log("stream cdn    ", fake.host.cdn);
  console.log("github/aniskip", fake.host.mocks);
}
