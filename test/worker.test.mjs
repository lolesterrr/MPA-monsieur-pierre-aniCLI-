// node --test test/
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as W from "../worker/core.js";
import { startFake, obfuscate } from "./fake-hianime.mjs";

let fake;
let env;
let handle;
let ipCounter = 0;

test.before(async () => {
  fake = await startFake({ ports: [0, 0, 0, 0] });
  env = {
    BASE_URL: fake.host.hianime,
    SIGNING_KEY: "test-signing-key",
    GITHUB_API: fake.host.mocks,
    ANISKIP_URL: fake.host.mocks,
    GITHUB_REPO: "lolesterrr/MPA-monsieur-pierre-aniCLI-",
  };
  handle = W.createHandler();
});

test.after(() => fake.stop());

const ORIGIN = "https://mpa.worker.test";
function call(path, init = {}, e = env) {
  const headers = new Headers(init.headers || {});
  if (!headers.has("CF-Connecting-IP")) headers.set("CF-Connecting-IP", `10.0.0.${++ipCounter % 250}`);
  const url = path.startsWith("http") ? path : ORIGIN + path;
  return handle(new Request(url, { ...init, headers }), e);
}
async function getJson(path, init, e) {
  const res = await call(path, init, e);
  return { status: res.status, body: await res.json(), res };
}
const target = (relay) => new URL(relay).searchParams.get("u");

// ---------- parsing ----------

test("entities decode like ani-cli and then some", () => {
  assert.equal(W.decodeEntities("Pierre&#039;s &amp; Friends &quot;OVA&quot; &#x2764; &lt;3"), "Pierre's & Friends \"OVA\" ❤ <3");
  assert.equal(W.numericId("attack-on-sofa-101"), "101");
  assert.equal(W.numericId("no-number-here"), "");
});

test("search skips the top-10 sidebar and reads posters, counts and type", async () => {
  const html = await (await fetch(`${fake.host.hianime}/search?keyword=pierre`)).text();
  const results = W.parseSearch(html);
  assert.equal(results.length, 1);
  assert.deepEqual(results[0], {
    id: "pierres-bizarre-adventure-606",
    title: "Pierre's Bizarre Adventure & Friends",
    poster: `${fake.host.cdn}/posters/pierres-bizarre-adventure-606.svg`,
    sub: 3,
    eps: 3,
    jname: "Pierre no Kimyou na Bouken",
    type: "OVA",
    duration: "24m",
  });
  const all = W.parseSearch(await (await fetch(`${fake.host.hianime}/search?keyword=a`)).text());
  assert.ok(!all.some((r) => r.id === "sidebar-only-999"), "sidebar entries leak in");
  assert.equal(new Set(all.map((r) => r.id)).size, all.length, "duplicates");
});

test("episodes: escaped json, other shows filtered, numeric order, titles, fillers", () => {
  const html = '<a title="Ep 2" class="ssl-item ep-item" data-number="2" data-id="5002" href="/watch/x-5?ep=5002"></a>' +
    '<a class="ssl-item ep-item ssl-item-filler" data-number="1" data-id="5001" href="/watch/x-5?ep=5001" title="Ep 1"></a>' +
    '<a class="ssl-item ep-item" data-number="3" data-id="9999" href="/watch/other-9?ep=9999"></a>';
  const eps = W.parseEpisodes(JSON.stringify({ status: true, html }), "x-5");
  assert.deepEqual(eps, [
    { n: "1", id: "5001", title: "Ep 1", filler: true },
    { n: "2", id: "5002", title: "Ep 2" },
  ]);
});

test("servers parse in any attribute order", () => {
  const html = JSON.stringify({ html: '<div class="server-item" data-hash="aGk=" data-server-name="ZokoAnime" data-type="dub"></div><div class="item server-item" data-type="sub" data-server-name="Other" data-hash="eA=="></div>' });
  assert.deepEqual(W.parseServers(html), [
    { type: "dub", name: "ZokoAnime", hash: "aGk=", serverId: "" },
    { type: "sub", name: "Other", hash: "eA==", serverId: "" },
  ]);
});

