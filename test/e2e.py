"""Click through MPA in headless Chromium against the offline demo (node test/demo.mjs).

    pip install playwright && python -m playwright install chromium
    node test/demo.mjs &   python3 test/e2e.py [--shots docs/screenshots]

Checks: search, episode list, playback through the relay (HLS + AES key + subtitles),
skip intro, resume, the complaint desk filing an issue, the Cloudflare and missing-dub
states, and no console errors. Writes screenshots when --shots is given.
"""
import os
import sys
import time

from playwright.sync_api import sync_playwright, expect

BASE = os.environ.get("MPA_URL", "http://127.0.0.1:8787")
SHOTS = sys.argv[sys.argv.index("--shots") + 1] if "--shots" in sys.argv else None
if SHOTS:
    os.makedirs(SHOTS, exist_ok=True)

errors = []


def shot(page, name):
    if SHOTS:
        page.wait_for_timeout(350)
        page.screenshot(path=os.path.join(SHOTS, f"{name}.png"))


def watch_errors(page):
    page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
    page.on("console", lambda m: m.type == "error" and errors.append(f"console: {m.text}"))


def video_time(page):
    return page.evaluate("() => { const v = document.querySelector('video'); return v ? v.currentTime : -1 }")


def run_desktop(p, scheme="light"):
    browser = p.chromium.launch(args=["--autoplay-policy=no-user-gesture-required"])
    ctx = browser.new_context(viewport={"width": 1366, "height": 900}, color_scheme=scheme)
    page = ctx.new_page()
    watch_errors(page)
    suffix = "" if scheme == "light" else "-dark"

    page.goto(BASE + "/")
    expect(page.locator(".hero .bubble")).to_contain_text("Bonjour")
    expect(page.locator(".hero .pierre")).to_have_attribute("aria-label", "Monsieur Pierre, waving hello in his red beret")
    shot(page, f"home{suffix}")

    page.fill("#hero-q", "nap")
    page.press("#hero-q", "Enter")
    expect(page.locator(".grid .show")).to_have_count(4)
    expect(page.locator(".count")).to_have_text("4 shows")
    page.wait_for_function("() => [...document.querySelectorAll('.grid img')].every(i => i.complete && i.naturalWidth > 0)")
    shot(page, f"results{suffix}")

    page.click("text=Death Nap")
    expect(page.locator(".ep-grid .ep")).to_have_count(6)
    expect(page.locator("#anime-title")).to_have_text("Death Nap")
    expect(page.locator(".about")).to_contain_text("made-up show")
    expect(page.locator(".play")).to_have_text("Start episode 1")
    shot(page, f"anime{suffix}")

    page.click(".ep-grid .ep >> nth=0")
    page.wait_for_function("() => { const v = document.querySelector('video'); return v && v.currentTime > 0.8 }", timeout=30000)
    tracks = page.evaluate("() => [...document.querySelector('video').textTracks].map(t => [t.label, t.mode])")
    assert tracks == [["Español", "disabled"], ["English", "showing"]], tracks
    expect(page.locator("[data-quality] option")).to_have_count(3)
    expect(page.locator(".skip")).to_have_text("Skip intro", timeout=8000)
    expect(page.locator(".perch")).to_have_attribute("data-anim", "popcorn")
    shot(page, f"watch{suffix}")
    page.click(".skip")
    page.wait_for_function("() => document.querySelector('video').currentTime >= 5")
    assert page.locator(".skip").is_hidden()

    # quality switch to 360p keeps playing
    page.select_option("[data-quality]", label="360p")
    t0 = video_time(page)
    page.wait_for_function(f"() => document.querySelector('video').currentTime > {t0 + 0.8}", timeout=15000)

    # progress is remembered: go home, it's in Continue watching, and resuming picks up
    page.evaluate("() => document.querySelector('video').pause()")
    page.wait_for_timeout(300)
    page.click(".brand")
    expect(page.locator(".cw-title")).to_have_text("Death Nap")
    shot(page, f"home-continue{suffix}")
    page.click(".cw-link")
    expect(page.locator("#toasts .toast")).to_contain_text("Picked up at", timeout=20000)
    page.evaluate("() => document.querySelector('video').pause()")

    # complaint desk from the watch page
    page.click(".top .complain")
    expect(page.locator("#desk")).to_be_visible()
    expect(page.locator('#desk input[name="kind"][value="video"]')).to_be_checked()
    expect(page.locator("#desk [data-context]")).to_contain_text("ep: 1")
    page.fill("#desk textarea", f"Episode 1 skipped a beat around 0:03 ({scheme} run {int(time.time() * 1000)}). Also Pierre ate my popcorn.")
    shot(page, f"desk{suffix}")
    page.wait_for_timeout(1600)  # the desk ignores complaints sent faster than a human could type
    page.click("#desk [data-send]")
    expect(page.locator("#desk [data-done-title]")).to_contain_text("Filed as #", timeout=10000)
    shot(page, f"desk-filed{suffix}")
    page.click("#desk [data-done-actions] [data-close]")

    # Cloudflare wall
    page.goto(BASE + "/#/search?q=blocked")
    expect(page.locator(".problem h2")).to_have_text("Cloudflare stopped the worker at hianime's door")
    shot(page, f"blocked{suffix}")
    page.click(".problem [data-complain]")
    expect(page.locator('#desk input[name="kind"][value="search"]')).to_be_checked()
    expect(page.locator("#desk [data-context]")).to_contain_text("error: blocked")
    page.keyboard.press("Escape")

    # no dub for this show
    page.goto(BASE + "/#/watch/fullmetal-napper-202/1?mode=dub")
    expect(page.locator(".stage-msg .bubble")).to_contain_text("No dub for episode 1")
    page.click("text=Watch with subs")
    page.wait_for_function("() => { const v = document.querySelector('video'); return v && v.currentTime > 0.5 }", timeout=30000)

    # nothing found
    page.goto(BASE + "/#/search?q=zzzz")
    expect(page.locator(".empty-lead")).to_contain_text("Nothing called")
    shot(page, f"empty{suffix}")

    # backstage check
    page.click(".foot [data-backstage]")
    page.click("#backstage [data-check]")
    expect(page.locator("#backstage .status li")).to_have_count(4, timeout=10000)
    expect(page.locator("#backstage .status")).to_contain_text("Reachable, version")
    shot(page, f"backstage{suffix}")
    page.keyboard.press("Escape")

    # Pierre judges spicy searches (and still searches)
    page.goto(BASE + "/#/search?q=hentai")
    expect(page.locator(".judge .bubble")).to_have_text("I know what kind of man you are.")
    shot(page, f"judged{suffix}")
    page.goto(BASE + "/#/search?q=nap")
    expect(page.locator(".grid .show")).to_have_count(4)
    expect(page.locator(".judge")).to_have_count(0)

    # no internet: blame the internet, not the worker, and retry by itself when it's back
    page.goto(BASE + "/")
    ctx.set_offline(True)
    page.fill("#hero-q", "nap")
    page.press("#hero-q", "Enter")
    expect(page.locator(".problem h2")).to_have_text("Bro, your internet might be shit", timeout=15000)
    shot(page, f"offline{suffix}")
    ctx.set_offline(False)
    expect(page.locator(".grid .show")).to_have_count(4, timeout=15000)
    browser.close()


