/**
 * The SPA's runtime contract-address override (frontend/src/lib/runtime-config.ts).
 *
 * A deployment that brings up its own chain injects
 * `window.SHIELDED_NIGHT = { UNDEPLOYED_ADDRESS: "…" }` before the module
 * bundle, and that value must win over the address baked in at build time —
 * while a build with no such global keeps behaving exactly as before. These
 * are the two claims the packaging of this dApp into a compose stack depends
 * on, so they are pinned here rather than left to the browser. The same lane
 * carries `UNDEPLOYED_PROTOCOL` (which ledger generation the local network
 * runs), pinned in the second block below.
 *
 * Lives in the ROOT unit tier (not the frontend package) because
 * runtime-config.ts is deliberately dependency-free and free of
 * `import.meta.env`, so it runs under the existing `bun run test:unit`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_UNDEPLOYED_PROTOCOL,
  PROTOCOL_FAMILIES,
  RUNTIME_CONFIG_GLOBAL,
  resolveContractAddress,
  resolveUndeployedProtocol,
  runtimeConfig,
  type RuntimeConfigHost,
} from '../../frontend/src/lib/runtime-config.js';

const BUILD_TIME = 'b'.repeat(64);
const INJECTED = 'a'.repeat(64);

/** Stand-in for `window` (these tests run under the node environment). */
const host = (cfg: RuntimeConfigHost['SHIELDED_NIGHT']): RuntimeConfigHost => ({ SHIELDED_NIGHT: cfg });

const globalScope = globalThis as { window?: unknown };

afterEach(() => {
  delete globalScope.window;
});

describe('runtime contract-address override', () => {
  it('names the injected global SHIELDED_NIGHT (the marker downstream images grep for)', () => {
    expect(RUNTIME_CONFIG_GLOBAL).toBe('SHIELDED_NIGHT');
  });

  it('falls back to the build-time address when nothing is injected', () => {
    expect(resolveContractAddress('UNDEPLOYED_ADDRESS', BUILD_TIME, undefined)).toBe(BUILD_TIME);
    expect(resolveContractAddress('UNDEPLOYED_ADDRESS', BUILD_TIME, {})).toBe(BUILD_TIME);
    expect(resolveContractAddress('PREVIEW_ADDRESS', BUILD_TIME, host({}))).toBe(BUILD_TIME);
  });

  it('prefers the injected address over the build-time one', () => {
    expect(
      resolveContractAddress('UNDEPLOYED_ADDRESS', BUILD_TIME, host({ UNDEPLOYED_ADDRESS: INJECTED })),
    ).toBe(INJECTED);
  });

  it('injects per network — other networks keep their build-time address', () => {
    const h = host({ UNDEPLOYED_ADDRESS: INJECTED });
    expect(resolveContractAddress('PREVIEW_ADDRESS', BUILD_TIME, h)).toBe(BUILD_TIME);
    expect(resolveContractAddress('PREVIEW_ADDRESS', undefined, h)).toBeUndefined();
  });

  it('treats a blank or whitespace-only injected value as absent', () => {
    expect(resolveContractAddress('UNDEPLOYED_ADDRESS', BUILD_TIME, host({ UNDEPLOYED_ADDRESS: '' }))).toBe(
      BUILD_TIME,
    );
    expect(resolveContractAddress('UNDEPLOYED_ADDRESS', BUILD_TIME, host({ UNDEPLOYED_ADDRESS: '  ' }))).toBe(
      BUILD_TIME,
    );
  });

  it('trims both sources (a config file written with a trailing newline still works)', () => {
    expect(resolveContractAddress('UNDEPLOYED_ADDRESS', ` ${BUILD_TIME}\n`, host({}))).toBe(BUILD_TIME);
    expect(
      resolveContractAddress('UNDEPLOYED_ADDRESS', BUILD_TIME, host({ UNDEPLOYED_ADDRESS: `${INJECTED}\n` })),
    ).toBe(INJECTED);
  });

  it('returns undefined when neither source has a value (network stays out of the dropdown)', () => {
    expect(resolveContractAddress('STAGENET_ADDRESS', undefined, undefined)).toBeUndefined();
    expect(resolveContractAddress('STAGENET_ADDRESS', '', host({}))).toBeUndefined();
  });

  it('reads the global off `window` when no host is passed (the browser lane)', () => {
    expect(resolveContractAddress('UNDEPLOYED_ADDRESS', BUILD_TIME)).toBe(BUILD_TIME);
    globalScope.window = { SHIELDED_NIGHT: { UNDEPLOYED_ADDRESS: INJECTED } };
    expect(resolveContractAddress('UNDEPLOYED_ADDRESS', BUILD_TIME)).toBe(INJECTED);
    expect(runtimeConfig()).toEqual({ UNDEPLOYED_ADDRESS: INJECTED });
  });

  it('ignores a non-object global instead of throwing', () => {
    globalScope.window = { SHIELDED_NIGHT: 'nonsense' };
    expect(runtimeConfig()).toBeUndefined();
    expect(resolveContractAddress('UNDEPLOYED_ADDRESS', BUILD_TIME)).toBe(BUILD_TIME);
  });
});

