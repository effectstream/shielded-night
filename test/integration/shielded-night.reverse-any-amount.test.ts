import * as ledgerV8 from '@midnight-ntwrk/ledger-v8';
import { describe, expect, test } from 'vitest';
import * as contract from '../support/shielded-night.js';
import { describeContract } from '../support/describe-contract.js';
import { categorizeError, timed } from '../support/instrumentation.js';
import { tryCall } from '../support/smoke-helpers.js';
import {
  getCoinPublicKey,
  getNightBalance,
  getUserAddress,
  randomBytes32,
  tokenColorHex,
  waitForShieldedBalance,
  waitForUnshieldedBalance,
} from '../support/wallet-observations.js';

const N = 1_000_000n; // 1 NIGHT at 6 decimals
const NIGHT_HEX = ledgerV8.unshieldedToken().raw;

/**
 * Does `convertToUnshielded` require the caller to hand back an *exact* coin it
 * previously minted, or only enough sNight for the wallet to fund the
 * contract-owned output?
 *
 * Compact's `receive` adds a validation condition that the coin is present as an
 * OUTPUT addressed to the contract (`_createZswapOutput_0(coin, contractAddress)`
 * in the compiled circuit). The wallet then balances that output with ordinary
 * shielded coin selection: any inputs of that token type totalling >= value,
 * plus change. Nothing binds the coin's nonce to an owned UTXO.
 *
 * The frontend used to gate the reverse swap on a coin minted and retained by
 * that browser, on the reading that the exact commitment had to be spent. These
 * scenarios falsify that reading against a real ledger:
 *
 *  2. fractional  — reverse HALF of one minted coin with a FRESH random nonce;
 *  3. remainder   — reverse the wallet's own change coin (a coin whose nonce the
 *                   dApp never chose) with another fresh nonce;
 *  4. merge       — reverse the merged value of TWO separately minted coins in
 *                   ONE call with a fresh nonce;
 *  5. the only failure mode left is insufficient sNight.
 *
 * The evidence is the wallet's balances (shielded wrapper + unshielded NIGHT),
 * not the circuit's private result: only the ledger can decide whether the
 * transaction balanced. Fees are paid in DUST, so the NIGHT arithmetic is exact.
 */

const step = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
  console.log(`[reverse-any-amount] START ${label}`);
  const { value, ms } = await timed(fn);
  console.log(`[reverse-any-amount] DONE  ${label} (${ms}ms)`);
  return value;
};

