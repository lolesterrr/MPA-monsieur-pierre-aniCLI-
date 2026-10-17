// Builds worker/dist/mpa-worker.js: core.js and the entry point in one file, for pasting
// into the Cloudflare dashboard's code editor. `npm run build` runs this; CI checks it's fresh.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const core = readFileSync(root + "worker/core.js", "utf8");
// Workers treat every export as an entry point, so drop the named exports
const body = core.replace(/^export (?=(async function|function|class|const|let)\b)/gm, "");
const out = `// MPA worker, single file. Generated from worker/core.js by tools/build-worker.mjs. Don't edit by hand.
// Paste this into Cloudflare: Workers & Pages -> your worker -> Edit code.
${body}
export default { fetch: createHandler() };
`;
const target = root + "worker/dist/mpa-worker.js";
if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(target, "utf8");
  } catch {
    /* missing */
  }
  if (current !== out) {
    console.error("worker/dist/mpa-worker.js is out of date. Run: npm run build");
    process.exit(1);
  }
  console.log("worker/dist/mpa-worker.js is up to date");
} else {
  writeFileSync(target, out);
  console.log("wrote worker/dist/mpa-worker.js");
}
