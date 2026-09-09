/**
 * The `undeployed` row's protocol family (frontend/src/lib/networks.ts).
 *
 * Preview, Preprod and Stagenet are pinned to the ledger generation their chain
 * runs; `undeployed` is whichever devnet is on the other end, so it is selected
 * by `UNDEPLOYED_PROTOCOL` — build-time env, overridable by the runtime config
 * a stack injects. The claims pinned here are the ones a packaged deployment
 * depends on: the default is unchanged (1.x), the runtime value wins, an
 * invalid value is reported through the same `configurationError` that disables
 * Connect, and the exported `NETWORKS` const the other consumers import is
 * never mutated.
 *
 * Lives in the ROOT unit tier: `import.meta.env` is supplied by vitest under
 * node, and `vi.stubEnv` writes to it, which is exactly the build-time lane.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  configuredNetworks,
  contractConfigurationError,
  NETWORKS,
  protocolConfigurationError,
  protocolMismatchHint,
  resolveNetwork,
} from '../../frontend/src/lib/networks.js';

const ADDRESS = 'a'.repeat(64);

const globalScope = globalThis as { window?: unknown };

/**
 * Inject a runtime config the way `/config.js` does. Addresses go through this
 * lane in these tests rather than through `vi.stubEnv`, because networks.ts
 * reads the build-time addresses ONCE at module load while the protocol switch
 * is read per call — `vi.stubEnv` therefore only reaches the latter.
 */
const inject = (config: Record<string, string>) => {
  globalScope.window = { SHIELDED_NIGHT: config };
};

afterEach(() => {
  delete globalScope.window;
  vi.unstubAllEnvs();
});

describe('undeployed protocol family', () => {
  it('is midnight-1.x with no setting — today’s behaviour', () => {
    const local = resolveNetwork('undeployed');
    expect(local.protocolFamily).toBe('midnight-1.x');
    expect(local.label).toBe('Local (undeployed)');
    expect(local.networkId).toBe('undeployed');
    expect(protocolConfigurationError('undeployed')).toBeUndefined();
  });

  it('follows the build-time UNDEPLOYED_PROTOCOL and says so in the label', () => {
    vi.stubEnv('UNDEPLOYED_PROTOCOL', 'midnight-2.x');
    expect(resolveNetwork('undeployed')).toEqual({
      key: 'undeployed',
      label: 'Local (undeployed · 2.x)',
      networkId: 'undeployed',
      protocolFamily: 'midnight-2.x',
    });
    expect(protocolConfigurationError('undeployed')).toBeUndefined();
  });

  it('lets the injected runtime value win over the build-time one (both directions)', () => {
    vi.stubEnv('UNDEPLOYED_PROTOCOL', 'midnight-1.x');
    inject({ UNDEPLOYED_PROTOCOL: 'midnight-2.x' });
    expect(resolveNetwork('undeployed').protocolFamily).toBe('midnight-2.x');

    vi.stubEnv('UNDEPLOYED_PROTOCOL', 'midnight-2.x');
    inject({ UNDEPLOYED_PROTOCOL: 'midnight-1.x' });
    expect(resolveNetwork('undeployed').protocolFamily).toBe('midnight-1.x');
  });

  it('falls through to the build-time value when the injected one is blank', () => {
    vi.stubEnv('UNDEPLOYED_PROTOCOL', 'midnight-2.x');
    inject({ UNDEPLOYED_PROTOCOL: '  ' });
    expect(resolveNetwork('undeployed').protocolFamily).toBe('midnight-2.x');
  });

  it('resolves per call, so a config injected after module load is honoured', () => {
    expect(resolveNetwork('undeployed').protocolFamily).toBe('midnight-1.x');
    inject({ UNDEPLOYED_PROTOCOL: 'midnight-2.x' });
    expect(resolveNetwork('undeployed').protocolFamily).toBe('midnight-2.x');
  });

  it('never mutates the exported NETWORKS const (other consumers import it)', () => {
    vi.stubEnv('UNDEPLOYED_PROTOCOL', 'midnight-2.x');
    inject({ UNDEPLOYED_PROTOCOL: 'midnight-2.x' });
    resolveNetwork('undeployed');
    configuredNetworks();
    const local = NETWORKS.find((network) => network.key === 'undeployed')!;
    expect(local.protocolFamily).toBe('midnight-1.x');
    expect(local.label).toBe('Local (undeployed)');
  });

  it('leaves the three public rows exactly as declared', () => {
    vi.stubEnv('UNDEPLOYED_PROTOCOL', 'midnight-2.x');
    for (const key of ['preview', 'preprod', 'stagenet'] as const) {
      expect(resolveNetwork(key)).toBe(NETWORKS.find((network) => network.key === key));
      expect(protocolConfigurationError(key)).toBeUndefined();
    }
    expect(resolveNetwork('preview').protocolFamily).toBe('midnight-1.x');
    expect(resolveNetwork('stagenet').protocolFamily).toBe('midnight-2.x');
  });

  it('shows the resolved label in the selector', () => {
    vi.stubEnv('UNDEPLOYED_PROTOCOL', 'midnight-2.x');
    inject({ UNDEPLOYED_ADDRESS: ADDRESS });
    const labels = configuredNetworks().map((network) => network.label);
    expect(labels).toContain('Local (undeployed · 2.x)');
    expect(labels).not.toContain('Local (undeployed)');
  });
});

