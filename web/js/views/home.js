import { esc, minutesLeft } from "../util.js";
import { history, progress, recent, settings } from "../store.js";
import { isConfigured } from "../api.js";
import { hydrate } from "../pierre.js";
import { poster, fixPosters } from "./common.js";

export const title = "MPA";

export function render(main, params, ctx) {
  if (!isConfigured()) return renderSetup(main, ctx);
  const shows = history.all().slice(0, 12);
  const searches = recent.all();
  main.innerHTML = `
  <section class="hero" aria-labelledby="hero-title">
    <div class="hero-pierre">
      <span data-pierre="bonjour" data-scale="6" data-joke></span>
      <p class="bubble bubble-left">Bonjour.\nWhat are we watching?</p>
    </div>
    <div class="hero-main">
      <h1 id="hero-title" class="sr">Search anime</h1>
      <form class="hero-search" role="search" data-search>
        <label class="sr" for="hero-q">Search anime</label>
        <input id="hero-q" type="search" name="q" placeholder="Search anime" autocomplete="off" enterkeyhint="search" required>
        <button class="btn primary" type="submit">Search</button>
      </form>
      ${
        searches.length
          ? `<div class="recent"><span class="recent-label">Recent searches</span>
             ${searches.map((q) => `<a class="chip" href="#/search?q=${encodeURIComponent(q)}">${esc(q)}</a>`).join("")}</div>`
          : ""
      }
    </div>
  </section>

  <section class="continue" aria-labelledby="cw-title">
    <h2 id="cw-title">Continue watching</h2>
    ${
      shows.length
        ? `<ul class="cw-list">${shows.map(card).join("")}</ul>`
        : `<div class="empty">
             <span data-pierre="sleep" data-scale="4"></span>
             <p>Shows you start watching show up here, so you can pick up where you left off. They're saved in this browser only.</p>
           </div>`
    }
  </section>`;
  hydrate(main);
  fixPosters(main, hydrate);
  main.addEventListener(
    "click",
    (e) => {
      const btn = e.target.closest("[data-forget]");
      if (!btn) return;
      e.preventDefault();
      history.forget(btn.dataset.forget);
      const li = btn.closest("li");
      if (li) li.remove();
      if (!main.querySelector(".cw-list li")) {
        const empty = main.querySelector(".cw-list");
        empty.outerHTML = `<div class="empty"><span data-pierre="sleep" data-scale="4"></span><p>Nothing to continue. Pierre approves of this level of rest.</p></div>`;
        hydrate(main);
      }
    },
    { signal: ctx.signal },
  );
}

function card(h) {
  const p = progress.get(h.id, h.n);
  const pct = p && p.d ? Math.min(100, Math.round((p.t / p.d) * 100)) : 0;
  const mode = h.mode === "dub" ? "dub" : "sub";
  return `
  <li class="cw">
    <a class="cw-link" href="#/watch/${encodeURIComponent(h.id)}/${encodeURIComponent(h.n)}?mode=${mode}">
      ${poster(h.poster, h.title, "cw-poster")}
      <span class="cw-text">
        <span class="cw-title">${esc(h.title)}</span>
        <span class="cw-ep">Episode ${esc(h.n)}${mode === "dub" ? ", dubbed" : ""}</span>
        <span class="bar" aria-hidden="true"><span style="width:${pct}%"></span></span>
        <span class="cw-left">${p ? esc(minutesLeft(p.t, p.d)) : "not started"}</span>
      </span>
    </a>
    <button class="cw-forget" type="button" data-forget="${esc(h.id)}" aria-label="Remove ${esc(h.title)} from Continue watching" title="Remove">×</button>
  </li>`;
}

function renderSetup(main, ctx) {
  main.innerHTML = `
  <section class="setup panel" aria-labelledby="setup-title">
    <span data-pierre="shrug" data-scale="5"></span>
    <div>
      <h1 id="setup-title">MPA needs its worker</h1>
      <p>The site is up, but it doesn't know where its Cloudflare worker lives yet. Deploy the worker (the README walks through it in about five minutes), then paste its address here or into <code>web/config.js</code>.</p>
      <form class="setup-form" data-setup>
        <label class="field"><span>Worker address</span>
          <input type="url" name="api" required placeholder="https://mpa.your-name.workers.dev" autocomplete="off"></label>
        <button class="btn primary" type="submit">Connect</button>
      </form>
      <p class="fine">Running the local helper instead? Open <code>http://localhost:8787</code> and it connects by itself.</p>
    </div>
  </section>`;
  hydrate(main);
  main.querySelector("[data-setup]").addEventListener(
    "submit",
    (e) => {
      e.preventDefault();
      const url = new FormData(e.target).get("api").trim().replace(/\/+$/, "");
      settings.setApiOverride(url);
      location.reload();
    },
    { signal: ctx.signal },
  );
}
