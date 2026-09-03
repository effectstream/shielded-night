/**
 * Runtime (post-build) configuration for the SPA.
 *
 * Contract addresses are normally BAKED IN at build time, one env var per
 * network (`<NETWORK>_ADDRESS`, exposed through vite.config's `envPrefix` — see
 * networks.ts). That is right for the hosted deployments: their addresses are
 * known when the bundle is built and live in `frontend/.env` in git history.
 *
 * It is not enough for a deployment that brings up its OWN chain — a docker
 * image built once and run against many throwaway local devnets only learns the
 * contract address when the container starts. Such a deployment writes a tiny
 * script served BEFORE the module bundle:
 *
 *     <!-- index.html -->
 *     <script src="/config.js"></script>
 *
 *     // /config.js, written at container start
 *     window.SHIELDED_NIGHT = { UNDEPLOYED_ADDRESS: "0123…" };
 *
 * and that value wins over the build-time one for that network. With no global
 * present nothing changes: the build-time values are used exactly as before, so
 * this is backward compatible for every existing build and deployment.
 *
 * Only contract addresses are injectable. The wallet still supplies the
 * indexer / node / proof-server URLs (`getConfiguration()`), so a stack on
 * non-default ports needs no URL override lane in the page.
 *
 * GREP MARKER: the literal `SHIELDED_NIGHT` is a property name on `window`, so
 * it survives minification and appears verbatim in the built bundle. A
 * packaging step that injects `/config.js` can therefore `grep -q
 * SHIELDED_NIGHT dist/assets/*.js` to prove the override lane is still present
 * in the build it is about to ship, instead of trusting it.
 */

/** The `window` property the runtime config is read from. */
export const RUNTIME_CONFIG_GLOBAL = 'SHIELDED_NIGHT';

/** The per-network contract-address variable names (build-time env AND runtime config share them). */
export type ContractAddressVar =
  | 'PREVIEW_ADDRESS'
  | 'PREPROD_ADDRESS'
  | 'MAINNET_ADDRESS'
  | 'UNDEPLOYED_ADDRESS';

/** Shape of `window.SHIELDED_NIGHT`. Every key optional: inject only what the deployment knows. */
export type ShieldedNightRuntimeConfig = Partial<Record<ContractAddressVar, string>>;

declare global {
  interface Window {
    /** Injected before the module bundle (see the module docstring); absent in a plain build. */
    SHIELDED_NIGHT?: ShieldedNightRuntimeConfig;
  }
}

/** Anything carrying the global — `window` in the browser, a stub in tests. */
export interface RuntimeConfigHost {
  SHIELDED_NIGHT?: ShieldedNightRuntimeConfig;
}

/** Trim and treat blank as absent, so an injected `""` falls through to the build-time value. */
const nonEmpty = (v: unknown): string | undefined => {
  const s = typeof v === 'string' ? v.trim() : '';
  return s.length > 0 ? s : undefined;
};

/** The injected config, or undefined when there is no browser global (SSR, tests, plain build). */
export const runtimeConfig = (
  host: RuntimeConfigHost | undefined = typeof window === 'undefined' ? undefined : window,
): ShieldedNightRuntimeConfig | undefined => {
  const cfg = host?.SHIELDED_NIGHT;
  return cfg != null && typeof cfg === 'object' ? cfg : undefined;
};

/**
 * Contract address for one network: the runtime-injected value if present and
 * non-blank, else the build-time one. `host` exists for tests; production code
 * passes nothing and reads `window`.
 */
export const resolveContractAddress = (
  key: ContractAddressVar,
  buildTimeValue: string | undefined,
  host: RuntimeConfigHost | undefined = typeof window === 'undefined' ? undefined : window,
): string | undefined => nonEmpty(runtimeConfig(host)?.[key]) ?? nonEmpty(buildTimeValue);
