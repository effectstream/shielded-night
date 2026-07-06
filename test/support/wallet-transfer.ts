import * as ledger from '@midnight-ntwrk/ledger-v8';
import {
  ShieldedAddress,
  ShieldedCoinPublicKey,
  ShieldedEncryptionPublicKey,
} from '@midnightntwrk/wallet-sdk';
import { Buffer } from 'buffer';
import { firstSyncedState, type WalletContext } from './wallet-builder.js';

const DEFAULT_TTL_MS = 30 * 60_000;

const toBytes = (v: Uint8Array | string): Uint8Array =>
  v instanceof Uint8Array
    ? v
    : Uint8Array.from((v.replace(/^0x/, '').match(/../g) ?? []).map((h) => parseInt(h, 16)));

const hexOf = (v: Uint8Array | string): string =>
  v instanceof Uint8Array
    ? Array.from(v, (b) => b.toString(16).padStart(2, '0')).join('')
    : v.replace(/^0x/, '').toLowerCase();

/**
 * The wallet's own shielded address object, for use as a `transferShielded`
 * recipient. Built from the context's ZswapSecretKeys the same way
 * `deriveShieldedCoinPublicKeyFromSeed` builds the display address.
 */
export const getShieldedAddress = (ctx: WalletContext): ShieldedAddress => {
  const sks = ctx.shieldedSecretKeys;
  const cpk = new ShieldedCoinPublicKey(Buffer.from(ledger.encodeCoinPublicKey(sks.coinPublicKey)));
  const epk = ShieldedEncryptionPublicKey.fromHexString(sks.encryptionPublicKey);
  return new ShieldedAddress(cpk, epk);
};

/** The Compact `ShieldedCoinInfo` shape a circuit consumes: `{ nonce, color, value }`. */
export interface DiscoveredCoin {
  readonly nonce: Uint8Array;
  readonly color: Uint8Array;
  readonly value: bigint;
}

/**
 * Discover the wallet's shielded coins of token color `colorHex` from its own
 * synced state (confirmed + pending), exactly as a dapp would when a user
 * clicks "unshield" — no coin object is carried from the mint/transfer step.
 * The wallet stores `QualifiedShieldedCoinInfo` (`type`/`nonce` as hex); we
 * remap `type -> color` and decode to the bytes the circuit wants.
 */
export const discoverCoins = async (ctx: WalletContext, colorHex: string): Promise<DiscoveredCoin[]> => {
  const state = await firstSyncedState(ctx.wallet);
  return state.shielded.totalCoins
    .map((c) => c.coin)
    .filter((coin) => hexOf(coin.type) === colorHex)
    .map((coin) => ({ nonce: toBytes(coin.nonce), color: toBytes(coin.type), value: BigInt(coin.value) }));
};

/** Sum the values of a coin list. */
export const coinsTotal = (coins: ReadonlyArray<DiscoveredCoin>): bigint =>
  coins.reduce((sum, c) => sum + c.value, 0n);

/** Poll until the wallet's `colorHex` coin list satisfies `predicate` (or timeout). */
export const waitForCoins = async (
  ctx: WalletContext,
  colorHex: string,
  predicate: (coins: DiscoveredCoin[]) => boolean,
  opts: { readonly timeoutMs?: number; readonly everyMs?: number } = {},
): Promise<DiscoveredCoin[]> => {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const everyMs = opts.everyMs ?? 5_000;
  const start = Date.now();
  let last: DiscoveredCoin[] = [];
  while (Date.now() - start < timeoutMs) {
    last = await discoverCoins(ctx, colorHex);
    if (predicate(last)) return last;
    await new Promise((r) => setTimeout(r, everyMs));
  }
  return last;
};

/**
 * Transfer shielded token `tokenTypeHex` from `from` to one or more recipients
 * in a single transaction (a plain wallet-to-wallet transfer — no contract
 * involved). Uses the reference recipe flow:
 * transferTransaction -> signRecipe -> finalizeRecipe -> submitTransaction.
 */
export const transferShielded = async (
  from: WalletContext,
  tokenTypeHex: string,
  outputs: ReadonlyArray<{ readonly to: ShieldedAddress; readonly amount: bigint }>,
): Promise<string> => {
  // The facade's transfer/recipe methods are not in the exported .d.ts surface
  // this harness pins against; the shapes match the wallet-sdk README.
  const wallet = from.wallet as unknown as {
    transferTransaction: (o: unknown, k: unknown, opts: unknown) => Promise<unknown>;
    signRecipe: (r: unknown, sign: (p: Uint8Array) => unknown) => Promise<unknown>;
    finalizeRecipe: (r: unknown) => Promise<unknown>;
    submitTransaction: (t: unknown) => Promise<string>;
  };
  const recipe = await wallet.transferTransaction(
    [
      {
        type: 'shielded',
        outputs: outputs.map((o) => ({ type: tokenTypeHex, receiverAddress: o.to, amount: o.amount })),
      },
    ],
    { shieldedSecretKeys: from.shieldedSecretKeys, dustSecretKey: from.dustSecretKey },
    { ttl: new Date(Date.now() + DEFAULT_TTL_MS) },
  );
  const signed = await wallet.signRecipe(recipe, (p: Uint8Array) => from.unshieldedKeystore.signData(p));
  const finalized = await wallet.finalizeRecipe(signed);
  return wallet.submitTransaction(finalized);
};
