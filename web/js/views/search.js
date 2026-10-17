import { esc } from "../util.js";
import { api, shows } from "../api.js";
import { recent } from "../store.js";
import { hydrate } from "../pierre.js";
import { problem, poster, fixPosters } from "./common.js";
import { openDesk } from "../complaint.js";

export const title = (params) => `${params.get("q") || "Search"} | MPA`;

export async function render(main, params, ctx) {
  const q = (params.get("q") || "").trim();
  if (!q) {
    location.replace("#/");
    return;
  }
  recent.add(q);
  main.innerHTML = `
  <section class="results" aria-labelledby="results-title" aria-busy="true">
    <h1 id="results-title" class="page-title">\u201c${esc(q)}\u201d</h1>
    <div class="loading">
      <span data-pierre="search" data-scale="4"></span>
      <p class="bubble bubble-left">Looking…</p>
    </div>
  </section>`;
  hydrate(main);
  const section = main.querySelector(".results");

  const load = async () => {
    let data;
    try {
      data = await api.search(q, { signal: ctx.signal });
    } catch (err) {
      if (err.code === "aborted") return;
      section.setAttribute("aria-busy", "false");
      section.innerHTML = `<h1 class="page-title">\u201c${esc(q)}\u201d</h1>${problem(err, { kind: "search" })}`;
      hydrate(section);
      section.querySelector("[data-retry]").addEventListener("click", () => {
        section.innerHTML = `<h1 class="page-title">\u201c${esc(q)}\u201d</h1><div class="loading"><span data-pierre="search" data-scale="4"></span><p class="bubble bubble-left">Looking again…</p></div>`;
        hydrate(section);
        load();
      });
      return;
    }
    if (ctx.signal.aborted) return;
    section.setAttribute("aria-busy", "false");
    const list = data.results || [];
    shows.remember(list);
    if (!list.length) {
      section.innerHTML = `
        <h1 class="page-title">\u201c${esc(q)}\u201d</h1>
        <div class="empty empty-wide">
          <span data-pierre="sad" data-scale="4"></span>
          <div>
            <p class="empty-lead">Nothing called “${esc(q)}”.</p>
            <p>Check the spelling, try fewer words, or search the Japanese title (Shingeki no Kyojin instead of Attack on Titan).</p>
            <button class="btn" type="button" data-missing>Tell Pierre what's missing</button>
          </div>
        </div>`;
      hydrate(section);
      section.querySelector("[data-missing]").addEventListener("click", () => openDesk({ kind: "search", message: `I searched for "${q}" and got nothing. I was looking for: ` }));
      return;
    }
    section.innerHTML = `
      <h1 class="page-title">\u201c${esc(q)}\u201d</h1>
      <p class="count">${list.length === 1 ? "1 show" : `${list.length} shows`}</p>
      <ul class="grid">${list.map(card).join("")}</ul>`;
    hydrate(section);
    fixPosters(section, hydrate);
  };
  await load();
}

function card(s) {
  const tags = [];
  if (s.type) tags.push(esc(s.type));
  if (s.eps) tags.push(s.eps === 1 ? "1 episode" : `${s.eps} episodes`);
  if (s.dub) tags.push("Dub");
  return `
  <li>
    <a class="show" href="#/anime/${encodeURIComponent(s.id)}">
      ${poster(s.poster, s.title)}
      <span class="show-title">${esc(s.title)}</span>
      ${tags.length ? `<span class="tags">${tags.map((t) => `<span class="tag">${t}</span>`).join("")}</span>` : ""}
    </a>
  </li>`;
}
