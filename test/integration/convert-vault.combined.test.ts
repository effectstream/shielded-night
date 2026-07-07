import * as ledgerV8 from '@midnight-ntwrk/ledger-v8';
import { describe, expect } from 'vitest';
import * as vault from '../support/convert-vault.js';
import { describeContract } from '../support/describe-contract.js';
import { smokeTest } from '../support/tags.js';
import {
  getCoinPublicKey,
  getNightBalance,
  getUserAddress,
  randomBytes32,
  tokenColorHex,
  waitForShieldedBalance,
  waitForUnshieldedBalance,
} from '../support/wallet-observations.js';

const N = 1_000_000n; // 1 NIGHT
const NIGHT_HEX = ledgerV8.unshieldedToken().raw;

/**
 * The decisive experiment: can a SINGLE transaction both receive unshielded
 * NIGHT and mint/move the shielded wrapper, and be balanced + applied by the
 * wallet + node? The two-step design was built around a wallet that couldn't
 * (node 0.22.5 era). This proves whether the current stack can, via the atomic
 * convertToShielded / convertToUnshielded circuits (one contract call each).
 */
describe('convert-vault - combined single-tx converts', () => {
  describeContract(vault.factory, (ctx) => {
    smokeTest(
      'convertToShielded then convertToUnshielded, each in ONE transaction',
      async () => {
        const c = ctx();
        const deployed = await c.deployFresh([...vault.DEPLOY_ARGS]);
        const colorHex = tokenColorHex((await vault.tokenColor(deployed)).private.result);
        const night0 = await getNightBalance(c.walletCtx);
        expect(night0).toBeGreaterThanOrEqual(N);

        // --- NIGHT -> wNIGHT in one call (receiveUnshielded + mint) ---
        const nonce = randomBytes32();
        const coin = (
          await vault.convertToShielded(deployed, N, await getCoinPublicKey(c.walletCtx), nonce)
        ).private.result;
        expect(coin.value).toBe(N);
        expect(tokenColorHex(coin.color)).toBe(colorHex);

        const wrapped = await waitForShieldedBalance(c.walletCtx.wallet, colorHex, (b) => b >= N);
        expect(wrapped).toBe(N);
        const nightAfterMint = await waitForUnshieldedBalance(c.walletCtx.wallet, NIGHT_HEX, (b) => b <= night0 - N);
        expect(nightAfterMint).toBe(night0 - N);

        // --- wNIGHT -> NIGHT in one call (receiveShielded + sendUnshielded) ---
        await vault.convertToUnshielded(
          deployed,
          coin,
          vault.rightUserAddress(getUserAddress(c.walletCtx).bytes),
        );
        await waitForShieldedBalance(c.walletCtx.wallet, colorHex, (b) => b === 0n);
        const nightFinal = await waitForUnshieldedBalance(c.walletCtx.wallet, NIGHT_HEX, (b) => b >= night0);
        expect(nightFinal).toBe(night0);
      },
      10 * 60_000,
    );
  });
});
