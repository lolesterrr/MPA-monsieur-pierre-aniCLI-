// Le bureau des plaintes: the complaint desk. Reachable from every page.
// Complaints become GitHub issues on the MPA repo (filed by the worker), or, when the worker
// can't file them, a GitHub "new issue" page with everything filled in.
import { api, apiBase, config, APP_VERSION } from "./api.js";
import { state } from "./state.js";
import { esc, el } from "./util.js";
import { pierre } from "./pierre.js";

const KINDS = [
  ["video", "Video won't play"],
  ["slow", "Slow or buffering"],
  ["subs", "Subtitles"],
  ["wrong", "Wrong anime or episode"],
  ["search", "Search"],
  ["idea", "Idea or request"],
  ["other", "Something else"],
];

const PLACEHOLDERS = {
  video: "Episode 3 of Death Nap shows a black screen after the intro.",
  slow: "It buffers every few seconds, even on 360p.",
  subs: "The English subtitles are about two seconds late.",
  wrong: "Episode 5 is actually episode 6.",
  search: "I searched for ... and it wasn't there.",
  idea: "It would be nice if ...",
  other: "Tell Pierre what happened.",
};

function context() {
  const c = state.current || {};
  const e = state.lastError;
  return {
    page: location.hash || "#/",
    title: c.title || "",
    id: c.id || "",
    ep: c.ep || "",
    mode: c.ep ? c.mode || "" : "",
    error: e ? `${e.code}: ${e.message}` : "",
    api: apiBase(),
    ua: navigator.userAgent,
    app: `MPA web ${APP_VERSION}`,
  };
}

function guessKind() {
  const h = location.hash;
  if (h.startsWith("#/watch")) return "video";
  if (h.startsWith("#/search")) return "search";
  if (h.startsWith("#/anime")) return "wrong";
  return "other";
}

let dialog = null;
let openedAt = 0;
let deskPierre = null;

function build() {
  const d = el(`
  <dialog id="desk" class="sheet" aria-labelledby="desk-title">
    <form class="sheet-body" data-form novalidate>
      <header class="sheet-head">
        <span class="sheet-pierre" data-desk-pierre></span>
        <div>
          <h2 id="desk-title">Bureau des plaintes</h2>
          <p class="bubble bubble-left" data-desk-bubble>Tell me what went wrong.\nI'll read it after my nap.</p>
        </div>
        <button class="x" type="button" data-close aria-label="Close the complaint desk">×</button>
      </header>
      <fieldset class="kinds">
        <legend>What's the complaint about?</legend>
        <div class="chips">${KINDS.map(([k, label]) => `<label class="chip-radio"><input type="radio" name="kind" value="${k}"><span>${esc(label)}</span></label>`).join("")}</div>
      </fieldset>
      <label class="field">
        <span>What happened</span>
        <textarea name="message" rows="5" maxlength="3000" required></textarea>
      </label>
      <label class="field">
        <span>How to reach you, if you want a reply <em>(optional)</em></span>
        <input name="contact" maxlength="200" autocomplete="email" placeholder="Email, Discord or GitHub name">
      </label>
      <label class="hp" aria-hidden="true">Leave this empty <input name="website" tabindex="-1" autocomplete="off"></label>
      <details class="attached">
        <summary>Pierre attaches the page, the anime, the episode, the last error and your browser</summary>
        <pre data-context></pre>
      </details>
      <p class="fine">Complaints are posted publicly on MPA's GitHub issues, so leave out anything private.</p>
      <p class="form-error" role="alert" hidden></p>
      <div class="sheet-actions">
        <button class="btn" type="button" data-close>Never mind</button>
        <button class="btn primary" type="submit" data-send>File complaint</button>
      </div>
    </form>
    <div class="sheet-body sheet-done" data-done hidden>
      <header class="sheet-head">
        <span class="sheet-pierre" data-done-pierre></span>
        <div><h2 data-done-title>Filed</h2><p class="bubble bubble-left" data-done-bubble></p></div>
        <button class="x" type="button" data-close aria-label="Close the complaint desk">×</button>
      </header>
      <p data-done-text></p>
      <div class="sheet-actions" data-done-actions></div>
    </div>
  </dialog>`);
  document.body.append(d);
  d.addEventListener("click", (e) => {
    if (e.target.closest("[data-close]") || e.target === d) d.close();
  });
  d.querySelector("[data-form]").addEventListener("submit", submit);
  d.querySelector("[data-form]").addEventListener("change", (e) => {
    if (e.target.name === "kind") d.querySelector("textarea").placeholder = PLACEHOLDERS[e.target.value] || PLACEHOLDERS.other;
  });
  deskPierre = d.querySelector("[data-desk-pierre]");
  return d;
}

export function openDesk({ kind, message = "" } = {}) {
  if (!dialog) dialog = build();
  const form = dialog.querySelector("[data-form]");
  const done = dialog.querySelector("[data-done]");
  form.hidden = false;
  done.hidden = true;
  form.reset();
  const k = KINDS.some(([x]) => x === kind) ? kind : guessKind();
  form.querySelector(`input[name="kind"][value="${k}"]`).checked = true;
  const ta = form.querySelector("textarea");
  ta.placeholder = PLACEHOLDERS[k];
  ta.value = message;
  form.querySelector(".form-error").hidden = true;
  form.querySelector("[data-send]").disabled = false;
  dialog.querySelector("[data-context]").textContent = Object.entries(context())
    .filter(([, v]) => v)
    .map(([key, v]) => `${key}: ${v}`)
    .join("\n");
  pierre(deskPierre, "read", { scale: 3 });
  openedAt = Date.now();
  if (!dialog.open) dialog.showModal();
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
}

