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
 * The same lane carries `UNDEPLOYED_PROTOCOL` — the ledger generation the local
 * `undeployed` network runs (`midnight-1.x`, the default, or `midnight-2.x`).
 * A stack that brings up a Midnight 2.x devnet writes it next to the address:
 *
 *     window.SHIELDED_NIGHT = { UNDEPLOYED_PROTOCOL: "midnight-2.x", UNDEPLOYED_ADDRESS: "0123…" };
 *
 * Contract addresses and that protocol switch are the only injectable settings.
 * The wallet still supplies the indexer / node / proof-server URLs
 * (`getConfiguration()`), so a stack on non-default ports needs no URL override
 * lane in the page.
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
  | 'STAGENET_ADDRESS'
  | 'UNDEPLOYED_ADDRESS';

/**
 * The protocol switch for the local `undeployed` network (build-time env AND
 * runtime config share the name). The public networks are pinned to a ledger
 * generation by the chain they are, so only `undeployed` has a switch.
 */
export type ProtocolVar = 'UNDEPLOYED_PROTOCOL';

/** The two ledger generations the app carries an adapter for. */
export type ProtocolFamilyName = 'midnight-1.x' | 'midnight-2.x';

/** Accepted `UNDEPLOYED_PROTOCOL` values, in the order the error message lists them. */
export const PROTOCOL_FAMILIES: readonly ProtocolFamilyName[] = ['midnight-1.x', 'midnight-2.x'];

/** What `undeployed` is without any setting — today's behaviour, unchanged. */
export const DEFAULT_UNDEPLOYED_PROTOCOL: ProtocolFamilyName = 'midnight-1.x';

/** Shape of `window.SHIELDED_NIGHT`. Every key optional: inject only what the deployment knows. */
export type ShieldedNightRuntimeConfig = Partial<Record<ContractAddressVar | ProtocolVar, string>>;

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

const isProtocolFamily = (value: string): value is ProtocolFamilyName =>
  (PROTOCOL_FAMILIES as readonly string[]).includes(value);

/** A resolved protocol family, or the message explaining why the value was rejected. */
export type UndeployedProtocolResolution =
  | { readonly family: ProtocolFamilyName; readonly error?: undefined }
  | { readonly family?: undefined; readonly error: string };

/**
 * Ledger generation for the local `undeployed` network: the runtime-injected
 * `UNDEPLOYED_PROTOCOL` if present and non-blank, else the build-time one, else
 * `midnight-1.x` (what `undeployed` has always been). Values are trimmed and
 * case-sensitive; anything else is an ERROR naming the variable and both
 * accepted values — never a silent fallback, because a wrong guess here loads
 * the wrong ledger adapter against a real chain.
 */
export const resolveUndeployedProtocol = (
  buildTimeValue: string | undefined,
  host: RuntimeConfigHost | undefined = typeof window === 'undefined' ? undefined : window,
): UndeployedProtocolResolution => {
  const value = nonEmpty(runtimeConfig(host)?.UNDEPLOYED_PROTOCOL) ?? nonEmpty(buildTimeValue);
  if (value === undefined) return { family: DEFAULT_UNDEPLOYED_PROTOCOL };
  if (isProtocolFamily(value)) return { family: value };
  const shown = value.length > 40 ? `${value.slice(0, 40)}…` : value;
  return {
    error: `UNDEPLOYED_PROTOCOL must be ${PROTOCOL_FAMILIES.map((f) => `"${f}"`).join(' or ')}; got "${shown}".`,
  };
};