test("embed blob: XOR with otaku-embed-v1 round trips, unicode included", () => {
  const json = JSON.stringify({ sources: [{ src: "https://cdn.example/a/master.m3u8" }], subtitles: [{ src: "https://cdn.example/fr.vtt", label: "Français", default: true }] });
  const page = `<script>window.__P="${obfuscate(json)}";</script>`;
  const decoded = W.extractPlayerConfig(page);
  assert.equal(decoded, json);
  const cfg = W.parsePlayerConfig(decoded);
  assert.deepEqual(cfg.sources, ["https://cdn.example/a/master.m3u8"]);
  assert.equal(cfg.subtitles[0].label, "Français");
  assert.equal(cfg.subtitles[0].default, true);
});

test("player config that isn't strict JSON falls back to ani-cli's regexes", () => {
  const cfg = W.parsePlayerConfig('{sources:[{"src":"https:\\/\\/a.example\\/1.m3u8"},{"src":"https://b.example/2.m3u8"}],"subtitles":[{"src":"https://a.example/en.vtt","label":"English","default":true}]');
  assert.deepEqual(cfg.sources, ["https://b.example/2.m3u8", "https://a.example/1.m3u8"], "ani-cli's pick (the last) comes first");
  assert.equal(cfg.subtitles[0].url, "https://a.example/en.vtt");
});

test("cloudflare challenge pages are recognised", () => {
  assert.ok(W.isChallenge(503, "<html><head><title>Just a moment...</title>"));
  assert.ok(W.isChallenge(403, '<div id="cf-chl-widget">'));
  assert.ok(!W.isChallenge(200, "<title>Search results</title>"));
});

test("relay tokens: signed, expiring, tamper-proof", async () => {
  const t = await W.makeToken("k", { referer: "https://embed.example/", hosts: ["cdn.example", "cdn.example"] });
  assert.deepEqual((await W.readToken("k", t)).hosts, ["cdn.example"]);
  assert.equal((await W.readToken("k", t)).referer, "https://embed.example/");
  assert.equal(await W.readToken("other-key", t), null);
  const parts = t.split(".");
  parts[2] = Buffer.from("evil.example").toString("base64url");
  assert.equal(await W.readToken("k", parts.join(".")), null);
  const old = await W.makeToken("k", { hosts: ["a"], ttl: 10, now: Date.now() - 60e3 });
  assert.equal(await W.readToken("k", old), null);
});

test("playlist rewriting covers plain URIs and URI attributes", () => {
  const text = '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x1\n#EXTINF:2,\nseg0.ts\n#EXT-X-MAP:URI="/init.mp4"\nhttps://other.example/seg1.ts\n';
  const base = "https://cdn.example/v/720/index.m3u8";
  assert.deepEqual(W.playlistTargets(text, base), [
    "https://cdn.example/v/720/key.bin",
    "https://cdn.example/v/720/seg0.ts",
    "https://cdn.example/init.mp4",
    "https://other.example/seg1.ts",
  ]);
  const out = W.rewritePlaylist(text, base, (u) => `R(${u})`);
  assert.match(out, /URI="R\(https:\/\/cdn\.example\/v\/720\/key\.bin\)",IV=0x1/);
  assert.match(out, /\nR\(https:\/\/cdn\.example\/v\/720\/seg0\.ts\)\n/);
  assert.match(out, /\nR\(https:\/\/other\.example\/seg1\.ts\)\n/);
});

// ---------- the API against the fake site ----------

test("GET /api/search", async () => {
  const { status, body } = await getJson("/api/search?q=nap");
  assert.equal(status, 200);
  assert.deepEqual(body.results.map((r) => r.id), ["fullmetal-napper-202", "death-nap-404", "my-nap-academia-505", "demon-napper-707"]);
  const hit = fake.requests.find((r) => r.server === "hianime" && r.path === "/search?keyword=nap");
  assert.ok(hit, "worker never asked for /search?keyword=nap");
  assert.equal(hit.headers["user-agent"], W.UA);
  const empty = await getJson("/api/search?q=zzzzzz");
  assert.deepEqual(empty.body.results, []);
  assert.equal((await getJson("/api/search?q=")).status, 400);
});

