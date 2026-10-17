// Backstage: which worker MPA talks to, a connection check, and a couple of playback switches.
import { api, apiBase, config, isConfigured } from "./api.js";
import { prefs, settings, history } from "./store.js";
import { esc, el, toast } from "./util.js";
import { pierre } from "./pierre.js";

let dialog = null;

function build() {
  const d = el(`
  <dialog id="backstage" class="sheet" aria-labelledby="bs-title">
    <form class="sheet-body" data-form>
      <header class="sheet-head">
        <span class="sheet-pierre" data-bs-pierre></span>
        <div>
          <h2 id="bs-title">Backstage</h2>
          <p class="bubble bubble-left">Wires and switches.\nDon't touch the red one.</p>
        </div>
        <button class="x" type="button" data-close aria-label="Close Backstage">×</button>
      </header>
      <label class="field">
        <span>Worker address</span>
        <input name="api" type="url" inputmode="url" autocomplete="off" spellcheck="false" placeholder="https://mpa.your-name.workers.dev">
      </label>
      <p class="fine" data-source></p>
      <div class="check">
        <button class="btn" type="button" data-check>Check the connection</button>
        <ul class="status" data-status aria-live="polite"></ul>
      </div>
      <fieldset class="switches">
        <legend>Playback</legend>
        <label class="switch"><input type="checkbox" name="autoplay"><span>Play the next episode when one ends</span></label>
        <label class="switch"><input type="checkbox" name="autoskip"><span>Skip intros by themselves</span></label>
      </fieldset>
      <fieldset class="switches">
        <legend>This browser</legend>
        <p class="fine">Your watch history, progress and settings never leave this browser.</p>
        <button class="btn" type="button" data-wipe>Clear watch history</button>
      </fieldset>
      <div class="sheet-actions">
        <button class="btn" type="button" data-default>Use the default address</button>
        <button class="btn primary" type="submit">Save</button>
      </div>
    </form>
  </dialog>`);
  document.body.append(d);
  d.addEventListener("click", (e) => {
    if (e.target.closest("[data-close]") || e.target === d) d.close();
  });
  d.querySelector("[data-check]").addEventListener("click", check);
  d.querySelector("[data-default]").addEventListener("click", () => {
    settings.setApiOverride("");
    d.querySelector('input[name="api"]').value = config().api || "";
    describeSource();
    toast("Back to the address in config.js");
  });
  d.querySelector("[data-wipe]").addEventListener("click", () => {
    for (const h of history.all()) history.forget(h.id);
    toast("Watch history cleared");
    if (location.hash === "#/" || !location.hash) window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
  d.querySelector("[data-form]").addEventListener("submit", (e) => {
    e.preventDefault();
    const form = e.target;
    const url = String(new FormData(form).get("api") || "").trim().replace(/\/+$/, "");
    const before = apiBase();
    if (url && url !== (config().api || "").replace(/\/+$/, "")) settings.setApiOverride(url);
    else settings.setApiOverride("");
    prefs.set({ autoplay: form.autoplay.checked, autoskip: form.autoskip.checked });
    d.close();
    if (apiBase() !== before) location.reload();
    else toast("Saved");
  });
  return d;
}

function describeSource() {
  const src = dialog.querySelector("[data-source]");
  if (config().local) src.textContent = "Served by the local helper, so MPA talks to it directly.";
  else if (settings.apiOverride()) src.textContent = "Saved in this browser. Other browsers still use the address in config.js.";
  else src.textContent = "From web/config.js.";
}

export function openBackstage() {
  if (!dialog) dialog = build();
  const form = dialog.querySelector("[data-form]");
  form.api.value = apiBase();
  const p = prefs.get();
  form.autoplay.checked = p.autoplay;
  form.autoskip.checked = p.autoskip;
  dialog.querySelector("[data-status]").innerHTML = "";
  describeSource();
  pierre(dialog.querySelector("[data-bs-pierre]"), "think", { scale: 3 });
  dialog.showModal();
}

async function check() {
  const list = dialog.querySelector("[data-status]");
  const sprite = dialog.querySelector("[data-bs-pierre]");
  const typed = String(dialog.querySelector('input[name="api"]').value || "").trim().replace(/\/+$/, "");
  const row = (ok, label, text) => `<li class="${ok === true ? "ok" : ok === false ? "bad" : "meh"}"><b>${esc(label)}</b> ${esc(text)}</li>`;
  list.innerHTML = '<li class="meh">Checking…</li>';
  pierre(sprite, "search", { scale: 3 });
  const saved = settings.apiOverride();
  if (typed && typed !== apiBase()) settings.setApiOverride(typed);
  try {
    if (!isConfigured()) throw Object.assign(new Error("Enter the worker's address first."), { code: "not_connected" });
    const h = await api.health(true);
    const up = h.upstream === "ok" ? [true, "Reachable"] : h.upstream === "blocked" ? [false, "Cloudflare is blocking the worker. The local helper can get around it."] : [false, h.upstreamMessage || h.upstream];
    list.innerHTML = [
      row(true, "Worker", `Reachable, version ${h.version}`),
      row(h.signing, "Video relay", h.signing ? "Ready" : "Missing SIGNING_KEY. Add it in the worker's settings."),
      row(h.complaints ? true : null, "Complaint desk", h.complaints ? `Files issues on ${h.repo}` : "Opens a prefilled GitHub issue (add GITHUB_TOKEN to the worker to file them directly)"),
      row(up[0], "hianime", up[1]),
    ].join("");
    pierre(sprite, h.signing && h.upstream === "ok" ? "happy" : "shrug", { scale: 3 });
  } catch (err) {
    list.innerHTML = row(false, "Worker", err.message);
    pierre(sprite, "sad", { scale: 3 });
  } finally {
    if (typed && typed !== saved) settings.setApiOverride(saved);
  }
}
