"""Procedural pixel art for Monsieur Pierre, the lazy cat: a fat black-and-white (tuxedo) cat,
laid out in the oneko.js 256x128 sheet so the app can use it unchanged.

Usage (needs Pillow):
    python3 tools/makepierre.py Resources/pierre.png tuxedo
    python3 tools/makepierre.py Resources/pierre-cow.png cow
Also writes <name>-gaze.png (the sitting cat looking N, NE, E, SE, S, SW, W,
NW, for the chaser's gaze) and <name>-light.png / <name>-dark.png previews
at 4x; delete the previews or write somewhere else if you only want sheets."""
import sys, math
from PIL import Image

PAL = {
    "o": (20, 20, 24, 255),     # outline
    "k": (58, 58, 66, 255),     # black fur
    "w": (250, 250, 247, 255),  # white fur
    "g": (205, 205, 212, 255),  # white fur shade
    "p": (240, 150, 170, 255),  # nose / inner ear
    "e": (196, 222, 72, 255),   # eye
    "z": (20, 20, 24, 255),     # loose marks (zzz, motion lines), no outline pass
}

def ell(cx, cy, rx, ry):
    return lambda x, y: ((x + .5 - cx) / rx) ** 2 + ((y + .5 - cy) / ry) ** 2 <= 1

def tri(a, b, c):
    def s(p, q, r): return (p[0]-r[0])*(q[1]-r[1]) - (q[0]-r[0])*(p[1]-r[1])
    def f(x, y):
        p = (x + .5, y + .5)
        d1, d2, d3 = s(p, a, b), s(p, b, c), s(p, c, a)
        return not ((d1 < 0 or d2 < 0 or d3 < 0) and (d1 > 0 or d2 > 0 or d3 > 0))
    return f

def rect(x0, y0, x1, y1):
    return lambda x, y: x0 <= x <= x1 and y0 <= y <= y1

class Frame:
    def __init__(self):
        self.fill = {}      # (x,y) -> role, painter order
        self.marks = {}     # drawn after outline
    def add(self, shape, role, solid=True):
        for y in range(32):
            for x in range(32):
                if shape(x, y):
                    if solid or (x, y) in self.fill:
                        self.fill[(x, y)] = role
        return self
    def paint(self, shape, role):   # recolor inside existing body only
        return self.add(shape, role, solid=False)
    def px(self, pts, role):
        for p in pts: self.marks[p] = role
        return self
    def flip(self):
        f = Frame()
        f.fill = {(31 - x, y): r for (x, y), r in self.fill.items()}
        f.marks = {(31 - x, y): r for (x, y), r in self.marks.items()}
        return f
    def shift(self, dx, dy):
        f = Frame()
        f.fill = {(x + dx, y + dy): r for (x, y), r in self.fill.items() if 0 <= x+dx < 32 and 0 <= y+dy < 32}
        f.marks = {(x + dx, y + dy): r for (x, y), r in self.marks.items() if 0 <= x+dx < 32 and 0 <= y+dy < 32}
        return f
    def render(self):
        img = Image.new("RGBA", (32, 32), (0, 0, 0, 0))
        body = set(self.fill)
        for (x, y), r in self.fill.items():
            edge = any((x+dx, y+dy) not in body for dx, dy in ((1,0),(-1,0),(0,1),(0,-1)))
            img.putpixel((x, y), PAL["o" if edge else r])
        for p, r in self.marks.items():
            if 0 <= p[0] < 32 and 0 <= p[1] < 32:
                img.putpixel(p, PAL[r])
        return img

# ---------- poses ----------

STYLE = "tuxedo"   # tuxedo: black body, white bib. cow: white body, black head and patches

def B():
    return "k" if STYLE == "tuxedo" else "w"

def patch(f, cx, cy, rx, ry):
    if STYLE == "cow":
        f.paint(ell(cx, cy, rx, ry), "k")