describe('shielded-night — reverse conversion for any wallet balance', () => {
  describeContract(contract.factory, (ctx) => {
    test(
      'convertToUnshielded balances from the wallet balance with a fresh nonce (fraction, change coin, merged coins); only insufficient sNight fails',
      async () => {
        const c = ctx();
        const deployed = await step('deploy', () => c.deployFresh([...contract.DEPLOY_ARGS]));
        const color = (await contract.tokenColor(deployed)).private.result;
        const colorHex = tokenColorHex(color);
        const me = await getCoinPublicKey(c.walletCtx);
        const myAddr = contract.rightUserAddress(getUserAddress(c.walletCtx).bytes);

        const night0 = await getNightBalance(c.walletCtx);
        console.log(`[reverse-any-amount] night0=${night0} color=${colorHex}`);
        expect(night0).toBeGreaterThanOrEqual(4n * N);

        // --- Scenario 1: mint N sNight in one coin. ---------------------------
        await step('scenario 1 — convertToShielded(N)', () =>
          contract.convertToShielded(deployed, N, me, randomBytes32()),
        );
        expect(await waitForShieldedBalance(c.walletCtx.wallet, colorHex, (b) => b >= N)).toBe(N);
        expect(
          await waitForUnshieldedBalance(c.walletCtx.wallet, NIGHT_HEX, (b) => b <= night0 - N),
        ).toBe(night0 - N);

        // --- Scenario 2: reverse HALF of that coin with a FRESH nonce. --------
        // If the exact-coin reading were right, this could not balance: no owned
        // UTXO has this nonce, and the value differs from every minted coin.
        const half = N / 2n;
        await step('scenario 2 — convertToUnshielded(fresh nonce, N/2)', () =>
          contract.convertToUnshielded(deployed, { nonce: randomBytes32(), color, value: half }, myAddr),
        );
        expect(await waitForShieldedBalance(c.walletCtx.wallet, colorHex, (b) => b === half)).toBe(half);
        expect(
          await waitForUnshieldedBalance(c.walletCtx.wallet, NIGHT_HEX, (b) => b >= night0 - half),
        ).toBe(night0 - half);
        console.log('[reverse-any-amount] scenario 2 PASS: fractional reverse with a fresh nonce');

        // --- Scenario 3: reverse the remainder — the wallet's own CHANGE coin.
        // The N/2 now held was created by the wallet while balancing scenario 2;
        // this browser never minted it and could not have retained it.
        await step('scenario 3 — convertToUnshielded(fresh nonce, remainder N/2)', () =>
          contract.convertToUnshielded(deployed, { nonce: randomBytes32(), color, value: half }, myAddr),
        );
        expect(await waitForShieldedBalance(c.walletCtx.wallet, colorHex, (b) => b === 0n)).toBe(0n);
        expect(await waitForUnshieldedBalance(c.walletCtx.wallet, NIGHT_HEX, (b) => b >= night0)).toBe(night0);
        console.log('[reverse-any-amount] scenario 3 PASS: change coin reversed with a fresh nonce');

        // --- Scenario 4: two separate mints, reversed as ONE merged output. ---
        await step('scenario 4a — convertToShielded(N) #1', () =>
          contract.convertToShielded(deployed, N, me, randomBytes32()),
        );
        expect(await waitForShieldedBalance(c.walletCtx.wallet, colorHex, (b) => b >= N)).toBe(N);
        await step('scenario 4b — convertToShielded(N) #2', () =>
          contract.convertToShielded(deployed, N, me, randomBytes32()),
        );
        expect(await waitForShieldedBalance(c.walletCtx.wallet, colorHex, (b) => b >= 2n * N)).toBe(2n * N);

        await step('scenario 4c — convertToUnshielded(fresh nonce, 2N across two coins)', () =>
          contract.convertToUnshielded(deployed, { nonce: randomBytes32(), color, value: 2n * N }, myAddr),
        );
        expect(await waitForShieldedBalance(c.walletCtx.wallet, colorHex, (b) => b === 0n)).toBe(0n);
        expect(await waitForUnshieldedBalance(c.walletCtx.wallet, NIGHT_HEX, (b) => b >= night0)).toBe(night0);
        console.log('[reverse-any-amount] scenario 4 PASS: two minted coins merged into one reverse');

        // --- Scenario 5: with 0 sNight, even 1 unit cannot be funded. ---------
        const outcome = await step('scenario 5 — convertToUnshielded(fresh nonce, 1) with 0 sNight', () =>
          tryCall(() =>
            contract.convertToUnshielded(deployed, { nonce: randomBytes32(), color, value: 1n }, myAddr),
          ),
        );
        expect(outcome.ok, 'expected the transaction to be rejected: the wallet holds no sNight').toBe(false);
        if (!outcome.ok) {
          const message = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
          console.log(`[reverse-any-amount] scenario 5 rejection category=${categorizeError(outcome.error)}`);
          console.log(`[reverse-any-amount] scenario 5 rejection message>>> ${message}`);
        }
        // The failed attempt changed nothing.
        expect(await getNightBalance(c.walletCtx)).toBe(night0);
        expect(await waitForShieldedBalance(c.walletCtx.wallet, colorHex, (b) => b === 0n)).toBe(0n);
        console.log('[reverse-any-amount] scenario 5 PASS: insufficient sNight is the only failure mode');
      },
      20 * 60_000,
    );
  });
});