test("GET /api/episodes", async () => {
  const { status, body } = await getJson("/api/episodes?id=attack-on-sofa-101");
  assert.equal(status, 200);
  assert.equal(body.episodes.length, 12);
  assert.deepEqual(body.episodes[0], { n: "1", id: "101001", title: "Episode 1: The Nap Begins" });
  assert.equal(body.episodes[6].filler, true);
  assert.ok(!body.episodes.some((e) => e.id === "999999"));
  assert.equal((await getJson("/api/episodes?id=../../etc")).status, 400);
});

test("GET /api/info reads the og tags", async () => {
  const { body } = await getJson("/api/info?id=death-nap-404");
  assert.equal(body.title, "Death Nap");
  assert.equal(body.poster, `${fake.host.cdn}/posters/death-nap-404.svg`);
  assert.match(body.description, /made-up show/);
});

test("GET /api/sources then play the whole thing through the relay", async () => {
  const { status, body } = await getJson("/api/sources?id=attack-on-sofa-101&epId=101003&mode=sub");
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.malId, 101);
  assert.deepEqual(body.available, ["sub", "dub"]);
  assert.equal(target(body.master), `${fake.host.cdn}/hls/attack-on-sofa-101/3/sub/master.m3u8`);
  assert.equal(body.subtitles.length, 2);
  const en = body.subtitles.find((s) => s.default);
  assert.equal(en.label, "English");

  // the stream host refuses anyone without the embed referer
  assert.equal((await fetch(target(body.master))).status, 403);

  // master -> variants, all pointing back at the relay
  const master = await call(body.master);
  assert.equal(master.status, 200);
  assert.equal(master.headers.get("Content-Type"), "application/vnd.apple.mpegurl");
  const masterText = await master.text();
  const variants = masterText.split("\n").filter((l) => l.startsWith(ORIGIN + "/p?"));
  assert.deepEqual(variants.map(target), [
    `${fake.host.cdn}/hls/attack-on-sofa-101/3/sub/720/index.m3u8`,
    `${fake.host.cdn}/hls/attack-on-sofa-101/3/sub/360/index.m3u8`,
  ]);

  // encrypted 720p: the key and the segments both come through
  const media = await (await call(variants[0])).text();
  const keyLine = media.split("\n").find((l) => l.startsWith("#EXT-X-KEY"));
  const keyRelay = keyLine.match(/URI="([^"]*)"/)[1];
  assert.equal(target(keyRelay), `${fake.host.cdn}/hls/attack-on-sofa-101/3/sub/720/key.bin`);
  const key = new Uint8Array(await (await call(keyRelay)).arrayBuffer());
  assert.deepEqual(Buffer.from(key), readFileSync(join(fake.mediaDir, "720", "key.bin")));
  const segs = media.split("\n").filter((l) => l.startsWith(ORIGIN + "/p?"));
  assert.equal(segs.length, 6);
  const seg = await call(segs[1]);
  assert.equal(seg.status, 200);
  assert.equal(seg.headers.get("Content-Type"), "video/mp2t");
  assert.deepEqual(Buffer.from(await seg.arrayBuffer()), readFileSync(join(fake.mediaDir, "720", "seg001.ts")));

  // ranges pass through
  const part = await call(segs[0], { headers: { Range: "bytes=0-187" } });
  assert.equal(part.status, 206);
  assert.equal((await part.arrayBuffer()).byteLength, 188);
  assert.match(part.headers.get("Content-Range"), /^bytes 0-187\//);

  // subtitles
  const vtt = await call(en.url);
  assert.equal(vtt.status, 200);
  assert.match(await vtt.text(), /^WEBVTT[\s\S]*Monsieur Pierre/);

  // every hit on the stream host carried the embed's referer
  for (const r of fake.requests.filter((x) => x.server === "cdn" && x.path.startsWith("/hls"))) {
    if (r.headers.referer) assert.equal(r.headers.referer, `${fake.host.embed}/`);
  }
});