describe('an invalid UNDEPLOYED_PROTOCOL', () => {
  it('is reported, naming the variable and both accepted values', () => {
    vi.stubEnv('UNDEPLOYED_PROTOCOL', 'ledger9');
    const error = protocolConfigurationError('undeployed');
    expect(error).toContain('UNDEPLOYED_PROTOCOL');
    expect(error).toContain('midnight-1.x');
    expect(error).toContain('midnight-2.x');
    expect(error).toContain('ledger9');
  });

  it('reaches the page through configurationError, ahead of the address error', () => {
    vi.stubEnv('UNDEPLOYED_PROTOCOL', 'ledger9');
    // No address either: the protocol error is the one that must be shown.
    expect(contractConfigurationError('undeployed')).toBe(protocolConfigurationError('undeployed'));
    inject({ UNDEPLOYED_ADDRESS: ADDRESS });
    expect(contractConfigurationError('undeployed')).toBe(protocolConfigurationError('undeployed'));
  });

  it('is not silently substituted by a family (the row falls back for display only)', () => {
    vi.stubEnv('UNDEPLOYED_PROTOCOL', 'ledger9');
    expect(resolveNetwork('undeployed').protocolFamily).toBe('midnight-1.x');
    expect(resolveNetwork('undeployed').label).toBe('Local (undeployed)');
    expect(contractConfigurationError('undeployed')).toBeDefined();
  });

  it('does not affect the public networks', () => {
    vi.stubEnv('UNDEPLOYED_PROTOCOL', 'ledger9');
    inject({ STAGENET_ADDRESS: ADDRESS });
    expect(contractConfigurationError('stagenet')).toBeUndefined();
  });
});

describe('address errors', () => {
  it('still report the missing deployment, with the resolved label', () => {
    expect(contractConfigurationError('undeployed')).toBe(
      'Shielded NIGHT is not deployed on Local (undeployed).',
    );
    vi.stubEnv('UNDEPLOYED_PROTOCOL', 'midnight-2.x');
    expect(contractConfigurationError('undeployed')).toBe(
      'Shielded NIGHT is not deployed on Local (undeployed · 2.x).',
    );
  });

  it('still reject a malformed address', () => {
    inject({ UNDEPLOYED_ADDRESS: 'not-hex' });
    expect(contractConfigurationError('undeployed')).toBe(
      'UNDEPLOYED_ADDRESS must be exactly 32 bytes of hexadecimal.',
    );
  });
});

describe('protocol mismatch hint', () => {
  it('points at the wallet generation when the local network is 2.x', () => {
    vi.stubEnv('UNDEPLOYED_PROTOCOL', 'midnight-2.x');
    const hint = protocolMismatchHint('undeployed') ?? '';
    expect(hint).toContain('midnight-2.x');
    expect(hint).toContain('UNDEPLOYED_PROTOCOL');
  });

  it('points at the switch when the local network is the 1.x default', () => {
    const hint = protocolMismatchHint('undeployed') ?? '';
    expect(hint).toContain('midnight-1.x');
    expect(hint).toContain('UNDEPLOYED_PROTOCOL=midnight-2.x');
  });

  it('has nothing to say about the pinned public networks', () => {
    expect(protocolMismatchHint('preview')).toBeUndefined();
    expect(protocolMismatchHint('stagenet')).toBeUndefined();
  });
});
