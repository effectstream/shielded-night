import { describe, expect, test } from 'vitest';
import * as contract from '../support/shielded-night.js';
import { describeContract } from '../support/describe-contract.js';
import type { WalletContext } from '../support/wallet-builder.js';
import {
  getCoinPublicKey,
  randomBytes32,
  tokenColorHex,
  waitForShieldedBalance,
} from '../support/wallet-observations.js';

/**
 * `depositShielded` burns the received coin via `sendImmediateShielded` — a
 * same-transaction transient. Older wallet stacks mis-listed the result (the
 * spent input UTXO still showed as spendable); toolchain 0.31.101 / ledger-v8
 * 8.1.0 fixed that. These tests pin the fix, separating three questions:
 *
 * 1. Does the transaction build, balance, and apply on the current stack?
 * 2. Is the CONTRACT accounting correct on-chain (credit == coin value)?
 * 3. Does the wallet's own view converge to the truth (coin seen as spent)?
 *
 * A regression in 3 is the historical field bug — display-level, not
 * funds-safety — but it corrupts wallet state, so it fails the suite loudly.
 */

const N = 1_000_000n;

/** Bounded wallet-view probe: resolves to the converged balance or a report string. */
const probeWalletView = async (
  walletCtx: WalletContext,
  colorHex: string,
  expected: bigint,
): Promise<string> => {
  try {
    const v = await waitForShieldedBalance(walletCtx.wallet, colorHex, (b) => b === expected, {
      timeoutMs: 120_000,
    });
    return `converged to ${v} (expected ${expected})`;
  } catch {
    const stale = await waitForShieldedBalance(walletCtx.wallet, colorHex, () => true, {
      timeoutMs: 30_000,
    }).catch(() => 'unreadable');
    return `DID NOT converge within 120s: wallet shows ${stale}, expected ${expected}`;
  }
};

describe('shielded-night — depositShielded burn transient', () => {
  describeContract(contract.factory, (ctx) => {
    test(
      'whole-coin burn: transaction applies, credit is exact, wallet sees the coin as spent',
      async () => {
        const c = ctx();
        const deployed = await c.deployFresh([...contract.DEPLOY_ARGS]);
        const colorHex = tokenColorHex((await contract.tokenColor(deployed)).private.result);
        const me = await getCoinPublicKey(c.walletCtx);
        const mintSecret = randomBytes32();
        const burnSecret = randomBytes32();

        // Mint a wrapper coin of the EXACT deposit size — the wallet is in
        // charge of producing the exact UTXO it wants to store (splitting a
        // larger coin into deposit + change happens wallet-side, before this).
        await contract.depositUnshielded(deployed, mintSecret, N);
        const coin = (
          await contract.withdrawShielded(deployed, mintSecret, N, me, randomBytes32())
        ).private.result;
        await waitForShieldedBalance(c.walletCtx.wallet, colorHex, (b) => b >= N);

        // Q1+Q2: deposit burns the whole coin in one tx and credits its value.
        await contract.depositShielded(deployed, burnSecret, coin);
        expect((await contract.getBalance(deployed, burnSecret)).private.result).toBe(N);

        // Q3: the wallet must see the coin as SPENT (balance 0) — the
        // historical sendImmediateShielded bug left it listed as spendable.
        const view = await probeWalletView(c.walletCtx, colorHex, 0n);
        console.log(`[transient/burn] wallet view: ${view}`);
        expect(view, `wallet view after transient burn: ${view}`).toContain('converged');

        // The credit stays fully usable after the burn: withdraw re-mints the
        // wrapper (elastic supply), proving nothing was stranded by the burn.
        const again = (
          await contract.withdrawShielded(deployed, burnSecret, N, me, randomBytes32())
        ).private.result;
        expect(again.value).toBe(N);
        expect(tokenColorHex(again.color)).toBe(colorHex);
        await waitForShieldedBalance(c.walletCtx.wallet, colorHex, (b) => b >= N);
        expect((await contract.getBalance(deployed, burnSecret)).private.result).toBe(0n);
      },
      10 * 60_000,
    );
  });
});
