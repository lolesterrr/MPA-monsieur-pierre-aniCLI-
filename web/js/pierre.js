// Monsieur Pierre: sprite player for the sheet made by tools/makepierre_mpa.py, plus his jokes.
//
// In markup:  <span data-pierre="search" data-scale="4"></span>
// then hydrate(root) turns every placeholder into an animated Pierre.
import { reducedMotion } from "./util.js";

const SHEET = new URL("../assets/pierre/pierre-mpa.png", import.meta.url).href;
const MANIFEST = new URL("../assets/pierre/pierre-mpa.json", import.meta.url).href;

let manifest = null;
let loading = null;
// the sheet is kept in memory as a blob, so Pierre still shows up when the internet drops
let sheetUrl = SHEET;

export function loadPierre() {
  if (!loading) {
    loading = fetch(MANIFEST)
      .then((r) => r.json())
      .then((m) => {
        manifest = m;
        const used = Object.values(m.anims).flatMap((a) => a.frames);
        m.rows = Math.ceil((Math.max(...used) + 1) / m.cols);
        return fetch(SHEET)
          .then((r) => (r.ok ? r.blob() : null))
          .then((blob) => {
            if (blob) sheetUrl = URL.createObjectURL(blob);
          })
          .catch(() => {})
          .then(() => m);
      })
      .catch(() => (manifest = null));
  }
  return loading;
}

const LABELS = {
  idle: "sitting around",
  beret: "wearing his red beret",
  wave: "waving",
  bonjour: "waving hello in his red beret",
  search: "searching with a magnifying glass",
  popcorn: "eating popcorn",
  spin: "turning in circles",
  walk: "walking",
  sleep: "asleep",
  knock: "pushing a mug off the table",
  stamp: "stamping a complaint",
  read: "reading a complaint with his glasses on",
  happy: "looking pleased",
  sad: "looking sad",
  shrug: "shrugging",
  think: "thinking",
  peek: "peeking over the edge",
};

const sprites = new WeakMap();

class Sprite {
  constructor(node, scale) {
    this.node = node;
    this.scale = scale;
    this.timer = 0;
    this.anim = null;
    node.classList.add("pierre");
    node.style.setProperty("--s", scale);
    node.setAttribute("role", "img");
    if (manifest) {
      // size and position are worked out in CSS from --s, so a media query can resize Pierre
      node.style.backgroundImage = `url("${sheetUrl}")`;
      node.style.setProperty("--cols", manifest.cols);
      node.style.setProperty("--rows", manifest.rows);
    }
  }

  frame(index) {
    if (!manifest) return;
    this.node.style.setProperty("--col", index % manifest.cols);
    this.node.style.setProperty("--row", Math.floor(index / manifest.cols));
  }

  play(name, { loop = true, then = null } = {}) {
    clearTimeout(this.timer);
    this.anim = name;
    this.node.dataset.anim = name;
    this.node.setAttribute("aria-label", `Monsieur Pierre, ${LABELS[name] || name}`);
    const a = manifest && manifest.anims[name];
    if (!a) return;
    if (reducedMotion()) {
      // one calm frame: the last one usually holds the pose
      this.frame(a.frames[name === "knock" || name === "stamp" ? a.frames.length - 1 : 0]);
      if (then) this.timer = setTimeout(() => this.play(then), 1200);
      return;
    }
    let i = 0;
    const tick = () => {
      if (!this.node.isConnected) {
        this.timer = setTimeout(() => this.node.isConnected && tick(), 1000);
        return;
      }
      this.frame(a.frames[i]);
      const wait = a.ms[i] || 200;
      i++;
      if (i >= a.frames.length) {
        if (!loop) {
          this.timer = then ? setTimeout(() => this.play(then), wait) : 0;
          return;
        }
        i = 0;
      }
      this.timer = setTimeout(tick, wait);
    };
    tick();
  }

  stop() {
    clearTimeout(this.timer);
  }
}

