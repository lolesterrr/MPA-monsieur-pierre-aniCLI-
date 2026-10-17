#!/usr/bin/env node
// MPA local helper: the same worker code, running on your own computer, plus the web app.
//
// Use it when Cloudflare won't let the worker into hianime, or to work on MPA offline.
//
//   node local/server.mjs                # then open http://localhost:8787
//   HOST=0.0.0.0 node local/server.mjs   # also reachable from your phone on the same Wi-Fi
//
// Like ani-cli, it fetches hianime pages with curl-impersonate when it's installed
// (curl_firefox135, curl_chrome136, ...) because plain clients can get the Cloudflare
// "Just a moment" page. Video goes through Node's own fetch.
//
// Environment: PORT (8787), HOST (127.0.0.1), BASE_URL, GITHUB_TOKEN, GITHUB_REPO,
// CURL (path to a curl binary to use for pages), MPA_NO_CURL=1 (never use curl).

import http from "node:http";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { createHandler, UA } from "../worker/core.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const WEB = resolve(here, "..", "web");

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
};

const IMPERSONATORS = ["curl_firefox135", "curl_chrome136", "curl_chrome116", "curl_ff117"];

function which(bin) {
  return new Promise((done) => execFile("sh", ["-c", `command -v ${bin}`], (err, out) => done(err ? null : out.trim() || null)));
}

export async function findCurl(env = process.env) {
  if (env.MPA_NO_CURL) return null;
  if (env.CURL) return env.CURL;
  for (const bin of IMPERSONATORS) {
    const path = await which(bin);
    if (path) return path;
  }
  return null;
}

/** fetch() lookalike for page requests, done by a curl binary. Returns a real Response. */
export function curlFetch(curl, url, init = {}) {
  const headers = new Headers(init.headers || {});
  const args = ["-sL", "--compressed", "--max-time", "12", "-A", headers.get("User-Agent") || UA];
  for (const [k, v] of headers) {
    if (k === "user-agent") continue;
    if (k === "referer") args.push("-e", v);
    else args.push("-H", `${k}: ${v}`);
  }
  args.push("-w", "\n%{http_code} %{url_effective}", url);
  return new Promise((resolveFetch, reject) => {
    execFile(curl, args, { maxBuffer: 32 * 1024 * 1024, encoding: "buffer" }, (err, stdout) => {
      if (err && !stdout?.length) return reject(new Error(`curl failed: ${err.message}`));
      const text = stdout.toString("utf8");
      const cut = text.lastIndexOf("\n");
      const [code, effective] = text.slice(cut + 1).split(" ");
      const res = new Response(text.slice(0, cut), { status: Number(code) || 502 });
      Object.defineProperty(res, "url", { value: effective || url });
      resolveFetch(res);
    });
  });
}

function toRequest(req, origin) {
  const url = new URL(req.url, origin);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined || k.startsWith(":")) continue;
    headers.set(k, Array.isArray(v) ? v.join(", ") : v);
  }
  if (!headers.has("cf-connecting-ip")) headers.set("CF-Connecting-IP", req.socket.remoteAddress || "local");
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  return new Request(url, { method: req.method, headers, body: hasBody ? Readable.toWeb(req) : undefined, duplex: hasBody ? "half" : undefined });
}

async function sendResponse(res, response) {
  const headers = {};
  response.headers.forEach((v, k) => (headers[k] = v));
  res.writeHead(response.status, headers);
  if (!response.body) return res.end();
  const stream = Readable.fromWeb(response.body);
  res.on("close", () => stream.destroy());
  stream.on("error", () => res.destroy());
  stream.pipe(res);
}

async function serveStatic(req, res, local) {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/config.js") {
    // point the app at this helper instead of the worker in web/config.js
    res.writeHead(200, { "Content-Type": TYPES[".js"], "Cache-Control": "no-store" });
    return res.end(`window.MPA_CONFIG = Object.assign({}, window.MPA_CONFIG, ${JSON.stringify(local)}, { api: location.origin });\n`);
  }
  let path = decodeURIComponent(url.pathname);
  if (path.endsWith("/")) path += "index.html";
  const file = normalize(join(WEB, path));
  if (!file.startsWith(WEB + sep) && file !== WEB) {
    res.writeHead(403);
    return res.end();
  }
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error("not a file");
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" });
    return res.end(req.method === "HEAD" ? undefined : body);
  } catch {
    res.writeHead(404, { "Content-Type": TYPES[".txt"] });
    return res.end("Not found");
  }
}

/**
 * startLocal({ port, host, env, curl }) -> { url, server, close }
 * env is the worker's env (BASE_URL, SIGNING_KEY, GITHUB_TOKEN, ...).
 */
export async function startLocal({ port = 8787, host = "127.0.0.1", env = {}, curl = null } = {}) {
  const workerEnv = { SIGNING_KEY: randomBytes(24).toString("hex"), ALLOWED_ORIGINS: "*", ...env };
  const handle = createHandler({
    upstream: (url, init, kind) => (kind === "page" && curl ? curlFetch(curl, url, init) : fetch(url, init)),
  });
  const server = http.createServer(async (req, res) => {
    try {
      const path = req.url.split("?")[0];
      if (path === "/p" || path.startsWith("/api/") || path === "/api") {
        const origin = `http://${req.headers.host || `${host}:${port}`}`;
        return await sendResponse(res, await handle(toRequest(req, origin), workerEnv));
      }
      return await serveStatic(req, res, { local: true });
    } catch (e) {
      console.error(e);
      if (!res.headersSent) res.writeHead(500, { "Content-Type": TYPES[".txt"] });
      res.end("Local helper error");
    }
  });
  await new Promise((done, fail) => {
    server.once("error", fail);
    server.listen(port, host, done);
  });
  const actual = server.address().port;
  const shown = host === "0.0.0.0" ? "localhost" : host;
  return { url: `http://${shown}:${actual}`, server, close: () => new Promise((r) => server.close(r)) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const env = {};
  for (const k of ["BASE_URL", "GITHUB_TOKEN", "GITHUB_REPO", "GITHUB_API", "ANISKIP_URL", "TOKEN_TTL", "COMPLAINTS_PER_10_MIN"]) {
    if (process.env[k]) env[k] = process.env[k];
  }
  const curl = await findCurl();
  const app = await startLocal({ port: Number(process.env.PORT) || 8787, host: process.env.HOST || "127.0.0.1", env, curl });
  console.log(`\n  Monsieur Pierre is up: ${app.url}\n`);
  console.log(curl ? `  Fetching pages with ${curl}` : "  No curl-impersonate found, using plain fetch (Cloudflare may say no; see README)");
  try {
    const res = await fetch(`${app.url}/api/health?deep=1`);
    const h = await res.json();
    console.log(`  hianime: ${h.upstream}${h.upstreamMessage ? ` (${h.upstreamMessage})` : ""}`);
    console.log(`  complaints: ${h.complaints ? "filed as GitHub issues" : "open a prefilled GitHub issue (set GITHUB_TOKEN to file them directly)"}\n`);
  } catch (e) {
    console.log(`  couldn't run the self-check: ${e.message}\n`);
  }
}