test("relay refuses forged, expired and off-list links", async () => {
  const { body } = await getJson("/api/sources?id=death-nap-404&epId=404001&mode=sub");
  const u = new URL(body.master);
  const forged = new URL(u);
  forged.searchParams.set("t", u.searchParams.get("t").slice(0, -3) + "AAA");
  assert.equal((await call(forged.href)).status, 403);
  const offList = new URL(u);
  offList.searchParams.set("u", "https://example.com/secret");
  const r = await getJson(offList.href);
  assert.equal(r.status, 403);
  assert.equal(r.body.error, "not_allowed");
  const expired = await W.makeToken(env.SIGNING_KEY, { hosts: [new URL(fake.host.cdn).host], ttl: 1, now: Date.now() - 10e3 });
  assert.equal((await call(W.relayUrl(ORIGIN, expired, target(body.master)))).status, 403);
});

test("dub that doesn't exist says what does", async () => {
  const { status, body } = await getJson("/api/sources?id=fullmetal-napper-202&epId=202001&mode=dub");
  assert.equal(status, 404);
  assert.equal(body.error, "no_source");
  assert.deepEqual(body.available, ["sub"]);
});

test("episode can be found by number when the id isn't known", async () => {
  const { status, body } = await getJson("/api/sources?id=spy-x-kitty-303&ep=2&mode=dub");
  assert.equal(status, 200);
  assert.equal(body.epId, "303002");
  assert.equal(target(body.master), `${fake.host.cdn}/hls/spy-x-kitty-303/2/dub/master.m3u8`);
  assert.equal((await getJson("/api/sources?id=spy-x-kitty-303&ep=99&mode=sub")).status, 404);
});

test("no SIGNING_KEY means a clear setup error", async () => {
  const { status, body } = await getJson("/api/sources?id=death-nap-404&epId=404001&mode=sub", {}, { ...env, SIGNING_KEY: "" });
  assert.equal(status, 501);
  assert.equal(body.error, "setup");
  const health = await getJson("/api/health", {}, { ...env, SIGNING_KEY: "" });
  assert.equal(health.body.signing, false);
});

test("cloudflare wall shows up as 'blocked'", async () => {
  fake.setBlocked(true);
  try {
    const { status, body } = await getJson("/api/search?q=sofa");
    assert.equal(status, 503);
    assert.equal(body.error, "blocked");
    const health = await getJson("/api/health?deep=1");
    assert.equal(health.body.upstream, "blocked");
  } finally {
    fake.setBlocked(false);
  }
  assert.equal((await getJson("/api/health?deep=1")).body.upstream, "ok");
});

test("skip times come from aniskip", async () => {
  const yes = await getJson("/api/skip?mal=101&ep=1&len=12");
  assert.deepEqual(yes.body, { found: true, op: { start: 1.5, end: 5 } });
  const no = await getJson("/api/skip?mal=101&ep=2&len=12");
  assert.deepEqual(no.body, { found: false });
  assert.deepEqual((await getJson("/api/skip?mal=abc&ep=1")).body, { found: false });
});

// ---------- complaints ----------

const complaintBody = (extra = {}) =>
  JSON.stringify({
    kind: "video",
    message: "Episode 3 keeps spinning forever.\n@someone please fix | thanks",
    elapsed: 9000,
    contact: "",
    context: { page: "#/watch/attack-on-sofa-101/3", title: "Attack on Sofa", id: "attack-on-sofa-101", ep: "3", mode: "sub", error: "manifestLoadError", ua: "Test/1.0", app: "MPA web 1.0.0" },
    ...extra,
  });