def head_front(f, cx=16, cy=13, eyes="open", ears=1.0, look=None):
    e = 6 * ears
    f.add(tri((cx-7, cy-1), (cx-6, cy-e-1), (cx-2, cy-4)), "k")
    f.add(tri((cx+7, cy-1), (cx+6, cy-e-1), (cx+2, cy-4)), "k")
    f.add(ell(cx, cy, 8, 6.2), "k")
    f.paint(tri((cx-5.5, cy-2), (cx-5.5, cy-e+.5), (cx-3, cy-3.5)), "p")
    f.paint(tri((cx+5.5, cy-2), (cx+5.5, cy-e+.5), (cx+3, cy-3.5)), "p")
    f.paint(ell(cx, cy+3, 4.6, 3.2), "w")          # muzzle
    f.paint(tri((cx-1, cy+1), (cx+1, cy+1), (cx, cy-5)), "w")  # blaze
    ex = (cx-4, cx+3)
    if look is not None:
        # Pupils toward (gx, gy): image coordinates, so gy < 0 looks up.
        gx, gy = look
        for x in ex:
            f.px([(x, cy-1), (x+1, cy-1), (x, cy), (x+1, cy)], "e")
            px_ = x + (1 if gx > 0 else 0 if gx < 0 else (1 if x < cx else 0))
            f.px([(px_, cy - 1 if gy < 0 else cy)], "o")
    elif eyes == "open":
        for x in ex:
            f.px([(x, cy-1), (x+1, cy-1), (x, cy), (x+1, cy)], "e")
            f.px([(x + (1 if x < cx else 0), cy)], "o")
    elif eyes == "wide":
        for x in ex:
            f.px([(x, cy-2), (x+1, cy-2), (x, cy-1), (x+1, cy-1), (x, cy), (x+1, cy)], "e")
            f.px([(x + (1 if x < cx else 0), cy-1)], "o")
    elif eyes == "sleepy":
        for x in ex:
            f.px([(x, cy), (x+1, cy)], "o")
            f.px([(x, cy-1), (x+1, cy-1)], "e")
    else:  # closed
        for x in ex:
            f.px([(x, cy), (x+1, cy)], "o")
    f.px([(cx-1, cy+2), (cx, cy+2)], "p")
    f.px([(cx-2, cy+3), (cx-1, cy+4), (cx, cy+4), (cx+1, cy+3)], "o")

def sit(eyes="open", ears=1.0, raise_paw=None, look=None):
    f = Frame()
    f.add(ell(26, 28.5, 4.5, 2.6), B())                   # tail wrapped round
    f.add(ell(16, 24, 11, 8.2), B())                      # big round body
    f.paint(ell(16, 25.5, 6.5, 6.5), "w")                 # belly
    patch(f, 7, 22, 3.5, 4); patch(f, 25, 26, 3, 3)
    f.add(ell(11.5, 30, 3, 1.8), "w")                     # paws
    f.add(ell(20.5, 30, 3, 1.8), "w")
    head_front(f, eyes=eyes, ears=ears, look=look)
    if raise_paw:
        f.add(ell(*raise_paw, 2.2, 3), "w")
    return f

def side(step, head_dy=0):
    """Walking to the right (E). step 0/1 alternates the legs."""
    f = Frame()
    f.add(ell(3.5, 15, 2.2, 4.5), B())                    # tail up
    f.add(ell(5, 19.5, 2.4, 2.6), B())
    a, b = (0, 1) if step == 0 else (1, 0)
    for lx, dl in ((7, a), (11, b), (17, a), (21, b)):    # stubby legs
        f.add(rect(lx - 1 + dl, 26, lx + 1 + dl, 29), B())
        f.add(rect(lx - 1 + dl, 29, lx + 2 + dl, 30), "w")
    f.add(ell(14.5, 20.5, 11, 8), B())                    # round body
    f.paint(ell(15, 26, 8, 3.5), "w")                     # belly
    patch(f, 12, 17, 5, 3.5); patch(f, 3.5, 13, 3, 3)
    hy = 15 + head_dy
    f.add(tri((20.5, hy-3), (21.5, hy-9.5), (25.5, hy-5)), "k")
    f.add(tri((26, hy-5), (28.5, hy-9.5), (30, hy-3)), "k")
    f.add(ell(25, hy, 6.5, 5.8), "k")
    f.paint(tri((26.8, hy-4.6), (28.4, hy-8), (29.2, hy-4)), "p")
    f.paint(ell(28.2, hy+2.6, 3.4, 2.8), "w")             # muzzle and chin
    f.paint(ell(23.5, hy+5.2, 3.6, 2.4), "w")             # bib
    f.px([(26, hy-1), (27, hy-1), (27, hy)], "e"); f.px([(26, hy)], "o")
    f.px([(30, hy+1)], "p"); f.px([(28, hy+3), (29, hy+3)], "o")
    return f

