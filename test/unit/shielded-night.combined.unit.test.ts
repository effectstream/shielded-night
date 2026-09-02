import { beforeEach, describe, expect, it } from 'vitest';
import {
  ShieldedNightSimulator,
  rightUserAddress,
  type ShieldedCoin,
} from './simulators/ShieldedNightSimulator.js';

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

describe('ShieldedNight combined circuits (simulator)', () => {
  let contract: ShieldedNightSimulator;
  beforeEach(async () => {
    contract = await ShieldedNightSimulator.create('Shielded Night', 'sNight', 6n);
  });

  describe('convertToShielded', () => {
    it('mints a wrapper coin of the exact amount with the contract color', async () => {
      const coin = await contract.convertToShielded(N, RECIPIENT, b32('n'));
      expect(coin.value).toBe(N);
      expect(coin.color).toEqual(await contract.tokenColor());
      expect(coin.nonce).toEqual(b32('n'));
    });

    it('does not touch the credit map (no secret, atomic)', async () => {
      await contract.convertToShielded(N, RECIPIENT, b32('n'));
      expect(contract.getLedger().balances.isEmpty()).toBe(true);
    });

    it('rejects a zero amount', async () => {
      await expect(contract.convertToShielded(0n, RECIPIENT, b32('n'))).rejects.toThrow('amount must be positive');
    });

    it('rejects the zero recipient (burn address)', async () => {
      await expect(contract.convertToShielded(N, { bytes: ZERO32 }, b32('n'))).rejects.toThrow('invalid recipient');
    });
  });

  describe('convertToUnshielded', () => {
    let coin: ShieldedCoin;
    beforeEach(async () => {
      coin = await contract.convertToShielded(N, RECIPIENT, b32('n'));
    });

    it('accepts a wrapper coin and releases NIGHT (no throw, no credit touched)', async () => {
      await expect(contract.convertToUnshielded(coin, USER)).resolves.not.toThrow();
      expect(contract.getLedger().balances.isEmpty()).toBe(true);
    });

    it('rejects a coin that is not the contract wrapper', async () => {
      const foreign = { ...coin, color: coin.color.slice() };
      foreign.color[0] ^= 0xff;
      await expect(contract.convertToUnshielded(foreign, USER)).rejects.toThrow("not this contract's shielded wrapper");
    });

    it('rejects a zero-value coin', async () => {
      await expect(contract.convertToUnshielded({ ...coin, value: 0n }, USER)).rejects.toThrow('coin value must be positive');
    });

    it('rejects the zero unshielded recipient', async () => {
      await expect(contract.convertToUnshielded(coin, rightUserAddress(ZERO32))).rejects.toThrow('invalid recipient');
    });
  });
});
