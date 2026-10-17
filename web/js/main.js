// MPA: boot and routing. Hash routes so GitHub Pages never needs server rewrites.
//   #/                      home
//   #/search?q=...          results
//   #/anime/<id>?mode=sub   episodes
//   #/watch/<id>/<n>?mode=  player
import { loadPierre, hydrate } from "./pierre.js";
import { wireComplaints } from "./complaint.js";
import { openBackstage } from "./backstage.js";
import { state } from "./state.js";
import * as home from "./views/home.js";
import * as search from "./views/search.js";
import * as anime from "./views/anime.js";
import * as watch from "./views/watch.js";

const ROUTES = [
  { re: /^\/?$/, view: home, name: "home" },
  { re: /^\/search$/, view: search, name: "search" },
  { re: /^\/anime\/([^/]+)$/, view: anime, name: "anime", keys: ["id"] },
  { re: /^\/watch\/([^/]+)\/([^/]+)$/, view: watch, name: "watch", keys: ["id", "n"] },
];

const main = document.getElementById("view");
let current = { controller: null, cleanup: null };
let firstLoad = true;

function parse() {
  const hash = location.hash.replace(/^#/, "") || "/";
  const [path, query = ""] = hash.split("?");
  for (const r of ROUTES) {
    const m = path.match(r.re);
    if (m) {
      const route = {};
      (r.keys || []).forEach((k, i) => (route[k] = decodeURIComponent(m[i + 1])));
      return { r, route, params: new URLSearchParams(query) };
    }
  }
  return { r: ROUTES[0], route: {}, params: new URLSearchParams() };
}

async function navigate() {
  if (current.controller) current.controller.abort();
  if (typeof current.cleanup === "function") {
    try {
      current.cleanup();
    } catch (e) {
      console.error(e);
    }
  }
  const controller = new AbortController();
  current = { controller, cleanup: null };
  const { r, route, params } = parse();
  state.route = location.hash || "#/";
  if (r.name !== "watch" && r.name !== "anime") state.current = null;
  document.body.dataset.view = r.name;
  const q = document.querySelector('.top [name="q"]');
  if (q && r.name === "search") q.value = params.get("q") || "";
  else if (q && r.name === "home") q.value = "";
  document.title = typeof r.view.title === "function" ? r.view.title(params, route) : r.view.title || "MPA";
  if (!firstLoad) window.scrollTo({ top: 0 });
  main.setAttribute("aria-busy", "true");
  let cleanup = null;
  try {
    cleanup = await r.view.render(main, params, { signal: controller.signal }, route);
  } catch (e) {
    console.error(e);
  }
  main.removeAttribute("aria-busy");
  if (controller.signal.aborted) {
    if (typeof cleanup === "function") cleanup();
    return;
  }
  current.cleanup = cleanup;
  if (!firstLoad) {
    const h1 = main.querySelector("h1");
    if (h1) {
      h1.tabIndex = -1;
      h1.focus({ preventScroll: true });
    }
  }
  firstLoad = false;
}

function wireSearch() {
  document.addEventListener("submit", (e) => {
    const form = e.target.closest("[data-search]");
    if (!form) return;
    e.preventDefault();
    const q = String(new FormData(form).get("q") || "").trim();
    if (!q) return form.querySelector('[name="q"]').focus();
    const target = `#/search?q=${encodeURIComponent(q)}`;
    if (location.hash === target) navigate();
    else location.hash = target;
    const input = form.querySelector('[name="q"]');
    if (window.matchMedia("(max-width: 640px)").matches) input.blur();
  });
}

async function boot() {
  await loadPierre();
  hydrate(document.querySelector(".top"));
  hydrate(document.querySelector(".foot"));
  wireComplaints();
  wireSearch();
  document.querySelector("[data-backstage]").addEventListener("click", openBackstage);
  window.addEventListener("hashchange", navigate);
  await navigate();
}

boot();
