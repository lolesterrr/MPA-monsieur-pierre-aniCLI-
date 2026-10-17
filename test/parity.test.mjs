// Does the worker scrape the way ani-cli does? Runs the real ani-cli (pointed at the fake
// hianime) next to the worker and compares the links they come up with.
//
//   ANI_CLI=/path/to/ani-cli node --test test/parity.test.mjs
//
// Skipped when ani-cli isn't installed. Needs curl, sed, grep and fzf like ani-cli itself.
// In CI this runs against ani-cli's latest version, as an early warning: if ani-cli changes how
// it scrapes hianime, this fails and the worker needs the same change.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHandler } from "../worker/core.js";
import { startFake } from "./fake-hianime.mjs";

const run = promisify(execFile);

async function findAniCli() {
  if (process.env.ANI_CLI) return existsSync(process.env.ANI_CLI) ? process.env.ANI_CLI : null;
  try {
    const { stdout } = await run("sh", ["-c", "command -v ani-cli"]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

const ani = await findAniCli();

test("worker and ani-cli agree on search, episodes and stream links", { skip: !ani && "ani-cli not found (set ANI_CLI=/path/to/ani-cli)" }, async () => {
  const fake = await startFake({ ports: [0, 0, 0, 0] });
  try {
    const dir = mkdtempSync(join(tmpdir(), "mpa-parity-"));
    const source = readFileSync(ani, "utf8");
    assert.match(source, /base_api="https:\/\/hianime\.at"/, "ani-cli no longer scrapes hianime.at: the worker needs porting to the new source");
    const script = join(dir, "ani-cli");
    writeFileSync(script, source.replace('base_api="https://hianime.at"', `base_api="${fake.host.hianime}"`), { mode: 0o755 });
    const env = { ...process.env, ANI_CLI_PLAYER: "debug", TERM: "dumb", HOME: dir, XDG_STATE_HOME: dir, ANI_CLI_HIST_DIR: dir };

    const handle = createHandler();
    const workerEnv = { BASE_URL: fake.host.hianime, SIGNING_KEY: "parity" };
    const ask = async (path) => (await handle(new Request(`https://w.test${path}`), workerEnv)).json();

    for (const c of [
      { query: "attack on sofa", id: "attack-on-sofa-101", ep: "3", dub: false },
      { query: "spy x kitty", id: "spy-x-kitty-303", ep: "2", dub: true },
    ]) {
      const args = ["-S", "1", "-e", c.ep, ...(c.dub ? ["--dub"] : []), c.query];
      const { stdout } = await run("sh", [script, ...args], { env, timeout: 60000 });
      const links = stdout.split("All links:")[1].split("Selected link:")[0].trim().split("\n").map((l) => l.split(">")[1]);
      const subs = stdout.split("Subtitles:")[1].trim();

      const search = await ask(`/api/search?q=${encodeURIComponent(c.query)}`);
      assert.equal(search.results[0].id, c.id);
      const eps = await ask(`/api/episodes?id=${c.id}`);
      const epId = eps.episodes.find((e) => e.n === c.ep).id;
      const src = await ask(`/api/sources?id=${c.id}&epId=${epId}&mode=${c.dub ? "dub" : "sub"}`);
      const master = await (await handle(new Request(src.master), workerEnv)).text();
      const variants = master.split("\n").filter((l) => l.startsWith("https://w.test/p?")).map((l) => new URL(l).searchParams.get("u"));
      assert.deepEqual(variants, links, "variant links differ from ani-cli's");
      const defaultSub = src.subtitles.find((s) => s.default);
      assert.equal(new URL(defaultSub.url).searchParams.get("u"), subs, "default subtitle differs from ani-cli's");
    }
  } finally {
    await fake.stop();
  }
});
