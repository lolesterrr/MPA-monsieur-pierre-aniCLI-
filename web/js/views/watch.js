import { esc, fmtTime, toast, copyText, titleFromSlug, epName } from "../util.js";
import { api, shows, internetDown } from "../api.js";
import { history, prefs, progress } from "../store.js";
import { state, noteError } from "../state.js";
import { hydrate, pierre } from "../pierre.js";
import { problem } from "./common.js";

let hlsLoading = null;
function loadHls() {
  if (window.Hls) return Promise.resolve(window.Hls);
  if (!hlsLoading) {
    hlsLoading = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = new URL("../../vendor/hls.min.js", import.meta.url).href;
      s.onload = () => resolve(window.Hls);
      s.onerror = () => {
        hlsLoading = null;
        reject(new Error("Couldn't load the video player script."));
      };
      document.head.append(s);
    });
  }
  return hlsLoading;
}

export const title = (params, route) => `Episode ${route.n}, ${(shows.get(route.id) || {}).title || titleFromSlug(route.id)} | MPA`;

const isMac = () => /Macintosh|Mac OS X/.test(navigator.userAgent) && !/iPhone|iPad/.test(navigator.userAgent);

export async function render(main, params, ctx, route) {
  const { id, n } = route;
  const mode = params.get("mode") === "dub" ? "dub" : params.get("mode") === "sub" ? "sub" : prefs.get().mode;
  let meta = shows.get(id) || { id, title: titleFromSlug(id) };
  state.current = { id, title: meta.title, ep: n, mode };
  const enc = encodeURIComponent;
  const watchHref = (ep, m = mode) => `#/watch/${enc(id)}/${enc(ep)}?mode=${m}`;

  main.innerHTML = `
  <article class="watch" aria-labelledby="watch-ep">
    <div class="stage-wrap">
      <span class="perch" data-pierre="peek" data-scale="3" data-joke></span>
      <div class="stage" data-stage>
        <div class="stage-msg"><span data-pierre="think" data-scale="4"></span><p class="bubble bubble-left">Fetching episode ${esc(n)}…</p></div>
      </div>
    </div>
    <div class="watch-bar">
      <div class="watch-titles">
        <a class="watch-show" href="#/anime/${enc(id)}?mode=${mode}">${esc(meta.title)}</a>
        <h1 id="watch-ep" class="watch-ep">Episode ${esc(n)}<span class="ep-name"></span></h1>
      </div>
      <nav class="watch-nav" aria-label="Episodes">
        <a class="btn" data-prev hidden>Previous</a>
        <a class="btn primary" data-next hidden>Next episode</a>
      </nav>
    </div>
    <div class="watch-tools">
      <div class="seg" role="radiogroup" aria-label="Audio">
        <a role="radio" href="${watchHref(n, "sub")}" aria-checked="${mode === "sub"}" data-mode="sub">Sub</a>
        <a role="radio" href="${watchHref(n, "dub")}" aria-checked="${mode === "dub"}" data-mode="dub">Dub</a>
      </div>
      <label class="pick"><span>Quality</span><select data-quality disabled><option value="-1">Auto</option></select></label>
      <label class="pick"><span>Subtitles</span><select data-subs disabled><option value="off">Off</option></select></label>
      <details class="more">
        <summary class="btn">Other players</summary>
        <div class="more-menu">
          <button class="btn" type="button" data-copy disabled>Copy stream link</button>
          ${isMac() ? '<a class="btn" data-iina hidden>Open in IINA</a>' : ""}
          <p class="fine">The link plays in mpv, VLC and IINA too. It stops working after a few hours.</p>
        </div>
      </details>
      <button class="link-btn" type="button" data-complain="video">Something wrong with this episode?</button>
    </div>
  </article>`;
  hydrate(main);
  for (const a of main.querySelectorAll("[data-mode]")) a.addEventListener("click", () => prefs.set({ mode: a.dataset.mode }), { signal: ctx.signal });

  if (!meta.poster || meta.title === titleFromSlug(id)) {
    api.info(id, { signal: ctx.signal }).then(
      (info) => {
        if (ctx.signal.aborted || !info) return;
        meta = { ...meta, poster: meta.poster || info.poster, title: meta.title === titleFromSlug(id) && info.title ? info.title : meta.title };
        main.querySelector(".watch-show").textContent = meta.title;
        state.current = { ...state.current, title: meta.title };
        shows.remember([meta]);
      },
      () => {},
    );
  }

  const stage = main.querySelector("[data-stage]");
  const perchEl = main.querySelector(".perch");
  const perch = (anim) => pierre(perchEl, anim, { scale: 3 });
  const timers = new Set();
  const later = (fn, ms) => {
    const t = setTimeout(() => {
      timers.delete(t);
      fn();
    }, ms);
    timers.add(t);
    return t;
  };
  let hls = null;
  let video = null;
  let cleanupMedia = () => {};

  const showProblem = (err, opts = {}) => {
    noteError(err);
    stage.innerHTML = `<div class="stage-msg stage-problem">${problem(err, { kind: "video", ...opts })}</div>`;
    hydrate(stage);
    perch("peek");
    const retry = stage.querySelector("[data-retry]");
    if (retry) retry.addEventListener("click", () => start(), { once: true });
  };

  // episode list: for the episode id, its title, and previous/next
  let eps = [];
  try {
    eps = (await api.episodes(id, { signal: ctx.signal })).episodes || [];
  } catch (err) {
    if (err.code === "aborted") return;
    showProblem(err);
    return;
  }
  if (ctx.signal.aborted) return;
  const idx = eps.findIndex((e) => e.n === n);
  if (idx < 0) {
    showProblem({ code: "no_episode", message: `Episode ${n} isn't listed for this show (it has ${eps.length}).` }, { title: `There's no episode ${n} here`, retry: false, anim: "shrug" });
    return;
  }
  const ep = eps[idx];
  const prev = eps[idx - 1];
  const next = eps[idx + 1];
  const name = epName(ep.title, n);
  if (name) main.querySelector(".ep-name").textContent = `: ${name}`;
  const prevA = main.querySelector("[data-prev]");
  const nextA = main.querySelector("[data-next]");
  if (prev) Object.assign(prevA, { hidden: false, href: watchHref(prev.n) });
  if (next) Object.assign(nextA, { hidden: false, href: watchHref(next.n) });

  let src = null;
  let retriedNetwork = false;
  let mediaRecoveries = 0;

  async function fetchSources() {
    return api.sources({ id, epId: ep.id, mode }, { signal: ctx.signal });
  }

  async function start(resumeAt = null) {
    cleanupMedia();
    stage.innerHTML = `<div class="stage-msg"><span data-pierre="think" data-scale="4"></span><p class="bubble bubble-left">Fetching episode ${esc(n)}…</p></div>`;
    hydrate(stage);
    try {
      src = await fetchSources();
    } catch (err) {
      if (err.code === "aborted") return;
      const available = (err.data && err.data.available) || [];
      if (err.code === "no_source" && mode === "dub" && available.includes("sub")) {
        noteError(err);
        stage.innerHTML = `<div class="stage-msg">
          <span data-pierre="shrug" data-scale="4"></span>
          <div><p class="bubble bubble-left">No dub for episode ${esc(n)}.\nSubs are right here though.</p>
          <a class="btn primary" href="${watchHref(n, "sub")}" data-sub>Watch with subs</a></div></div>`;
        hydrate(stage);
        stage.querySelector("[data-sub]").addEventListener("click", () => prefs.set({ mode: "sub" }));
        perch("peek");
        return;
      }
      showProblem(err, err.code === "no_source" ? { title: `Episode ${n} has no ${mode} stream MPA can play`, retry: false, anim: "shrug" } : {});
      return;
    }
    if (ctx.signal.aborted) return;
    if (src.available && !src.available.includes("dub")) main.querySelector('[data-mode="dub"]').setAttribute("aria-disabled", "true");
    mountVideo(resumeAt);
  }

  function mountVideo(resumeAt) {
    video = document.createElement("video");
    video.controls = true;
    video.playsInline = true;
    video.preload = "auto";
    video.crossOrigin = "anonymous";
    video.setAttribute("aria-label", `${meta.title}, episode ${n}`);
    const want = prefs.get().subs;
    let chosen = -1;
    src.subtitles.forEach((s, i) => {
      if (chosen < 0 && want !== "off" && ((want === "default" && s.default) || (want !== "default" && s.lang === want))) chosen = i;
    });
    if (chosen < 0 && want !== "off") chosen = src.subtitles.findIndex((s) => s.default);
    src.subtitles.forEach((s, i) => {
      const t = document.createElement("track");
      t.kind = "subtitles";
      t.label = s.label;
      t.srclang = s.lang || "und";
      t.src = s.url;
      if (i === chosen) t.default = true;
      video.append(t);
    });
    const skip = document.createElement("button");
    skip.type = "button";
    skip.className = "btn primary skip";
    skip.hidden = true;
    const overlay = document.createElement("div");
    overlay.className = "next-up";
    overlay.hidden = true;
    stage.replaceChildren(video, skip, overlay);

    wireSubtitles(chosen);
    wireLinks();
    const startAt = resumeAt ?? resumePoint();
    attach(startAt);
    wirePlayback(skip, overlay);
  }

  function resumePoint() {
    // skip the resume when you'd barely started or were basically done (the credits)
    const p = progress.get(id, n);
    if (!p || !p.d) return null;
    const margin = Math.min(30, p.d * 0.1);
    return p.t > Math.min(20, margin) && p.t < p.d - margin ? p.t : null;
  }

  async function attach(startAt) {
    let Hls = null;
    try {
      Hls = await loadHls();
    } catch (err) {
      if (!video.canPlayType("application/vnd.apple.mpegurl")) return showProblem({ code: "player", message: err.message });
    }
    if (ctx.signal.aborted || !video) return;
    if (startAt) {
      video.addEventListener(
        "loadedmetadata",
        () => {
          video.currentTime = startAt;
          toast(`Picked up at ${fmtTime(startAt)}`);
        },
        { once: true },
      );
    }
    if (Hls && Hls.isSupported()) {
      hls = new Hls({ enableWorker: true, backBufferLength: 90, maxBufferLength: 40, startPosition: startAt ?? -1 });
      hls.on(Hls.Events.MANIFEST_PARSED, () => fillQuality(Hls));
      hls.on(Hls.Events.ERROR, (_, data) => onHlsError(Hls, data));
      hls.loadSource(src.master);
      hls.attachMedia(video);
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = src.master;
      video.addEventListener("error", () => showProblem({ code: "media", message: (video.error && video.error.message) || "The browser couldn't play this stream." }), { once: true });
    } else {
      showProblem({ code: "unsupported", message: "This browser can't play HLS video. Try Chrome, Firefox, Edge or Safari." }, { retry: false });
      return;
    }
    video.play().catch(() => {});
  }

  function onHlsError(Hls, data) {
    noteError({ code: data.details || data.type, message: `${data.type}: ${data.details}${data.response && data.response.code ? ` (HTTP ${data.response.code})` : ""}` });
    if (!data.fatal) return;
    if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
      if (!retriedNetwork) {
        // most often the relay link expired: get fresh links and carry on from here
        retriedNetwork = true;
        const at = video && video.currentTime > 1 ? video.currentTime : null;
        start(at);
        return;
      }
      // before blaming the stream host or the worker, check it isn't the visitor's internet
      internetDown().then((down) => {
        if (ctx.signal.aborted) return;
        if (down) showProblem({ code: "offline", message: "The video stopped loading because nothing answers." });
        else showProblem({ code: data.details, message: "The video stopped loading. The stream host may be down, or the worker used up Cloudflare's free daily limit (it resets at midnight UTC)." });
      });
      return;
    }
    if (data.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRecoveries < 2) {
      mediaRecoveries++;
      if (mediaRecoveries === 2) hls.swapAudioCodec();
      hls.recoverMediaError();
      return;
    }
    showProblem({ code: data.details, message: "The browser couldn't decode this video." });
  }

  function fillQuality(Hls) {
    const sel = main.querySelector("[data-quality]");
    const levels = hls.levels.map((l, i) => ({ i, h: l.height || 0, b: l.bitrate })).sort((a, b) => b.h - a.h || b.b - a.b);
    sel.innerHTML = `<option value="-1">Auto</option>` + levels.map((l) => `<option value="${l.i}">${l.h ? `${l.h}p` : `${Math.round(l.b / 1000)} kbps`}</option>`).join("");
    sel.disabled = levels.length < 2;
    const pref = prefs.get().quality;
    const match = levels.find((l) => l.h === pref);
    if (match) {
      hls.currentLevel = match.i;
      sel.value = String(match.i);
    }
    sel.onchange = () => {
      const v = Number(sel.value);
      hls.currentLevel = v;
      prefs.set({ quality: v < 0 ? -1 : hls.levels[v].height || -1 });
    };
  }

  function wireSubtitles(chosen) {
    const sel = main.querySelector("[data-subs]");
    sel.innerHTML = `<option value="off">Off</option>` + src.subtitles.map((s, i) => `<option value="${i}">${esc(s.label)}</option>`).join("");
    sel.disabled = !src.subtitles.length;
    sel.value = chosen >= 0 ? String(chosen) : "off";
    const apply = () => {
      const v = sel.value;
      [...video.textTracks].forEach((t, i) => (t.mode = String(i) === v ? "showing" : "disabled"));
    };
    video.addEventListener("loadedmetadata", apply, { once: true });
    sel.onchange = () => {
      apply();
      const v = sel.value;
      prefs.set({ subs: v === "off" ? "off" : src.subtitles[Number(v)].lang || "default" });
    };
  }

  function wireLinks() {
    const copy = main.querySelector("[data-copy]");
    copy.disabled = false;
    copy.onclick = async () => {
      const ok = await copyText(src.master);
      toast(ok ? "Stream link copied. Paste it into mpv, VLC or IINA." : "Couldn't copy. Your browser said no.");
    };
    const iina = main.querySelector("[data-iina]");
    if (iina) {
      iina.hidden = false;
      iina.href = `iina://weblink?url=${encodeURIComponent(src.master)}`;
    }
  }

  function wirePlayback(skip, overlay) {
    let skipTimes = null;
    let lastSave = 0;
    let napTimer = 0;
    let skippedOnce = false;
    const save = (force = false) => {
      if (!video || !video.duration || !Number.isFinite(video.duration)) return;
      const now = Date.now();
      if (!force && now - lastSave < 5000) return;
      lastSave = now;
      progress.save(id, n, video.currentTime, video.duration);
      history.save({ id, title: meta.title, poster: meta.poster || null, n, epId: ep.id, mode });
    };
    const on = (evt, fn) => video.addEventListener(evt, fn, { signal: ctx.signal });

    on("playing", () => {
      clearTimeout(napTimer);
      perch("popcorn");
      save(true);
    });
    on("waiting", () => perch("think"));
    on("pause", () => {
      save(true);
      if (video.ended) return;
      perch("peek");
      clearTimeout(napTimer);
      napTimer = later(() => perch("sleep"), 90e3);
    });
    on("timeupdate", () => {
      save();
      if (!skipTimes) return;
      const t = video.currentTime;
      const span = ["recap", "op"].map((k) => [k, skipTimes[k]]).find(([, r]) => r && t >= r.start && t < r.end - 1);
      if (span) {
        const [kind, r] = span;
        if (kind === "op" && prefs.get().autoskip && !skippedOnce) {
          skippedOnce = true;
          video.currentTime = r.end;
          toast("Skipped the intro");
          return;
        }
        skip.textContent = kind === "op" ? "Skip intro" : "Skip recap";
        skip.onclick = () => {
          video.currentTime = r.end;
          skip.hidden = true;
          video.focus();
        };
        skip.hidden = false;
      } else if (next && skipTimes.ed && t >= skipTimes.ed.start && t < skipTimes.ed.end - 1) {
        skip.textContent = "Next episode";
        skip.onclick = () => (location.hash = watchHref(next.n));
        skip.hidden = false;
      } else {
        skip.hidden = true;
      }
    });
    on("loadedmetadata", () => {
      if (!src.malId || !/^\d+$/.test(n)) return;
      api.skip({ mal: src.malId, ep: n, len: Math.round(video.duration) }, { signal: ctx.signal }).then(
        (r) => (skipTimes = r && r.found ? r : null),
        () => {},
      );
    });
    on("ended", () => {
      save(true);
      progress.save(id, n, video.duration, video.duration);
      perch("happy");
      if (!next || !prefs.get().autoplay) return;
      let left = 5;
      overlay.hidden = false;
      overlay.innerHTML = `<p>Episode ${esc(next.n)} starts in <b data-left>${left}</b></p>
        <div class="row"><a class="btn primary" href="${watchHref(next.n)}">Play now</a><button class="btn" type="button" data-cancel>Stay here</button></div>`;
      const tick = () => {
        left--;
        const b = overlay.querySelector("[data-left]");
        if (b) b.textContent = left;
        if (left <= 0) location.hash = watchHref(next.n);
        else countdown = later(tick, 1000);
      };
      let countdown = later(tick, 1000);
      overlay.querySelector("[data-cancel]").onclick = () => {
        clearTimeout(countdown);
        overlay.hidden = true;
      };
    });
    window.addEventListener("pagehide", () => save(true), { signal: ctx.signal });

    if ("mediaSession" in navigator && window.MediaMetadata) {
      try {
        navigator.mediaSession.metadata = new MediaMetadata({ title: `Episode ${n}${name ? `: ${name}` : ""}`, artist: meta.title, album: "MPA", artwork: meta.poster ? [{ src: meta.poster }] : [] });
        navigator.mediaSession.setActionHandler("previoustrack", prev ? () => (location.hash = watchHref(prev.n)) : null);
        navigator.mediaSession.setActionHandler("nexttrack", next ? () => (location.hash = watchHref(next.n)) : null);
      } catch {
        /* optional */
      }
    }

    cleanupMedia = () => {
      save(true);
      clearTimeout(napTimer);
      if (hls) {
        hls.destroy();
        hls = null;
      }
      if (video) {
        video.pause();
        video.removeAttribute("src");
        video.load();
        video = null;
      }
    };
  }

  await start();

  return () => {
    cleanupMedia();
    timers.forEach(clearTimeout);
    if ("mediaSession" in navigator) {
      try {
        navigator.mediaSession.metadata = null;
        navigator.mediaSession.setActionHandler("previoustrack", null);
        navigator.mediaSession.setActionHandler("nexttrack", null);
      } catch {
        /* optional */
      }
    }
  };
}
