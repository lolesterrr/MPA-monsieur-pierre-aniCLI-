// What the app is doing right now, so a complaint can say where it came from.
export const state = {
  route: "#/",
  current: null, // { id, title, ep, mode }
  lastError: null, // { code, message, at }
};

export function noteError(err) {
  state.lastError = err ? { code: err.code || "error", message: String(err.message || err).slice(0, 300), at: Date.now() } : null;
}
