// Cloudflare entry point. Everything interesting is in core.js.
// Workers treat every export of this file as an entry point, so it exports only the handler.
import { createHandler } from "./core.js";

export default { fetch: createHandler() };
