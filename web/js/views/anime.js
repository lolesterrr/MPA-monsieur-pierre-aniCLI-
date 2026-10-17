import { esc, titleFromSlug, epName } from "../util.js";
import { api, shows } from "../api.js";
import { history, prefs, progress } from "../store.js";
import { state } from "../state.js";
import { hydrate } from "../pierre.js";
import { problem, poster, fixPosters } from "./common.js";

export const title = (params, route) => `${(shows.get(route.id) || {}).title || titleFromSlug(route.id)} | MPA`;

const RANGE = 100;

export async function render(main, params, ctx, route) {
  const id = route.id;
  const mode = params.get("mode") === "dub" ? "dub" : params.get("mode") === "sub" ? "sub" : prefs.get().mode;
  let meta = shows.get(id) || { id, title: titleFromSlug(id) };
  state.current = { id, title: meta.title, mode };

  main.innerHTML = `
  <article class="anime" aria-labelledby="anime-title">
    <header class="anime-head">
      <div class="anime-poster">${poster(meta.poster, meta.title)}<span class="perch" data-pierre="idle" data-scale="2" data-joke></span></div>
      <div class="anime-info">
        <h1 id="anime-title">${esc(meta.title)}</h1>
        ${meta.jname && meta.jname !== meta.title ? `<p class="jname">${esc(meta.jname)}</p>` : ""}
        <p class="about" hidden></p>
        <div class="anime-actions">
          <div class="seg" role="radiogroup" aria-label="Audio">
            <a role="radio" href="#/anime/${encodeURIComponent(id)}?mode=sub" aria-checked="${mode === "sub"}" data-mode="sub">Sub</a>
            <a role="radio" href="#/anime/${encodeURIComponent(id)}?mode=dub" aria-checked="${mode === "dub"}" data-mode="dub">Dub</a>
          </div>
          <a class="btn primary play" href="#" hidden></a>
        </div>
      </div>
    </header>
    <section class="episodes" aria-labelledby="eps-title" aria-busy="true">
      <h2 id="eps-title">Episodes</h2>
      <div class="loading"><span data-pierre="think" data-scale="4"></span><p class="bubble bubble-left">Counting episodes…</p></div>
    </section>
  </article>`;
  hydrate(main);
  fixPosters(main, hydrate);
  for (const a of main.querySelectorAll("[data-mode]")) {
    a.addEventListener("click", () => prefs.set({ mode: a.dataset.mode }), { signal: ctx.signal });
  }

  // fill in the description and poster when we didn't come from search
  api.info(id, { signal: ctx.signal }).then(
    (info) => {
      if (ctx.signal.aborted || !info) return;
      if (info.description) {
        const about = main.querySelector(".about");
        about.textContent = info.description;
        about.hidden = false;
      }
      if (!meta.poster && info.poster) {
        meta = { ...meta, poster: info.poster };
        const box = main.querySelector(".anime-poster");
        box.querySelector(".poster, .poster-none").outerHTML = poster(info.poster, meta.title);
        hydrate(box);
        fixPosters(box, hydrate);
      }
      if (info.title && meta.title === titleFromSlug(id)) {
        meta = { ...meta, title: info.title };
        main.querySelector("#anime-title").textContent = info.title;
        document.title = `${info.title} | MPA`;
        state.current = { ...state.current, title: info.title };
      }
      shows.remember([meta]);
    },
    () => {},
  );

  const section = main.querySelector(".episodes");
  const load = async () => {
    let eps;
    try {
      eps = (await api.episodes(id, { signal: ctx.signal })).episodes || [];
    } catch (err) {
      if (err.code === "aborted") return;
      section.setAttribute("aria-busy", "false");
      section.innerHTML = `<h2 id="eps-title">Episodes</h2>${problem(err, { kind: "wrong" })}`;
      hydrate(section);
      section.querySelector("[data-retry]").addEventListener("click", () => {
        section.innerHTML = `<h2 id="eps-title">Episodes</h2><div class="loading"><span data-pierre="think" data-scale="4"></span><p class="bubble bubble-left">Counting again…</p></div>`;
        hydrate(section);
        load();
      });
      return;
    }
    if (ctx.signal.aborted) return;
    section.setAttribute("aria-busy", "false");
    if (!eps.length) {
      section.innerHTML = `<h2 id="eps-title">Episodes</h2>
        <div class="empty"><span data-pierre="shrug" data-scale="4"></span><p>No episodes are listed for this one yet. New shows sometimes take a day to appear.</p></div>`;
      hydrate(section);
      return;
    }
    const h = history.get(id);
    const resume = h && eps.find((e) => e.n === h.n);
    const start = resume || eps[0];
    const play = main.querySelector(".play");
    play.hidden = false;
    play.href = `#/watch/${encodeURIComponent(id)}/${encodeURIComponent(start.n)}?mode=${mode}`;
    play.textContent = resume ? `Continue episode ${start.n}` : eps.length === 1 ? "Watch" : `Start episode ${start.n}`;

    const ranges = [];
    for (let i = 0; i < eps.length; i += RANGE) ranges.push([i, Math.min(eps.length, i + RANGE)]);
    let current = Math.max(0, ranges.findIndex(([a, b]) => eps.slice(a, b).includes(start)));

    const draw = () => {
      const [a, b] = ranges[current];
      section.innerHTML = `
        <h2 id="eps-title">Episodes <span class="count">${eps.length}</span></h2>
        ${
          ranges.length > 1
            ? `<div class="ranges" role="tablist" aria-label="Episode ranges">${ranges
                .map(([x, y], i) => `<button type="button" role="tab" aria-selected="${i === current}" data-range="${i}">${esc(eps[x].n)}–${esc(eps[y - 1].n)}</button>`)
                .join("")}</div>`
            : ""
        }
        <ol class="ep-grid">${eps
          .slice(a, b)
          .map((e) => {
            const watched = progress.watched(id, e.n);
            const isLast = h && h.n === e.n;
            const name = epName(e.title, e.n);
            const label = `Episode ${e.n}${name ? `: ${name}` : ""}${watched ? ", watched" : ""}${e.filler ? ", filler" : ""}`;
            return `<li><a class="ep${watched ? " watched" : ""}${isLast ? " last" : ""}${e.filler ? " filler" : ""}" href="#/watch/${encodeURIComponent(id)}/${encodeURIComponent(e.n)}?mode=${mode}" title="${esc(label)}" aria-label="${esc(label)}">${esc(e.n)}</a></li>`;
          })
          .join("")}</ol>
        ${eps.some((e) => e.filler) ? '<p class="fine legend"><span class="ep filler sample" aria-hidden="true"></span> Filler episodes have a corner fold.</p>' : ""}`;
      for (const btn of section.querySelectorAll("[data-range]")) {
        btn.addEventListener("click", () => {
          current = Number(btn.dataset.range);
          draw();
          section.querySelector(`[data-range="${current}"]`).focus();
        });
      }
    };
    draw();
  };
  await load();
}
