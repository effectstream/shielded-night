import { beforeEach, describe, expect, it } from 'vitest';
import {
  ConvertVaultSimulator,
  rightUserAddress,
  type ShieldedCoin,
} from './simulators/ConvertVaultSimulator.js';

/**
 * Unit coverage for the atomic single-circuit converts (convertToShielded /
 * convertToUnshielded). They carry no secret and touch no `balances` map -
 * deposit and withdraw happen in the one circuit, so there is nothing to bridge.
 * (Whether the WALLET can balance the resulting single tx that mixes an
 * unshielded receive with a shielded mint is the integration test's job; here we
 * pin the circuit logic and guards.)
 */

const N = 10_000_000n;
const b32 = (label: string): Uint8Array => {
  const out = new Uint8Array(32);
  out.set(new TextEncoder().encode(label).subarray(0, 32));
  return out;
};
const RECIPIENT = { bytes: b32('recipient-coin-pk') };
const USER = rightUserAddress(b32('user-address'));
const ZERO32 = new Uint8Array(32);

describe('ConvertVault combined circuits (simulator)', () => {
  let vault: ConvertVaultSimulator;
  beforeEach(() => {
    vault = new ConvertVaultSimulator('Wrapped NIGHT', 'wNIGHT', 6n);
  });

  describe('convertToShielded', () => {
    it('mints a wrapper coin of the exact amount with the vault color', () => {
      const coin = vault.convertToShielded(N, RECIPIENT, b32('n'));
      expect(coin.value).toBe(N);
      expect(coin.color).toEqual(vault.tokenColor());
      expect(coin.nonce).toEqual(b32('n'));
    });

    it('does not touch the credit map (no secret, atomic)', () => {
      vault.convertToShielded(N, RECIPIENT, b32('n'));
      expect(vault.getLedger().balances.isEmpty()).toBe(true);
    });

    it('rejects a zero amount', () => {
      expect(() => vault.convertToShielded(0n, RECIPIENT, b32('n'))).toThrow('amount must be positive');
    });

    it('rejects the zero recipient (burn address)', () => {
      expect(() => vault.convertToShielded(N, { bytes: ZERO32 }, b32('n'))).toThrow('invalid recipient');
    });
  });

  describe('convertToUnshielded', () => {
    let coin: ShieldedCoin;
    beforeEach(() => {
      coin = vault.convertToShielded(N, RECIPIENT, b32('n'));
    });

    it('accepts a wrapper coin and releases NIGHT (no throw, no credit touched)', () => {
      expect(() => vault.convertToUnshielded(coin, USER)).not.toThrow();
      expect(vault.getLedger().balances.isEmpty()).toBe(true);
    });

    it('rejects a coin that is not the vault wrapper', () => {
      const foreign = { ...coin, color: coin.color.slice() };
      foreign.color[0] ^= 0xff;
      expect(() => vault.convertToUnshielded(foreign, USER)).toThrow("not this vault's shielded wrapper");
    });

    it('rejects a zero-value coin', () => {
      expect(() => vault.convertToUnshielded({ ...coin, value: 0n }, USER)).toThrow('coin value must be positive');
    });

    it('rejects the zero unshielded recipient', () => {
      expect(() => vault.convertToUnshielded(coin, rightUserAddress(ZERO32))).toThrow('invalid recipient');
    });
  });
});
