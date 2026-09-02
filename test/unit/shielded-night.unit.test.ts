import { beforeEach, describe, expect, it } from 'vitest';
import {
  ShieldedNightSimulator,
  rightUserAddress,
  type ShieldedCoin,
} from './simulators/ShieldedNightSimulator.js';

const NAME = 'Shielded Night';
const SYMBOL = 'sNight';
const DECIMALS = 6n;
const N = 10_000_000n; // 10 NIGHT at 6 decimals

/** 32-byte value from an ASCII label (zero-padded). */
const b32 = (label: string): Uint8Array => {
  const out = new Uint8Array(32);
  out.set(new TextEncoder().encode(label).subarray(0, 32));
  return out;
};

const SECRET_A = b32('secret-a');
const SECRET_B = b32('secret-b');
const RECIPIENT = { bytes: b32('recipient-coin-pk') };
const USER = rightUserAddress(b32('user-address'));

describe('ShieldedNight (simulator)', () => {
  let contract: ShieldedNightSimulator;

  beforeEach(async () => {
    contract = await ShieldedNightSimulator.create(NAME, SYMBOL, DECIMALS);
  });

  describe('metadata', () => {
    it('echoes constructor args through the metadata circuits', async () => {
      expect(await contract.name()).toBe(NAME);
      expect(await contract.symbol()).toBe(SYMBOL);
      expect(await contract.decimals()).toBe(DECIMALS);
    });

    it('exposes the sealed metadata directly on the ledger', () => {
      const l = contract.getLedger();
      expect(l._name).toBe(NAME);
      expect(l._symbol).toBe(SYMBOL);
      expect(l._decimals).toBe(DECIMALS);
    });

    it('starts with an empty balances map', () => {
      expect(contract.getLedger().balances.isEmpty()).toBe(true);
    });

    it('returns a stable 32-byte wrapper color', async () => {
      const c1 = await contract.tokenColor();
      const c2 = await contract.tokenColor();
      expect(c1).toHaveLength(32);
      expect(c1).toEqual(c2);
      expect(c1.some((b) => b !== 0)).toBe(true);
    });
  });

  describe('depositUnshielded', () => {
    it('credits the balance under hash(secret)', async () => {
      await contract.depositUnshielded(SECRET_A, N);
      expect(await contract.getBalance(SECRET_A)).toBe(N);
    });

    it('accumulates across deposits', async () => {
      await contract.depositUnshielded(SECRET_A, N);
      await contract.depositUnshielded(SECRET_A, 5n);
      expect(await contract.getBalance(SECRET_A)).toBe(N + 5n);
    });

    it('keeps balances of distinct secrets independent', async () => {
      await contract.depositUnshielded(SECRET_A, N);
      await contract.depositUnshielded(SECRET_B, 7n);
      expect(await contract.getBalance(SECRET_A)).toBe(N);
      expect(await contract.getBalance(SECRET_B)).toBe(7n);
      expect(contract.getLedger().balances.size()).toBe(2n);
    });

    it('rejects a zero amount', async () => {
      await expect(contract.depositUnshielded(SECRET_A, 0n)).rejects.toThrow(
        'amount must be positive',
      );
    });
  });

  describe('withdrawShielded', () => {
    beforeEach(async () => {
      await contract.depositUnshielded(SECRET_A, N);
    });

    it('debits the balance and mints a wrapper coin with the given nonce', async () => {
      const nonce = b32('mint-nonce');
      const coin = await contract.withdrawShielded(SECRET_A, N, RECIPIENT, nonce);
      expect(coin.value).toBe(N);
      expect(coin.nonce).toEqual(nonce);
      expect(coin.color).toEqual(await contract.tokenColor());
      expect(await contract.getBalance(SECRET_A)).toBe(0n);
    });

    it('supports partial withdrawal', async () => {
      await contract.withdrawShielded(SECRET_A, N / 2n, RECIPIENT, b32('n1'));
      expect(await contract.getBalance(SECRET_A)).toBe(N - N / 2n);
    });

    it('rejects a zero amount', async () => {
      await expect(contract.withdrawShielded(SECRET_A, 0n, RECIPIENT, b32('n'))).rejects.toThrow('amount must be positive');
    });

    it('rejects an unknown secret', async () => {
      await expect(contract.withdrawShielded(SECRET_B, 1n, RECIPIENT, b32('n'))).rejects.toThrow('no balance for this secret');
    });

    it('rejects withdrawing more than the balance', async () => {
      await expect(contract.withdrawShielded(SECRET_A, N + 1n, RECIPIENT, b32('n'))).rejects.toThrow('insufficient pool balance');
    });
  });

  describe('depositShielded', () => {
    let coin: ShieldedCoin;

    beforeEach(async () => {
      await contract.depositUnshielded(SECRET_A, N);
      coin = await contract.withdrawShielded(SECRET_A, N, RECIPIENT, b32('n'));
    });

    it('credits the balance by the full coin value', async () => {
      await contract.depositShielded(SECRET_A, coin);
      expect(await contract.getBalance(SECRET_A)).toBe(N);
    });

    it('credits a different secret than the one that minted', async () => {
      await contract.depositShielded(SECRET_B, coin);
      expect(await contract.getBalance(SECRET_B)).toBe(N);
    });

    it('rejects a coin that is not the contract wrapper', async () => {
      const foreign = { ...coin, color: coin.color.slice() };
      foreign.color[0] ^= 0xff;
      await expect(contract.depositShielded(SECRET_A, foreign)).rejects.toThrow(
        "not this contract's shielded wrapper",
      );
    });

    it('rejects a zero-value coin', async () => {
      await expect(contract.depositShielded(SECRET_A, { ...coin, value: 0n })).rejects.toThrow('coin value must be positive');
    });
  });

  describe('withdrawUnshielded', () => {
    beforeEach(async () => {
      await contract.depositUnshielded(SECRET_A, N);
    });

    it('debits the balance', async () => {
      await contract.withdrawUnshielded(SECRET_A, N / 2n, USER);
      expect(await contract.getBalance(SECRET_A)).toBe(N - N / 2n);
    });

    it('rejects a zero amount', async () => {
      await expect(contract.withdrawUnshielded(SECRET_A, 0n, USER)).rejects.toThrow(
        'amount must be positive',
      );
    });

    it('rejects an unknown secret', async () => {
      await expect(contract.withdrawUnshielded(SECRET_B, 1n, USER)).rejects.toThrow(
        'no balance for this secret',
      );
    });

    it('rejects withdrawing more than the balance', async () => {
      await expect(contract.withdrawUnshielded(SECRET_A, N + 1n, USER)).rejects.toThrow(
        'insufficient pool balance',
      );
    });
  });

  describe('round trip', () => {
    it('unshielded -> shielded -> unshielded leaves a zero balance', async () => {
      await contract.depositUnshielded(SECRET_A, N);
      const coin = await contract.withdrawShielded(SECRET_A, N, RECIPIENT, b32('rt'));
      expect(await contract.getBalance(SECRET_A)).toBe(0n);

      await contract.depositShielded(SECRET_A, coin);
      expect(await contract.getBalance(SECRET_A)).toBe(N);

      await contract.withdrawUnshielded(SECRET_A, N, USER);
      expect(await contract.getBalance(SECRET_A)).toBe(0n);
      expect(contract.getLedger().balances.lookup(contractKeyOf(SECRET_A))).toBe(0n);
    });
  });

  describe('getBalance', () => {
    it('throws for a never-used secret (lookup without member guard)', async () => {
      // Pins current behavior: reads for unknown keys revert instead of
      // returning 0. Off-chain callers must probe `balances.member` first.
      await expect(contract.getBalance(b32('never-used'))).rejects.toThrow();
    });
  });

  /** Recover the public balance key for `secret` from the ledger map. */
  function contractKeyOf(secret: Uint8Array): Uint8Array {
    // The key is persistentHash([pad(32,"shielded-night:balance"), secret]); rather than
    // re-deriving the hash here, find the single entry the tests created.
    for (const [key] of contract.getLedger().balances) {
      void secret;
      return key;
    }
    throw new Error('no balances entry found');
  }
});