test("complaint without a GitHub token hands back a prefilled issue link", async () => {
  const { status, body } = await getJson("/api/complaint", { method: "POST", body: complaintBody() });
  assert.equal(status, 501);
  assert.equal(body.error, "not_configured");
  const link = new URL(body.fallback);
  assert.equal(link.origin + link.pathname, "https://github.com/lolesterrr/MPA-monsieur-pierre-aniCLI-/issues/new");
  assert.match(link.searchParams.get("title"), /^\[Video won't play\] Episode 3 keeps spinning forever\./);
  assert.equal(link.searchParams.get("labels"), "complaint,video");
});

test("complaint with a token files a GitHub issue", async () => {
  const e = { ...env, GITHUB_TOKEN: "test-github-token" };
  const { status, body } = await getJson("/api/complaint", { method: "POST", body: complaintBody() }, e);
  assert.equal(status, 201, JSON.stringify(body));
  assert.equal(body.ok, true);
  const issue = fake.issues.at(-1);
  assert.equal(issue.path, "/repos/lolesterrr/MPA-monsieur-pierre-aniCLI-/issues");
  assert.deepEqual(issue.labels, ["complaint", "video"]);
  assert.match(issue.body, /^> Episode 3 keeps spinning forever\.\n> @​someone please fix \| thanks/);
  assert.match(issue.body, /\| Anime \| Attack on Sofa \(`attack-on-sofa-101`\) \|/);
  assert.match(issue.body, /\| Episode \| 3 \(sub\) \|/);
  // same complaint again is a duplicate
  const again = await getJson("/api/complaint", { method: "POST", body: complaintBody(), headers: { "CF-Connecting-IP": "10.9.9.9" } }, e);
  const again2 = await getJson("/api/complaint", { method: "POST", body: complaintBody(), headers: { "CF-Connecting-IP": "10.9.9.9" } }, e);
  assert.equal(again.status, 201);
  assert.equal(again2.status, 409);
});

test("complaint spam guards", async () => {
  const e = { ...env, GITHUB_TOKEN: "test-github-token" };
  const before = fake.issues.length;
  const bot = await getJson("/api/complaint", { method: "POST", body: complaintBody({ website: "http://spam" }) }, e);
  assert.equal(bot.status, 200);
  assert.equal(fake.issues.length, before, "honeypot still filed an issue");
  assert.equal((await getJson("/api/complaint", { method: "POST", body: complaintBody({ elapsed: 300 }) }, e)).status, 400);
  assert.equal((await getJson("/api/complaint", { method: "POST", body: complaintBody({ message: "  " }) }, e)).status, 400);
  const ip = { "CF-Connecting-IP": "10.7.7.7" };
  const codes = [];
  for (let i = 0; i < 6; i++) {
    codes.push((await getJson("/api/complaint", { method: "POST", headers: ip, body: complaintBody({ message: `complaint number ${i}` }) }, e)).status);
  }
  assert.deepEqual(codes, [201, 201, 201, 201, 201, 429]);
});

// ---------- CORS ----------

test("CORS follows ALLOWED_ORIGINS", async () => {
  const e = { ...env, ALLOWED_ORIGINS: "https://lolesterrr.github.io, http://localhost:*" };
  const ask = async (origin) => (await call("/api/health", { headers: { Origin: origin } }, e)).headers.get("Access-Control-Allow-Origin");
  assert.equal(await ask("https://lolesterrr.github.io"), "https://lolesterrr.github.io");
  assert.equal(await ask("http://localhost:5173"), "http://localhost:5173");
  assert.equal(await ask("https://evil.example"), null);
  assert.equal(await ask("http://localhost:5173.evil.example"), null);
  const pre = await call("/api/search?q=x", { method: "OPTIONS", headers: { Origin: "https://lolesterrr.github.io" } }, e);
  assert.equal(pre.status, 204);
  assert.equal((await call("/api/health", { headers: { Origin: "https://anything.example" } })).headers.get("Access-Control-Allow-Origin"), "*");
});