def back(step):
    """Walking away (N): back view, tail up."""
    f = Frame()
    a, b = (0, 1) if step == 0 else (1, 0)
    f.add(ell(11, 29 - a, 2.6, 2), B()); f.add(ell(21, 29 - b, 2.6, 2), B())
    f.add(ell(16, 22, 10.5, 7.5), B())
    f.add(ell(16, 12.5, 7.5, 5.8), "k")
    f.add(tri((9, 11), (10, 5), (14, 8)), "k"); f.add(tri((23, 11), (22, 5), (18, 8)), "k")
    f.add(ell(25.5, 17, 2, 5), B())                       # tail up on the right
    f.add(ell(24, 22, 2.2, 2.2), B())
    f.paint(ell(16, 27.5, 5, 2.4), "w")
    patch(f, 12, 20, 4, 3.5); patch(f, 25.5, 13, 3, 3)
    return f

def front_walk(step):
    """Walking toward the viewer (S)."""
    f = sit()
    a = 1 if step == 0 else -1
    for (x, y), r in list(f.fill.items()):
        if y >= 29 and r == "w":
            del f.fill[(x, y)]
    f.add(ell(11.5, 30 - (1 if a > 0 else 0), 3, 1.8), "w")
    f.add(ell(20.5, 30 - (1 if a < 0 else 0), 3, 1.8), "w")
    return f

def sleeping(n):
    """Curled-up loaf, breathing (n = 0/1)."""
    f = Frame()
    r = 0.6 * n
    f.add(ell(17.5, 24.5 - r / 2, 12, 7.5 + r), B())      # the loaf
    f.paint(ell(21, 28.5, 6.5, 2.6), "w")
    patch(f, 22, 20, 5, 3.5)
    f.add(tri((5, 21), (5.5, 14.5), (9.5, 18.5)), "k")    # head resting on the left
    f.add(tri((11, 18.5), (14, 14.5), (14.5, 20)), "k")
    f.add(ell(10, 22.5, 6.2, 5), "k")
    f.paint(tri((6.2, 19.5), (6.4, 16.2), (8.6, 18.6)), "p")
    f.paint(tri((12.2, 18.6), (13.4, 16.2), (13.6, 19.2)), "p")
    f.paint(ell(10, 25, 3.8, 2.4), "w")
    f.px([(6, 22), (7, 22)], "o"); f.px([(12, 22), (13, 22)], "o")
    f.px([(9, 24), (10, 24)], "p")
    f.add(ell(21, 30.3, 8, 1.4), B())                     # tail round the front
    small = [(22, 9), (23, 9), (24, 9), (23, 10), (22, 11), (23, 11), (24, 11)]
    big = [(25, 3), (26, 3), (27, 3), (28, 3), (27, 4), (26, 5), (25, 6), (26, 6), (27, 6), (28, 6)]
    f.px(small if n == 0 else small + big, "z")
    return f

def scratch_wall(step, direction):
    """Standing up on hind legs, paws on the wall above (N) — other walls
    reuse rotated poses below."""
    f = Frame()
    f.add(ell(11.5, 30, 3, 1.8), "w"); f.add(ell(20.5, 30, 3, 1.8), "w")
    f.add(ell(16, 22, 9.5, 8.5), B())
    f.paint(ell(16, 23, 5.5, 6.5), "w")
    head_front(f, cy=11, eyes="closed")
    a, b = (0, 2) if step == 0 else (2, 0)
    f.add(ell(6.5, 10 + a, 2, 2.4), "w"); f.add(ell(25.5, 10 + b, 2, 2.4), "w")
    return f