/**
 * The same injection lane carries the ledger generation the local `undeployed`
 * network runs. It decides which adapter (v1/ledger-v8 or v2/ledger-v9) is
 * loaded against a real chain, so a value that is not one of the two accepted
 * names must be reported rather than guessed at.
 */
describe('undeployed protocol switch', () => {
  it('defaults to midnight-1.x — what `undeployed` has always been', () => {
    expect(DEFAULT_UNDEPLOYED_PROTOCOL).toBe('midnight-1.x');
    expect(resolveUndeployedProtocol(undefined, undefined)).toEqual({ family: 'midnight-1.x' });
    expect(resolveUndeployedProtocol(undefined, host({}))).toEqual({ family: 'midnight-1.x' });
  });

  it('accepts exactly the two protocol families', () => {
    expect([...PROTOCOL_FAMILIES]).toEqual(['midnight-1.x', 'midnight-2.x']);
  });

  it('uses the build-time value when nothing is injected', () => {
    expect(resolveUndeployedProtocol('midnight-2.x', undefined)).toEqual({ family: 'midnight-2.x' });
    expect(resolveUndeployedProtocol('midnight-1.x', host({}))).toEqual({ family: 'midnight-1.x' });
  });

  it('prefers the injected value over the build-time one (both directions)', () => {
    expect(
      resolveUndeployedProtocol('midnight-1.x', host({ UNDEPLOYED_PROTOCOL: 'midnight-2.x' })),
    ).toEqual({ family: 'midnight-2.x' });
    expect(
      resolveUndeployedProtocol('midnight-2.x', host({ UNDEPLOYED_PROTOCOL: 'midnight-1.x' })),
    ).toEqual({ family: 'midnight-1.x' });
  });

  it('treats a blank injected value as absent and falls through to the build-time one', () => {
    expect(resolveUndeployedProtocol('midnight-2.x', host({ UNDEPLOYED_PROTOCOL: '' }))).toEqual({
      family: 'midnight-2.x',
    });
    expect(resolveUndeployedProtocol('midnight-2.x', host({ UNDEPLOYED_PROTOCOL: '   ' }))).toEqual({
      family: 'midnight-2.x',
    });
    expect(resolveUndeployedProtocol('', host({ UNDEPLOYED_PROTOCOL: '' }))).toEqual({
      family: 'midnight-1.x',
    });
  });

  it('trims both sources (a config file written with a trailing newline still works)', () => {
    expect(resolveUndeployedProtocol(' midnight-2.x\n', undefined)).toEqual({ family: 'midnight-2.x' });
    expect(
      resolveUndeployedProtocol(undefined, host({ UNDEPLOYED_PROTOCOL: '  midnight-2.x  ' })),
    ).toEqual({ family: 'midnight-2.x' });
  });

  it('rejects an unknown value with a message naming the variable and both accepted values', () => {
    const { family, error } = resolveUndeployedProtocol('ledger9', undefined);
    expect(family).toBeUndefined();
    expect(error).toContain('UNDEPLOYED_PROTOCOL');
    expect(error).toContain('midnight-1.x');
    expect(error).toContain('midnight-2.x');
    expect(error).toContain('ledger9');
  });

  it('is case-sensitive, and rejects a near-miss instead of silently defaulting', () => {
    for (const value of ['Midnight-2.x', 'MIDNIGHT-1.X', 'midnight-2', '2.x', 'ledger8']) {
      const resolved = resolveUndeployedProtocol(value, undefined);
      expect(resolved.family, value).toBeUndefined();
      expect(resolved.error, value).toContain('UNDEPLOYED_PROTOCOL');
    }
  });

  it('rejects an injected bad value even when the build-time value is valid', () => {
    expect(
      resolveUndeployedProtocol('midnight-2.x', host({ UNDEPLOYED_PROTOCOL: 'nonsense' })).error,
    ).toContain('UNDEPLOYED_PROTOCOL');
  });

  it('keeps the reported value short (an injected blob does not become the page message)', () => {
    const error = resolveUndeployedProtocol('x'.repeat(500), undefined).error ?? '';
    expect(error.length).toBeLessThan(140);
    expect(error).toContain('…');
  });

  it('reads the global off `window` when no host is passed (the browser lane)', () => {
    expect(resolveUndeployedProtocol(undefined)).toEqual({ family: 'midnight-1.x' });
    globalScope.window = { SHIELDED_NIGHT: { UNDEPLOYED_PROTOCOL: 'midnight-2.x' } };
    expect(resolveUndeployedProtocol(undefined)).toEqual({ family: 'midnight-2.x' });
  });

  it('ignores a non-object global instead of throwing', () => {
    globalScope.window = { SHIELDED_NIGHT: 'nonsense' };
    expect(resolveUndeployedProtocol('midnight-2.x')).toEqual({ family: 'midnight-2.x' });
  });
});