async function submit(e) {
  e.preventDefault();
  const form = e.target;
  const data = new FormData(form);
  const message = String(data.get("message") || "").trim();
  const errBox = form.querySelector(".form-error");
  if (message.length < 3) {
    errBox.textContent = "Write a few words about what happened. Pierre can't read minds, only menus.";
    errBox.hidden = false;
    form.querySelector("textarea").focus();
    return;
  }
  errBox.hidden = true;
  const payload = {
    kind: data.get("kind") || "other",
    message,
    contact: String(data.get("contact") || "").trim(),
    website: String(data.get("website") || ""),
    elapsed: Date.now() - openedAt,
    context: context(),
  };
  const send = form.querySelector("[data-send]");
  send.disabled = true;
  send.textContent = "Filing…";
  pierre(deskPierre, "stamp", { scale: 3 });
  try {
    const res = await api.complain(payload);
    showDone({
      anim: "happy",
      title: res.number ? `Filed as #${res.number}` : "Filed",
      bubble: "Stamped and filed.\nI'll look at it. Eventually.",
      text: "Thanks. It's on MPA's GitHub issues now, where it gets fixed or at least judged.",
      link: res.url ? { href: res.url, label: "See it on GitHub" } : null,
    });
  } catch (err) {
    if (err.code === "duplicate") {
      showDone({ anim: "read", title: "Already on the desk", bubble: "I have this one already.\nStill reading it.", text: "The same complaint came in a few minutes ago, so Pierre kept the first copy.", link: null });
      return;
    }
    if (["slow_down", "too_fast", "empty", "too_long", "bad_json"].includes(err.code)) {
      errBox.textContent = err.message;
      errBox.hidden = false;
      pierre(deskPierre, "read", { scale: 3 });
      return;
    }
    const fallback = (err.data && err.data.fallback) || fallbackLink(payload);
    const wired = err.code !== "not_configured";
    showDone({
      anim: "shrug",
      title: "One more step",
      bubble: wired ? "My stamp jammed.\nGitHub can take it from here." : "My desk isn't wired to GitHub yet.\nSo GitHub takes it from here.",
      text: `${wired ? `The worker couldn't file it (${err.message})` : "Complaints can't be filed automatically yet"}. Open it on GitHub instead: everything you wrote is already filled in, you just press Submit. You'll need a GitHub account.`,
      link: { href: fallback, label: "Open it on GitHub", external: true },
    });
  } finally {
    send.disabled = false;
    send.textContent = "File complaint";
  }
}

function showDone({ anim, title, bubble, text, link }) {
  const form = dialog.querySelector("[data-form]");
  const done = dialog.querySelector("[data-done]");
  form.hidden = true;
  done.hidden = false;
  done.querySelector("[data-done-title]").textContent = title;
  done.querySelector("[data-done-bubble]").textContent = bubble;
  done.querySelector("[data-done-text]").textContent = text;
  const actions = done.querySelector("[data-done-actions]");
  actions.innerHTML = `<button class="btn" type="button" data-close>Close</button>${
    link ? `<a class="btn primary" href="${esc(link.href)}" target="_blank" rel="noopener">${esc(link.label)}</a>` : ""
  }`;
  pierre(done.querySelector("[data-done-pierre]"), anim, { scale: 3 });
  (actions.querySelector("a") || actions.querySelector("button")).focus();
}

/** Same issue the worker would file, as a prefilled GitHub link. */
function fallbackLink(p) {
  const label = (KINDS.find(([k]) => k === p.kind) || KINDS[KINDS.length - 1])[1];
  const c = p.context;
  const rows = [
    ["Kind", label],
    ["Page", c.page],
    ["Anime", c.title ? `${c.title} (\`${c.id}\`)` : c.id],
    ["Episode", c.ep ? `${c.ep}${c.mode ? ` (${c.mode})` : ""}` : ""],
    ["Error", c.error],
    ["Worker", c.api],
    ["Browser", c.ua],
    ["App", c.app],
    ["Contact", p.contact],
  ].filter(([, v]) => v);
  const body = `${p.message
    .split(/\r?\n/)
    .map((l) => `> ${l}`)
    .join("\n")}\n\n| | |\n|---|---|\n${rows.map(([k, v]) => `| ${k} | ${String(v).replace(/\|/g, "\\|").replace(/\r?\n/g, " ")} |`).join("\n")}\n\n_Filed at the MPA complaint desk._`;
  const q = new URLSearchParams({ title: `[${label}] ${p.message.split(/\r?\n/)[0].slice(0, 70)}`, body: body.slice(0, 6000), labels: `complaint,${p.kind}` });
  return `https://github.com/${config().repo || "lolesterrr/MPA-monsieur-pierre-aniCLI-"}/issues/new?${q}`;
}

/** Any [data-complain] button anywhere opens the desk; data-complain can name the kind. */
export function wireComplaints() {
  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-complain]");
    if (!btn) return;
    e.preventDefault();
    openDesk({ kind: btn.dataset.complain || undefined });
  });
}