def build():
    F = {}
    F["idle"] = [sit()]
    F["alert"] = [sit(eyes="wide", ears=1.25)]
    F["alert"][0].px([(3, 6), (4, 7), (28, 6), (27, 7), (3, 12), (4, 12), (28, 12), (27, 12)], "z")
    F["tired"] = [sit(eyes="sleepy", ears=0.8)]
    F["sleeping"] = [sleeping(0), sleeping(1)]
    F["scratchSelf"] = [sit(eyes="closed", raise_paw=(23, 18)),
                        sit(eyes="closed", raise_paw=(23, 16)),
                        sit(eyes="closed", raise_paw=(22, 17))]
    F["scratchWallN"] = [scratch_wall(0, "N"), scratch_wall(1, "N")]
    F["scratchWallS"] = [sit(eyes="closed", raise_paw=(10, 27)), sit(eyes="closed", raise_paw=(22, 27))]
    F["scratchWallE"] = [side(0).shift(1, 0), side(1).shift(1, 0)]
    F["scratchWallW"] = [side(0).flip().shift(-1, 0), side(1).flip().shift(-1, 0)]
    F["E"] = [side(0), side(1)]
    F["W"] = [side(0).flip(), side(1).flip()]
    F["NE"] = [side(0, -1), side(1, -1)]
    F["NW"] = [side(0, -1).flip(), side(1, -1).flip()]
    F["SE"] = [side(0, 1), side(1, 1)]
    F["SW"] = [side(0, 1).flip(), side(1, 1).flip()]
    F["N"] = [back(0), back(1)]
    F["S"] = [front_walk(0), front_walk(1)]
    return F

# Gaze strip: sitting and looking toward the cursor, in this order.
GAZE = [("N", 0, -1), ("NE", 1, -1), ("E", 1, 0), ("SE", 1, 1),
        ("S", 0, 1), ("SW", -1, 1), ("W", -1, 0), ("NW", -1, -1)]

GRID = {
    "idle": [(3, 3)], "alert": [(7, 3)], "tired": [(3, 2)],
    "sleeping": [(2, 0), (2, 1)], "scratchSelf": [(5, 0), (6, 0), (7, 0)],
    "scratchWallN": [(0, 0), (0, 1)], "scratchWallS": [(7, 1), (6, 2)],
    "scratchWallE": [(2, 2), (2, 3)], "scratchWallW": [(4, 0), (4, 1)],
    "N": [(1, 2), (1, 3)], "NE": [(0, 2), (0, 3)], "E": [(3, 0), (3, 1)],
    "SE": [(5, 1), (5, 2)], "S": [(6, 3), (7, 2)], "SW": [(5, 3), (6, 1)],
    "W": [(4, 2), (4, 3)], "NW": [(1, 0), (1, 1)],
}

if __name__ == "__main__":
    out = sys.argv[1]
    STYLE = sys.argv[2] if len(sys.argv) > 2 else "tuxedo"
    F = build()
    sheet = Image.new("RGBA", (256, 128), (0, 0, 0, 0))
    for name, cells in GRID.items():
        for i, (c, r) in enumerate(cells):
            sheet.alpha_composite(F[name][i].render(), (c * 32, r * 32))
    sheet.save(out)
    gaze = Image.new("RGBA", (256, 32), (0, 0, 0, 0))
    for i, (_, gx, gy) in enumerate(GAZE):
        gaze.alpha_composite(sit(look=(gx, gy)).render(), (i * 32, 0))
    gaze.save(out.replace(".png", "-gaze.png"))
    for bgc, suffix in (((205, 214, 228, 255), "light"), ((40, 44, 52, 255), "dark")):
        big = sheet.resize((1024, 512), Image.NEAREST)
        bg = Image.new("RGBA", big.size, bgc); bg.alpha_composite(big)
        bg.save(out.replace(".png", f"-{suffix}.png"))