def run_mobile(p):
    browser = p.chromium.launch(args=["--autoplay-policy=no-user-gesture-required"])
    ctx = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
    page = ctx.new_page()
    watch_errors(page)
    page.goto(BASE + "/")
    expect(page.locator(".hero .bubble")).to_contain_text("Bonjour")
    shot(page, "m-home")
    page.fill("#hero-q", "a")
    page.press("#hero-q", "Enter")
    expect(page.locator(".grid .show").first).to_be_visible()
    page.wait_for_function("() => [...document.querySelectorAll('.grid img')].every(i => i.complete)")
    shot(page, "m-results")
    page.goto(BASE + "/#/anime/demon-napper-707")
    expect(page.locator(".ep-grid .ep")).to_have_count(26)
    shot(page, "m-anime")
    page.goto(BASE + "/#/watch/spy-x-kitty-303/2?mode=dub")
    page.wait_for_function("() => { const v = document.querySelector('video'); return v && v.currentTime > 0.5 }", timeout=30000)
    shot(page, "m-watch")
    width = page.evaluate("() => document.documentElement.scrollWidth")
    assert width <= 390, f"horizontal scroll on mobile: {width}px"
    browser.close()


with sync_playwright() as p:
    run_desktop(p, "light")
    run_desktop(p, "dark")
    run_mobile(p)

# expected API failures (the blocked search, the missing dub) show up as failed loads; the
# assertions above already check how the UI handles them
noise = [e for e in errors if "favicon" not in e and "Failed to load resource" not in e]
if noise:
    print("\n".join(noise))
    sys.exit(1)
print("e2e ok")
