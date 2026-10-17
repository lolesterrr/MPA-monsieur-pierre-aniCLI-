"""More moves for Monsieur Pierre, for MPA (Monsieur Pierre's ani-cli).

Builds on tools/makepierre.py (copied unchanged from the Monsieur Pierre repo, oneko-woah):
same 32x32 frames, same palette, same outline pass. Props (beret, magnifier, popcorn, mug,
stamp, paper) are drawn as their own layers, each with its own outline, on top of Pierre.

Usage (needs Pillow), from the repo root:
    python3 tools/makepierre_mpa.py

Writes:
    web/assets/pierre/pierre-mpa.png    the sheet, 8 frames across, 32x32 each
    web/assets/pierre/pierre-mpa.json   which frames make which animation, and how long each lasts
    web/favicon.png, web/apple-touch-icon.png, web/og-image.png
    docs/pierre-mpa-preview.png         every animation at 4x, one row each, for eyeballing
"""
import json
import math
import os
import sys

from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import makepierre as mp  # noqa: E402
from makepierre import Frame, ell, tri, rect  # noqa: E402

mp.PAL.update({
    "r": (196, 38, 54, 255),     # beret, stamp ink, popcorn stripes, hearts
    "R": (236, 98, 108, 255),    # red highlight
    "b": (128, 84, 52, 255),     # wood: magnifier handle, stamp handle
    "c": (104, 64, 38, 255),     # coffee
    "l": (168, 216, 242, 255),   # lens
    "L": (236, 248, 254, 255),   # lens glint
    "m": (112, 150, 226, 255),   # mug
    "y": (252, 234, 168, 255),   # popcorn
    "Y": (255, 210, 84, 255),    # sparkle
    "t": (112, 178, 246, 255),   # tear
    "q": (226, 226, 222, 255),   # paper shade
})


# ---------- shapes the original script doesn't have ----------

def cap(x0, y0, x1, y1, w):
    """Capsule: every pixel within w of the segment (x0, y0)-(x1, y1)."""
    dx, dy = x1 - x0, y1 - y0
    l2 = dx * dx + dy * dy or 1e-9

    def f(x, y):
        px, py = x + .5, y + .5
        t = max(0.0, min(1.0, ((px - x0) * dx + (py - y0) * dy) / l2))
        qx, qy = x0 + t * dx, y0 + t * dy
        return (px - qx) ** 2 + (py - qy) ** 2 <= w * w
    return f


def ring(cx, cy, r0, r1):
    return lambda x, y: r0 * r0 < (x + .5 - cx) ** 2 + (y + .5 - cy) ** 2 <= r1 * r1


def rot(shape, cx, cy, deg):
    """The same shape turned deg degrees clockwise (on screen) around (cx, cy)."""
    a = math.radians(deg)
    c, s = math.cos(a), math.sin(a)

    def f(x, y):
        px, py = x + .5 - cx, y + .5 - cy
        ux, uy = c * px + s * py + cx, -s * px + c * py + cy
        return shape(ux - .5, uy - .5)
    return f


def union(*shapes):
    return lambda x, y: any(s(x, y) for s in shapes)


class Scene:
    """Layers, back to front. Each layer is a Frame with its own outline."""

    def __init__(self, *layers):
        self.layers = [layer for layer in layers if layer is not None]

    def render(self):
        img = Image.new("RGBA", (32, 32), (0, 0, 0, 0))
        for layer in self.layers:
            img.alpha_composite(layer.render())
        return img


def marks(pts, role="z"):
    return Frame().px(pts, role)


# ---------- Pierre, with more faces ----------