/** Make (or reuse) a Pierre on node and play anim. */
export function pierre(node, anim = "idle", { scale = 3, loop = true, then = null } = {}) {
  let sp = sprites.get(node);
  if (!sp) {
    sp = new Sprite(node, scale);
    sprites.set(node, sp);
  }
  sp.play(anim, { loop, then });
  return sp;
}

export function hydrate(root = document) {
  for (const node of root.querySelectorAll("[data-pierre]")) {
    const anim = node.getAttribute("data-pierre");
    node.removeAttribute("data-pierre");
    const sp = pierre(node, anim, { scale: Number(node.dataset.scale) || 3 });
    if (node.hasAttribute("data-joke")) attachJokes(node, sp);
  }
}

export const JOKES = [
  "I've seen every anime.\nMostly the inside of my eyelids.",
  "Sub or dub?\nI prefer nap.",
  "Filler episodes are my favourite.\nMore time to sleep.",
  "Opening songs are skippable.\nSnacks are not.",
  "I don't binge.\nI marathon. Lying down.",
  "The real treasure was the snacks\nwe ate along the way.",
  "Bonjour. I'm the projectionist.\nI project naps.",
  "I tried an isekai once.\nWoke up on the same sofa.",
  "Ask me about the plot.\nActually don't. No spoilers.",
  "Episode 1 is the best episode.\nIt's the only one I stayed awake for.",
  "Monsieur, that popcorn was for me.",
  "My power level is mostly naps.",
  "Complaints go in the box.\nThe box is where I sleep.",
];

let lastJoke = -1;
export function joke() {
  let i;
  do i = Math.floor(Math.random() * JOKES.length);
  while (i === lastJoke && JOKES.length > 1);
  lastJoke = i;
  return JOKES[i];
}

/** Clicking Pierre makes him say something: in his own bubble if he has one, else a floating one. */
function attachJokes(node, sp) {
  node.tabIndex = 0;
  node.setAttribute("role", "button");
  node.title = "Poke Monsieur Pierre";
  const poke = () => {
    const home = sp.anim === "happy" ? node.dataset.home || "idle" : sp.anim;
    node.dataset.home = home;
    const own = node.parentElement && node.parentElement.querySelector(":scope > .bubble:not(.bubble-pop)");
    const line = joke();
    if (own) {
      if (!("home" in own.dataset)) own.dataset.home = own.textContent;
      own.textContent = line;
      own.setAttribute("aria-live", "polite");
      clearTimeout(own._t);
      own._t = setTimeout(() => (own.textContent = own.dataset.home), 4500);
    } else {
      popBubble(node, line);
    }
    sp.play("happy", { loop: false, then: home });
  };
  node.addEventListener("click", poke);
  node.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      poke();
    }
  });
}

function popBubble(node, text) {
  let b = node._pop;
  if (!b || !b.isConnected) {
    b = document.createElement("p");
    b.className = "bubble bubble-pop";
    b.setAttribute("role", "status");
    document.body.append(b);
    node._pop = b;
  }
  b.textContent = text;
  b.hidden = false;
  const r = node.getBoundingClientRect();
  const bw = b.offsetWidth;
  const bh = b.offsetHeight;
  let side = "right";
  let left = r.right + 16;
  if (left + bw > window.innerWidth - 8) {
    side = "left";
    left = r.left - 16 - bw;
  }
  left = Math.max(8, left);
  const top = Math.max(8, Math.min(window.innerHeight - bh - 8, r.top + r.height * 0.15));
  b.style.left = `${left}px`;
  b.style.top = `${top}px`;
  b.dataset.side = side;
  const hide = () => {
    b.hidden = true;
    window.removeEventListener("scroll", hide);
  };
  window.addEventListener("scroll", hide, { passive: true });
  clearTimeout(b._t);
  b._t = setTimeout(hide, 4500);
  const gone = new MutationObserver(() => {
    if (!node.isConnected) {
      b.remove();
      gone.disconnect();
    }
  });
  gone.observe(document.body, { childList: true, subtree: true });
}
