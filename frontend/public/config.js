// Runtime configuration, loaded by index.html BEFORE the module bundle.
//
// This copy is a no-op placeholder: it only guarantees the file exists, so
// every deployment (dev server, Cloudflare Pages, any static host) serves a
// real script instead of a 404 or an HTML SPA fallback the browser refuses to
// execute.
//
// A deployment that deploys its OWN contract — a compose stack whose image was
// built long before it knew the address — REPLACES this file at container start
// with the address it just deployed:
//
//     window.SHIELDED_NIGHT = { UNDEPLOYED_ADDRESS: "0123…" };
//
// A stack whose local chain is a Midnight 2.x devnet also declares the ledger
// generation the "Local (undeployed)" network runs, so the page loads the v2
// adapter instead of the default v1 one:
//
//     window.SHIELDED_NIGHT = {
//       UNDEPLOYED_PROTOCOL: "midnight-2.x",
//       UNDEPLOYED_ADDRESS: "0123…",
//     };
//
// Per key, an injected value wins over the one baked in at build time from
// frontend/.env; a blank or absent value falls through to the build-time value.
// Keys: PREVIEW_ADDRESS, PREPROD_ADDRESS, STAGENET_ADDRESS, UNDEPLOYED_ADDRESS
// and UNDEPLOYED_PROTOCOL ("midnight-1.x" — the default — or "midnight-2.x";
// any other value is reported on the page instead of being guessed at).
// See src/lib/runtime-config.ts.
window.SHIELDED_NIGHT = window.SHIELDED_NIGHT || {};