def head(f, cx=16, cy=13, eyes="open", ears=1.0, look=None, mouth="smile", glasses=False):
    """head_front from makepierre.py, plus happy/sad/big eyes, other mouths and glasses."""
    e = 6 * ears
    f.add(tri((cx - 7, cy - 1), (cx - 6, cy - e - 1), (cx - 2, cy - 4)), "k")
    f.add(tri((cx + 7, cy - 1), (cx + 6, cy - e - 1), (cx + 2, cy - 4)), "k")
    f.add(ell(cx, cy, 8, 6.2), "k")
    f.paint(tri((cx - 5.5, cy - 2), (cx - 5.5, cy - e + .5), (cx - 3, cy - 3.5)), "p")
    f.paint(tri((cx + 5.5, cy - 2), (cx + 5.5, cy - e + .5), (cx + 3, cy - 3.5)), "p")
    f.paint(ell(cx, cy + 3, 4.6, 3.2), "w")
    f.paint(tri((cx - 1, cy + 1), (cx + 1, cy + 1), (cx, cy - 5)), "w")
    ex = (cx - 4, cx + 3)
    if look is not None:
        gx, gy = look
        for x in ex:
            f.px([(x, cy - 1), (x + 1, cy - 1), (x, cy), (x + 1, cy)], "e")
            px_ = x + (1 if gx > 0 else 0 if gx < 0 else (1 if x < cx else 0))
            f.px([(px_, cy - 1 if gy < 0 else cy)], "o")
    elif eyes == "open":
        for x in ex:
            f.px([(x, cy - 1), (x + 1, cy - 1), (x, cy), (x + 1, cy)], "e")
            f.px([(x + (1 if x < cx else 0), cy)], "o")
    elif eyes == "wide":
        for x in ex:
            f.px([(x, cy - 2), (x + 1, cy - 2), (x, cy - 1), (x + 1, cy - 1), (x, cy), (x + 1, cy)], "e")
            f.px([(x + (1 if x < cx else 0), cy - 1)], "o")
    elif eyes == "sleepy":
        for x in ex:
            f.px([(x, cy), (x + 1, cy)], "o")
            f.px([(x, cy - 1), (x + 1, cy - 1)], "e")
    elif eyes == "happy":           # ^ ^
        for x in ex:
            f.px([(x, cy - 1), (x + 1, cy - 1), (x - 1, cy), (x + 2, cy)], "o")
    elif eyes == "sad":             # looking down, brows up in the middle
        for x in ex:
            f.px([(x, cy), (x + 1, cy)], "e")
            f.px([(x + (1 if x < cx else 0), cy)], "o")
            inner = x + 1 if x < cx else x
            outer = x if x < cx else x + 1
            f.px([(inner, cy - 3), (outer, cy - 2)], "o")
    else:  # closed
        for x in ex:
            f.px([(x, cy), (x + 1, cy)], "o")
    if glasses:
        for x in ex:
            f.px([(x - 1, cy - 2), (x, cy - 2), (x + 1, cy - 2), (x + 2, cy - 2),
                  (x - 1, cy + 1), (x, cy + 1), (x + 1, cy + 1), (x + 2, cy + 1),
                  (x - 1, cy - 1), (x - 1, cy), (x + 2, cy - 1), (x + 2, cy)], "o")
        f.px([(cx - 1, cy - 1), (cx, cy - 1)], "o")
    f.px([(cx - 1, cy + 2), (cx, cy + 2)], "p")
    if mouth == "smile":
        f.px([(cx - 2, cy + 3), (cx - 1, cy + 4), (cx, cy + 4), (cx + 1, cy + 3)], "o")
    elif mouth == "open":
        f.px([(cx - 2, cy + 3), (cx + 1, cy + 3), (cx - 1, cy + 3), (cx, cy + 3)], "o")
        f.px([(cx - 1, cy + 4), (cx, cy + 4)], "p")
        f.px([(cx - 2, cy + 4), (cx + 1, cy + 4), (cx - 1, cy + 5), (cx, cy + 5)], "o")
    elif mouth == "chew":
        f.px([(cx - 2, cy + 4), (cx - 1, cy + 4), (cx, cy + 4), (cx + 1, cy + 4)], "o")
    elif mouth == "frown":
        f.px([(cx - 2, cy + 4), (cx - 1, cy + 3), (cx, cy + 3), (cx + 1, cy + 4)], "o")
    elif mouth == "o":
        f.px([(cx - 1, cy + 3), (cx, cy + 3), (cx - 1, cy + 5), (cx, cy + 5), (cx - 2, cy + 4), (cx + 1, cy + 4)], "o")


