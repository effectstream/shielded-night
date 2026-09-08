import { describe, expect, it } from 'vitest';
import {
  CONTRACT_ASSET_NAME,
  contractAssetBaseUrl,
  requireAbsoluteUrl,
} from '../../frontend/protocols/shared/asset-url.js';

const PAGES_ORIGIN = 'https://shielded-night.pages.dev';

describe('contractAssetBaseUrl', () => {
  it('resolves each protocol profile against the page origin', () => {
    expect(contractAssetBaseUrl('v1', { origin: PAGES_ORIGIN }))
      .toBe(`${PAGES_ORIGIN}/contract/v1/shielded-night`);
    expect(contractAssetBaseUrl('v2', { origin: PAGES_ORIGIN }))
      .toBe(`${PAGES_ORIGIN}/contract/v2/shielded-night`);
  });

  it('exports the served asset name used by both profiles', () => {
    expect(CONTRACT_ASSET_NAME).toBe('shielded-night');
    expect(contractAssetBaseUrl('v1', { origin: PAGES_ORIGIN }))
      .toContain(`/${CONTRACT_ASSET_NAME}`);
  });

  it('treats a missing base and an explicit root base identically', () => {
    const implicit = contractAssetBaseUrl('v1', { origin: PAGES_ORIGIN });
    expect(contractAssetBaseUrl('v1', { origin: PAGES_ORIGIN, base: '/' })).toBe(implicit);
    expect(contractAssetBaseUrl('v1', { origin: PAGES_ORIGIN, base: undefined })).toBe(implicit);
  });

  it('honours a sub-path Vite base with or without a trailing slash', () => {
    expect(contractAssetBaseUrl('v1', { origin: PAGES_ORIGIN, base: '/app/' }))
      .toBe(`${PAGES_ORIGIN}/app/contract/v1/shielded-night`);
    expect(contractAssetBaseUrl('v1', { origin: PAGES_ORIGIN, base: '/app' }))
      .toBe(`${PAGES_ORIGIN}/app/contract/v1/shielded-night`);
    expect(contractAssetBaseUrl('v2', { origin: PAGES_ORIGIN, base: '/app' }))
      .toBe(`${PAGES_ORIGIN}/app/contract/v2/shielded-night`);
  });

  it('honours an absolute base (Vite allows a full URL, e.g. a CDN)', () => {
    expect(contractAssetBaseUrl('v1', { origin: PAGES_ORIGIN, base: 'https://cdn.example/site/' }))
      .toBe('https://cdn.example/site/contract/v1/shielded-night');
    expect(contractAssetBaseUrl('v2', { origin: PAGES_ORIGIN, base: 'https://cdn.example/site' }))
      .toBe('https://cdn.example/site/contract/v2/shielded-night');
  });

  it('resolves from the origin, never from the current page path', () => {
    // The SPA can be opened at a non-root route; the asset tree is still served
    // from the origin (plus base), so the deep route must not leak into the URL.
    const url = new URL('/swap/preprod/details?x=1#frag', PAGES_ORIGIN);
    expect(contractAssetBaseUrl('v1', { origin: url.origin }))
      .toBe(`${PAGES_ORIGIN}/contract/v1/shielded-night`);
  });

  it('produces a URL that survives the SDK check on http and https origins', () => {
    // FetchZkConfigProvider does `new URL(baseURL)` and then rejects anything
    // that is not http:/https:. Both forms must pass that check unchanged.
    for (const origin of ['http://127.0.0.1:12345', PAGES_ORIGIN]) {
      const resolved = contractAssetBaseUrl('v1', { origin });
      const parsed = new URL(resolved);
      expect(['http:', 'https:']).toContain(parsed.protocol);
      expect(parsed.href).toBe(resolved);
    }
    expect(contractAssetBaseUrl('v2', { origin: 'http://127.0.0.1:12345' }))
      .toBe('http://127.0.0.1:12345/contract/v2/shielded-night');
  });

  it('documents the deployed regression: the old relative path is not a URL', () => {
    // This is the exact 2026-09-08 production failure — the adapters passed
    // './contract/v1/shielded-night' straight to FetchZkConfigProvider, whose
    // `new URL(baseURL)` (no base argument) throws "Invalid URL".
    expect(() => new URL('./contract/v1/shielded-night')).toThrow();
    expect(() => new URL('./contract/v2/shielded-night')).toThrow();
  });

  it('rejects a non-http(s) origin with a descriptive error', () => {
    expect(() => contractAssetBaseUrl('v1', { origin: 'file:///x' }))
      .toThrow(/not an http or https URL/);
    expect(() => contractAssetBaseUrl('v1', { origin: 'file:///x' })).toThrow(Error);
  });

  it('rejects an unusable origin with a descriptive error', () => {
    expect(() => contractAssetBaseUrl('v1', { origin: 'not a url' }))
      .toThrow(/Cannot resolve the v1 proving-asset URL/);
  });
});

