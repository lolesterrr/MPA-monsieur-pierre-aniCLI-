// Where MPA's Cloudflare worker lives. After deploying the worker (see the README),
// replace the address below with yours, e.g. "https://mpa.lolesterrr.workers.dev".
window.MPA_CONFIG = {
  api: "https://mpa.YOUR-SUBDOMAIN.workers.dev",
  // Complaints fall back to a prefilled issue on this repo when the worker can't file them.
  repo: "lolesterrr/MPA-monsieur-pierre-aniCLI-",
};