def cat(eyes="open", ears=1.0, look=None, mouth="smile", glasses=False, tail=0, tail_side="right"):
    """sit() from makepierre.py with the extra faces. tail shifts the wrapped tail for a wag;
    tail_side="left" wraps it round the other side to make room for props on the right."""
    f = Frame()
    tx = 26 + tail if tail_side == "right" else 7.5 - tail
    f.add(ell(tx, 28.5 - abs(tail) * .5, 4.5, 2.6), "k")
    f.add(ell(16, 24, 11, 8.2), "k")
    f.paint(ell(16, 25.5, 6.5, 6.5), "w")
    f.add(ell(11.5, 30, 3, 1.8), "w")
    f.add(ell(20.5, 30, 3, 1.8), "w")
    head(f, eyes=eyes, ears=ears, look=look, mouth=mouth, glasses=glasses)
    return f


def arm(x0, y0, x1, y1, w=1.9, paw=2.3):
    """A black arm from the shoulder (x0, y0) ending in a white paw at (x1, y1)."""
    f = Frame()
    f.add(cap(x0, y0, x1, y1, w), "k")
    f.add(ell(x1, y1, paw, paw), "w")
    return f


def paw(x, y, rx=2.3, ry=1.9):
    return Frame().add(ell(x, y, rx, ry), "w")


# ---------- props ----------

def beret(dx=0, dy=0):
    f = Frame()
    f.add(ell(17.5 + dx, 7.6 + dy, 7.2, 2.4), "r")
    f.add(ell(17 + dx, 6.4 + dy, 5.6, 2.6), "r")
    f.paint(ell(14.8 + dx, 5.8 + dy, 2.2, 1.0), "R")
    f.px([(18 + dx, 3 + dy), (18 + dx, 2 + dy)], "o")
    return f


def lens(cx, cy, hx, hy, big_eye=None, r=4.3):
    """Magnifying glass: lens centred (cx, cy), handle ending at (hx, hy).
    big_eye=(dx) draws Pierre's eye magnified inside the lens, pupil shifted by dx."""
    f = Frame()
    a = math.atan2(hy - cy, hx - cx)
    sx, sy = cx + math.cos(a) * (r - .5), cy + math.sin(a) * (r - .5)
    f.add(cap(sx, sy, hx, hy, 1.05), "b")
    f.add(ell(cx, cy, r, r), "l")
    ix, iy = int(round(cx - .5)), int(round(cy - .5))
    if big_eye is None:
        f.px([(ix - 2, iy - 1), (ix - 1, iy - 2), (ix - 2, iy - 2)], "L")
    else:
        for yy in range(iy - 1, iy + 3):
            for xx in range(ix - 1, ix + 3):
                f.px([(xx, yy)], "e")
        px_ = ix + (big_eye if big_eye else 0)
        f.px([(px_, iy + 1), (px_ + 1, iy + 1), (px_, iy + 2), (px_ + 1, iy + 2)], "o")
        f.px([(ix - 2, iy - 2)], "L")
    return f


