// Offline demo: the fake hianime plus the local helper wired to it.
//   node test/demo.mjs        then open http://127.0.0.1:8787
// Everything is made up (shows, posters, the stream), so it works with no internet at all.
import { startFake } from "./fake-hianime.mjs";
import { startLocal } from "../local/server.mjs";

const port = Number(process.env.PORT) || 8787;
const fake = await startFake({ ports: [0, 0, 0, 0] });
const app = await startLocal({
  port,
  env: {
    BASE_URL: fake.host.hianime,
    GITHUB_API: fake.host.mocks,
    ANISKIP_URL: fake.host.mocks,
    GITHUB_TOKEN: process.env.DEMO_NO_TOKEN ? "" : "test-github-token",
    COMPLAINTS_PER_10_MIN: "1000",
  },
});
console.log(`MPA demo on ${app.url} (fake hianime at ${fake.host.hianime})`);
process.on("SIGINT", async () => {
  await app.close();
  await fake.stop();
  process.exit(0);
});
