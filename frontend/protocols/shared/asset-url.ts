/**
 * Absolute URLs for the served proving-asset trees, and labelled validation of
 * wallet-supplied endpoints.
 *
 * WHY THIS EXISTS: the Midnight SDK validates the base URL it is given with a
 * bare `new URL(baseURL)` — no second (base) argument — inside
 * `FetchZkConfigProvider` (`@midnight-ntwrk/midnight-js-fetch-zk-config-provider`
 * 4.1.1 and 5.0.0-beta.7) and inside `indexerPublicDataProvider`. A relative
 * string such as `'./contract/v1/shielded-night'` therefore throws the browser
 * `TypeError: Failed to construct 'URL': Invalid URL` before any network work
 * starts. That is exactly what the deployed site did on 2026-09-08: selecting
 * Preprod and pressing Connect wallet produced `Connection failed: Failed to
 * construct 'URL': Invalid URL`, because the multi-network adapters passed the
 * relative path straight to the provider.
 *
 * The resolution must come from the page ORIGIN plus the Vite base path, never
 * from the current page path, so that the SPA opened at a non-root route still
 * points at the same served asset tree.
 *
 * This module is deliberately dependency-free: no `import.meta.env`, no
 * `window` access at module level, no imports at all. The root unit tier runs
 * it under plain Node, and the callers pass `window.location.origin` and
 * `import.meta.env.BASE_URL` in.
 */

export type AssetProfile = 'v1' | 'v2';

export const CONTRACT_ASSET_NAME = 'shielded-night';

export interface AssetBaseUrlContext {
  /** Absolute origin of the page, e.g. `window.location.origin`. */
  origin: string;
  /** Vite base path (`import.meta.env.BASE_URL`); defaults to `'/'`. */
  base?: string;
}

/**
 * Absolute `http(s)` URL of the proving-asset tree for one protocol profile.
 *
 * `base` may be a path (`'/'`, `'/app'`, `'/app/'`) or a full URL
 * (Vite allows an absolute base, e.g. a CDN); a missing trailing slash is
 * added so the profile segment is appended rather than replacing the last
 * path segment.
 */
export function contractAssetBaseUrl(
  profile: AssetProfile,
  { origin, base }: AssetBaseUrlContext,
): string {
  const rawBase = typeof base === 'string' && base.trim() !== '' ? base.trim() : '/';
  const normalizedBase = rawBase.endsWith('/') ? rawBase : `${rawBase}/`;
  const path = `${normalizedBase}contract/${profile}/${CONTRACT_ASSET_NAME}`;

  let resolved: URL;
  try {
    resolved = new URL(path, origin);
  } catch {
    throw new Error(
      `Cannot resolve the ${profile} proving-asset URL from origin ${JSON.stringify(origin)} `
      + `and base ${JSON.stringify(rawBase)}; expected an absolute http or https origin.`,
    );
  }
  if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
    throw new Error(
      `The ${profile} proving-asset URL resolved to ${JSON.stringify(resolved.href)}, `
      + `which is not an http or https URL; the proving-asset provider requires one.`,
    );
  }
  return resolved.href;
}

/**
 * Returns `value` trimmed when it is an absolute URL with one of `protocols`.
 *
 * Throws a descriptive `Error` naming the field and the received value
 * otherwise — never the SDK's bare `TypeError: Failed to construct 'URL':
 * Invalid URL`, which gives the user nothing to act on.
 */
export function requireAbsoluteUrl(
  value: unknown,
  label: string,
  protocols: readonly string[],
): string {
  const invalid = () => new Error(
    `The wallet returned an invalid ${label} (${JSON.stringify(value)}); `
    + `expected an absolute ${protocols.join(' or ')} URL.`,
  );
  if (typeof value !== 'string') throw invalid();
  const trimmed = value.trim();
  if (trimmed === '') throw invalid();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw invalid();
  }
  if (!protocols.includes(parsed.protocol)) throw invalid();
  return trimmed;
}