def bucket():
    top, bot, wt, wb, cx = 21.0, 31.6, 6.6, 5.0, 16.0

    def shape(x, y):
        py = y + .5
        if py < top or py > bot:
            return False
        t = (py - top) / (bot - top)
        return abs(x + .5 - cx) <= wt + (wb - wt) * t
    f = Frame().add(shape, "w")
    f.paint(lambda x, y: shape(x, y) and (x // 2) % 2 == 0, "r")
    f.paint(lambda x, y: shape(x, y) and y + .5 < top + 1.6, "w")   # rim
    return f


def popcorn(shift=0):
    f = Frame()
    for (x, y, r) in ((10.6, 20.4, 2.0), (13.4, 19.3, 2.2), (16.6, 19.6, 2.1), (19.6, 19.1, 2.2), (22.0, 20.6, 1.9)):
        f.add(ell(x, y + shift, r, r * .9), "y")
    return f


def mug(tilt=0):
    body = rect(23, 21.5, 28, 30.5)
    handle = ring(29.4, 25.6, 1.0, 2.2)
    f = Frame()
    shape = union(body, handle)
    f.add(rot(shape, 28, 30.5, tilt) if tilt else shape, "m")
    lip = rect(23, 21.5, 28, 22.4)
    f.paint(rot(lip, 28, 30.5, tilt) if tilt else lip, "c")
    return f


def stamp(x, y):
    """Rubber stamp whose red rubber sits on row y, centred on x."""
    f = Frame()
    f.add(ell(x + .5, y - 7.5, 2.4, 2.0), "b")        # knob
    f.add(rect(x - .5, y - 6, x + 1.5, y - 3), "b")   # neck
    f.add(rect(x - 3, y - 3, x + 4, y - 1), "b")      # block
    f.add(rect(x - 3, y, x + 4, y), "r")              # rubber
    return f


def hold_stamp(shoulder, x, y, look=None):
    """Arm behind the stamp, paw wrapped round the neck in front."""
    reach = Frame().add(cap(shoulder[0], shoulder[1], x - .5, y - 4.2, 1.9), "k")
    return [reach, stamp(x, y), paw(x + .5, y - 4.4, 2.2, 1.8)]


def paper(x0, y0, x1, y1, lines=True, inked=False):
    f = Frame().add(rect(x0, y0, x1, y1), "w")
    if lines:
        for i, yy in enumerate(range(y0 + 2, y1 - 1, 2)):
            end = x1 - 2 - (3 if i % 2 else 0)
            f.px([(xx, yy) for xx in range(x0 + 2, end + 1)], "q")
    if inked:
        cx, cy = (x0 + x1) // 2, (y0 + y1) // 2
        f.px([(xx, yy) for xx in range(cx - 2, cx + 3) for yy in (cy - 1, cy, cy + 1)
              if not (yy == cy and cx - 1 <= xx <= cx + 1)], "r")
    return f


def heart(x, y, big=True):
    pts = ([(x + 1, y), (x + 3, y), (x, y + 1), (x + 1, y + 1), (x + 2, y + 1), (x + 3, y + 1), (x + 4, y + 1),
            (x + 1, y + 2), (x + 2, y + 2), (x + 3, y + 2), (x + 2, y + 3)] if big else
           [(x, y), (x + 2, y), (x, y + 1), (x + 1, y + 1), (x + 2, y + 1), (x + 1, y + 2)])
    f = Frame().px(pts, "r")
    if big:
        f.px([(x + 1, y)], "R")
    return f


def sparkle(x, y):
    return marks([(x, y - 1), (x - 1, y), (x, y), (x + 1, y), (x, y + 1)], "Y")


# ---------- animations ----------
# Each entry: name -> list of (Scene or Frame, milliseconds).

def anim_idle():
    return [(cat(), 2600), (cat(eyes="closed"), 140), (cat(), 260), (cat(eyes="closed"), 140)]


def anim_beret():
    return [(Scene(cat(), beret()), 2600), (Scene(cat(eyes="closed"), beret()), 140),
            (Scene(cat(), beret()), 260), (Scene(cat(eyes="closed"), beret()), 140)]


def anim_wave(with_beret=False):
    hat = beret() if with_beret else None
    up = Scene(cat(eyes="happy"), arm(22.5, 20.5, 26.8, 11.2), hat,
               marks([(30, 9), (30, 10), (29, 8)]))
    out = Scene(cat(eyes="happy"), arm(22.5, 20.5, 28.4, 13.6), hat,
                marks([(28, 9), (29, 10)]))
    return [(up, 220), (out, 220), (up, 220), (out, 220),
            (Scene(cat(), arm(22.5, 20.5, 27.5, 12.5), hat), 900)]


def anim_search():
    def f(lx, ly, hx, hy, shoulder, look, big=None, eyes_skip=None):
        c = cat(look=look)
        return Scene(c, arm(shoulder[0], shoulder[1], hx, hy), lens(lx, ly, hx, hy, big))
    left = f(6.2, 10.5, 3.6, 16.4, (9.0, 21.5), (-1, 0))
    mid_l = f(12.5, 12.5, 11.2, 20.8, (8.5, 22.5), (-1, 0), big=0)
    mid_r = f(19.5, 12.5, 20.8, 20.8, (23.5, 22.5), (1, 0), big=1)
    right = f(25.8, 10.5, 28.4, 16.4, (23.0, 21.5), (1, 0))
    return [(left, 420), (mid_l, 360), (mid_r, 360), (right, 420), (mid_r, 360), (mid_l, 360)]


def anim_popcorn():
    hold = lambda c: Scene(c, popcorn(), bucket(), paw(9.6, 24.6), paw(22.4, 24.6))
    snack = Scene(cat(mouth="open"), popcorn(), bucket(), paw(9.6, 24.6),
                  arm(22.4, 22.0, 17.6, 18.2, w=1.6, paw=1.9), marks([(17, 16), (18, 16)], "y"))
    chew = hold(cat(mouth="chew"))
    return [(hold(cat()), 1500), (snack, 320), (chew, 260), (hold(cat(mouth="chew")), 260),
            (hold(cat()), 1200), (hold(cat(eyes="wide", mouth="o")), 700)]


def anim_spin():
    S, W = mp.front_walk, mp.side
    seq = [S(0), W(0, 1), W(1), W(0, -1), mp.back(0), W(1, -1).flip(), W(0).flip(), W(1, 1).flip()]
    return [(fr, 85) for fr in seq]


def anim_walk():
    return [(mp.side(0), 160), (mp.side(1), 160)]


def anim_sleep():
    return [(mp.sleeping(0), 700), (mp.sleeping(1), 700)]


def anim_knock():
    body = lambda **kw: cat(tail_side="left", **kw).shift(-3, 0)
    sh = (18.0, 21.5)
    spill = marks([(25, 31), (26, 30), (27, 31), (28, 31), (29, 30), (30, 31), (31, 31), (24, 31)], "c")
    f0 = Scene(body(look=(1, 1)), mug())
    f1 = Scene(body(look=(1, 1)), mug(), arm(*sh, 21.4, 24.8))
    f2 = Scene(body(look=(1, 1)), mug(16), arm(*sh, 23.0, 23.6))
    f3 = Scene(body(eyes="wide", mouth="o"), mug(55), arm(*sh, 24.0, 22.6),
               marks([(24, 19), (26, 18), (29, 19)], "c"))
    f4 = Scene(body(eyes="wide", mouth="o"), spill, marks([(27, 26), (28, 25)], "c"))
    f5 = Scene(body(), spill)
    return [(f0, 700), (f1, 380), (f2, 240), (f3, 220), (f4, 600), (f5, 1600)]


def anim_stamp():
    body = lambda **kw: cat(tail_side="left", **kw).shift(-3, 0)
    sh = (18.5, 21.0)
    sheet = lambda inked=False: paper(20, 27, 31, 31, lines=not inked, inked=inked)
    up = Scene(body(look=(1, 1)), sheet(), *hold_stamp(sh, 25, 14))
    mid = Scene(body(look=(1, 1)), sheet(), *hold_stamp(sh, 25, 21))
    down = Scene(body(eyes="closed", mouth="chew"), sheet(), *hold_stamp(sh, 25, 26),
                 marks([(19, 24), (19, 26), (31, 23), (31, 25)]))
    done = Scene(body(eyes="happy"), sheet(inked=True), *hold_stamp(sh, 26, 15))
    return [(up, 520), (mid, 110), (down, 380), (done, 1400)]


def anim_read():
    def f(look, eyes=None):
        c = cat(look=look, glasses=True) if eyes is None else cat(eyes=eyes, glasses=True)
        return Scene(c, paper(9, 18, 22, 30), paw(9.4, 21.2), paw(22.6, 21.2))
    return [(f((-1, 1)), 700), (f((0, 1)), 600), (f((1, 1)), 700), (f((0, 1)), 400), (f(None, "closed"), 140)]


def anim_happy():
    a = Scene(cat(eyes="happy", tail=-1), heart(24, 4), sparkle(6, 6))
    b = Scene(cat(eyes="happy", tail=1), heart(25, 2, big=False), heart(4, 9, big=False), sparkle(27, 11))
    return [(a, 360), (b, 360)]


def anim_sad():
    base = lambda: cat(eyes="sad", ears=.7, mouth="frown")
    return [(base(), 1400), (Scene(base(), marks([(12, 14)], "t")), 260),
            (Scene(base(), marks([(12, 15), (12, 16)], "t")), 260),
            (Scene(base(), marks([(12, 18)], "t")), 300)]


def anim_shrug():
    low = Scene(cat(eyes="sleepy", mouth="chew"), arm(9.5, 21.5, 5.0, 20.5), arm(22.5, 21.5, 27.0, 20.5))
    high = Scene(cat(eyes="closed", mouth="chew"), arm(9.5, 21.5, 3.6, 16.6), arm(22.5, 21.5, 28.4, 16.6),
                 marks([(1, 13), (2, 12), (30, 12), (31, 13)]))
    return [(low, 260), (high, 1300), (low, 260), (Scene(cat(eyes="sleepy", mouth="chew")), 1000)]


def anim_think():
    base = lambda: cat(look=(1, -1), mouth="chew")
    dot = lambda x: [(x, 3), (x + 1, 3), (x, 4), (x + 1, 4)]
    return [(Scene(base(), marks(dot(22))), 380), (Scene(base(), marks(dot(22) + dot(25))), 380),
            (Scene(base(), marks(dot(22) + dot(25) + dot(28))), 520), (base(), 260)]


def anim_peek():
    def f(look=None, eyes="open"):
        h = Frame()
        head(h, cy=25, eyes=eyes, look=look)
        h.fill = {p: r for p, r in h.fill.items() if p[1] <= 31}
        return Scene(h, paw(8.6, 30.9, 2.6, 1.6), paw(23.4, 30.9, 2.6, 1.6))
    return [(f(), 1600), (f(look=(-1, 0)), 900), (f(), 500), (f(look=(1, 0)), 900),
            (f(), 400), (f(eyes="closed"), 140)]


ANIMS = [
    ("idle", anim_idle), ("beret", anim_beret), ("wave", lambda: anim_wave(False)),
    ("bonjour", lambda: anim_wave(True)), ("search", anim_search), ("popcorn", anim_popcorn),
    ("spin", anim_spin), ("walk", anim_walk), ("sleep", anim_sleep), ("knock", anim_knock),
    ("stamp", anim_stamp), ("read", anim_read), ("happy", anim_happy), ("sad", anim_sad),
    ("shrug", anim_shrug), ("think", anim_think), ("peek", anim_peek),
]


def build():
    frames, manifest = [], {}
    for name, fn in ANIMS:
        seq = fn()
        idx, ms = [], []
        for fr, dur in seq:
            img = fr.render()
            # reuse identical frames so the sheet stays small
            key = img.tobytes()
            for i, (k, _) in enumerate(frames):
                if k == key:
                    idx.append(i)
                    break
            else:
                frames.append((key, img))
                idx.append(len(frames) - 1)
            ms.append(dur)
        manifest[name] = {"frames": idx, "ms": ms}
    return frames, manifest


def main(root):
    out_dir = os.path.join(root, "web", "assets", "pierre")
    os.makedirs(out_dir, exist_ok=True)
    os.makedirs(os.path.join(root, "docs"), exist_ok=True)
    frames, manifest = build()
    cols = 8
    rows = math.ceil(len(frames) / cols)
    sheet = Image.new("RGBA", (cols * 32, rows * 32), (0, 0, 0, 0))
    for i, (_, img) in enumerate(frames):
        sheet.alpha_composite(img, ((i % cols) * 32, (i // cols) * 32))
    sheet.save(os.path.join(out_dir, "pierre-mpa.png"), optimize=True)
    with open(os.path.join(out_dir, "pierre-mpa.json"), "w") as fh:
        json.dump({"image": "pierre-mpa.png", "size": 32, "cols": cols, "anims": manifest}, fh, indent=1)
        fh.write("\n")

    # preview: one row per animation, 4x, alternating light and dark rows
    scale, pad, label_w = 4, 6, 120
    longest = max(len(a["frames"]) for a in manifest.values())
    w = label_w + longest * (32 * scale + pad)
    h = len(manifest) * (32 * scale + pad) + pad
    prev = Image.new("RGBA", (w, h), (238, 240, 245, 255))
    draw = ImageDraw.Draw(prev)
    font = load_font("DejaVuSans-Bold.ttf", 15)
    for r, (name, a) in enumerate(manifest.items()):
        y = pad + r * (32 * scale + pad)
        draw.text((8, y + 56), name, fill=(30, 30, 36, 255), font=font)
        for c, i in enumerate(a["frames"]):
            x = label_w + c * (32 * scale + pad)
            bg = (205, 214, 228, 255) if r % 2 == 0 else (40, 44, 52, 255)
            prev.paste(Image.new("RGBA", (32 * scale, 32 * scale), bg), (x, y))
            prev.alpha_composite(frames[i][1].resize((32 * scale, 32 * scale), Image.NEAREST), (x, y))
    prev.save(os.path.join(root, "docs", "pierre-mpa-preview.png"), optimize=True)

    icons(root, frames, manifest)
    print(f"{len(frames)} frames, {len(manifest)} animations")


def load_font(name, size):
    for folder in ("/usr/share/fonts/truetype/google-fonts", "/usr/share/fonts/truetype/dejavu",
                   "/Library/Fonts", "/System/Library/Fonts/Supplemental"):
        try:
            return ImageFont.truetype(os.path.join(folder, name), size)
        except OSError:
            continue
    return ImageFont.load_default()


def gradient(w, h, stops):
    """Diagonal gradient through the given RGB stops."""
    img = Image.new("RGBA", (w, h))
    px = img.load()
    n = len(stops) - 1
    for y in range(h):
        for x in range(w):
            t = (x / w * .65 + y / h * .35)
            i = min(int(t * n), n - 1)
            u = t * n - i
            a, b = stops[i], stops[i + 1]
            px[x, y] = tuple(int(a[k] + (b[k] - a[k]) * u) for k in range(3)) + (255,)
    return img


def icons(root, frames, manifest):
    web = os.path.join(root, "web")
    beret_frame = frames[manifest["beret"]["frames"][0]][1]
    bonjour = frames[manifest["bonjour"]["frames"][0]][1]
    # favicon: just Pierre in his beret
    beret_frame.save(os.path.join(web, "favicon.png"))
    # apple touch icon: Pierre on a rounded dusk square
    size = 180
    bg = gradient(size, size, [(64, 56, 140), (206, 92, 140), (255, 176, 120)])
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size - 1, size - 1), 40, fill=255)
    icon = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    icon.paste(bg, (0, 0), mask)
    icon.alpha_composite(beret_frame.resize((160, 160), Image.NEAREST), (10, 14))
    icon.save(os.path.join(web, "apple-touch-icon.png"))
    # share card for links (WhatsApp, Discord, X...)
    W, H = 1200, 630
    card = gradient(W // 4, H // 4, [(40, 36, 96), (150, 70, 150), (240, 128, 120), (255, 196, 140)])
    card = card.resize((W, H), Image.BILINEAR)
    card.alpha_composite(bonjour.resize((448, 448), Image.NEAREST), (700, 120))
    d = ImageDraw.Draw(card)
    d.text((96, 150), "MPA", fill=(255, 255, 255, 255), font=load_font("Poppins-Bold.ttf", 190))
    d.text((102, 380), "Monsieur Pierre's ani-cli", fill=(255, 255, 255, 235), font=load_font("Poppins-Medium.ttf", 46))
    d.text((104, 452), "search \u00b7 find \u00b7 watch", fill=(255, 255, 255, 190), font=load_font("Poppins-Regular.ttf", 34))
    card.convert("RGB").save(os.path.join(web, "og-image.png"), optimize=True)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