describe('requireAbsoluteUrl', () => {
  const HTTP = ['http:', 'https:'] as const;
  const WS = ['ws:', 'wss:'] as const;

  it('accepts the real public indexer endpoints', () => {
    const endpoints: ReadonlyArray<readonly [string, string]> = [
      ['https://indexer.preprod.midnight.network/api/v4/graphql', 'wss://indexer.preprod.midnight.network/api/v4/graphql/ws'],
      ['https://indexer.preview.midnight.network/api/v4/graphql', 'wss://indexer.preview.midnight.network/api/v4/graphql/ws'],
      ['https://indexer.stagenet.shielded.tools/api/v4/graphql', 'wss://indexer.stagenet.shielded.tools/api/v4/graphql/ws'],
    ];
    for (const [query, subscription] of endpoints) {
      expect(requireAbsoluteUrl(query, 'indexer URL', HTTP)).toBe(query);
      expect(requireAbsoluteUrl(subscription, 'indexer WebSocket URL', WS)).toBe(subscription);
    }
  });

  it('accepts plain http and ws endpoints and trims surrounding whitespace', () => {
    expect(requireAbsoluteUrl('http://127.0.0.1:12345/api/v4/graphql', 'indexer URL', HTTP))
      .toBe('http://127.0.0.1:12345/api/v4/graphql');
    expect(requireAbsoluteUrl('  ws://127.0.0.1:12345/api/v4/graphql/ws  ', 'indexer WebSocket URL', WS))
      .toBe('ws://127.0.0.1:12345/api/v4/graphql/ws');
  });

  it('rejects blank, missing, relative and wrong-scheme values with a labelled Error', () => {
    const rejected: readonly unknown[] = [undefined, null, '', '   ', '/api/v4/graphql', 'ftp://x', 42];
    for (const value of rejected) {
      let caught: unknown;
      try {
        requireAbsoluteUrl(value, 'indexer URL', HTTP);
      } catch (error) {
        caught = error;
      }
      expect(caught, `expected ${JSON.stringify(value)} to be rejected`).toBeInstanceOf(Error);
      // Not the SDK's bare "Failed to construct 'URL': Invalid URL" TypeError.
      expect(caught).not.toBeInstanceOf(TypeError);
      const message = (caught as Error).message;
      expect(message).toContain('indexer URL');
      // `JSON.stringify(undefined)` is `undefined`; the template literal in the
      // module renders it as the text "undefined", which is what the user sees.
      expect(message).toContain(String(JSON.stringify(value)));
      expect(message).toContain('http: or https:');
      expect(message).not.toContain('Invalid URL');
    }
  });

  it('rejects a websocket value where an http endpoint is required, and vice versa', () => {
    expect(() => requireAbsoluteUrl('wss://indexer.preprod.midnight.network/api/v4/graphql/ws', 'indexer URL', HTTP))
      .toThrow(/invalid indexer URL \("wss:\/\/indexer\.preprod\.midnight\.network\/api\/v4\/graphql\/ws"\)/);
    expect(() => requireAbsoluteUrl('https://indexer.preprod.midnight.network/api/v4/graphql', 'indexer WebSocket URL', WS))
      .toThrow(/invalid indexer WebSocket URL/);
  });

  it('names the WebSocket field when the wallet returns a blank subscription URL', () => {
    // Spec US3: a blank indexerWsUri must produce an actionable message.
    expect(() => requireAbsoluteUrl('', 'indexer WebSocket URL', WS))
      .toThrow('The wallet returned an invalid indexer WebSocket URL (""); expected an absolute ws: or wss: URL.');
  });
});
