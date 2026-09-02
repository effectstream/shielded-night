/**
 * The SPA's runtime contract-address override (frontend/src/lib/runtime-config.ts).
 *
 * A deployment that brings up its own chain injects
 * `window.SHIELDED_NIGHT = { UNDEPLOYED_ADDRESS: "…" }` before the module
 * bundle, and that value must win over the address baked in at build time —
 * while a build with no such global keeps behaving exactly as before. These
 * are the two claims the packaging of this dApp into a compose stack depends
 * on, so they are pinned here rather than left to the browser.
 *
 * Lives in the ROOT unit tier (not the frontend package) because
 * runtime-config.ts is deliberately dependency-free and free of
 * `import.meta.env`, so it runs under the existing `bun run test:unit`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  RUNTIME_CONFIG_GLOBAL,
  resolveContractAddress,
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
    expect(resolveContractAddress('MAINNET_ADDRESS', undefined, undefined)).toBeUndefined();
    expect(resolveContractAddress('MAINNET_ADDRESS', '', host({}))).toBeUndefined();
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
