import { CompiledContract } from '@midnight-ntwrk/compact-js';
import { deployContract, findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { initializeMidnightProviders, MidnightWalletProvider, syncWallet } from '@midnight-ntwrk/testkit-js';
import { encodeUserAddress, rawTokenType, unshieldedToken } from '@midnightntwrk/ledger-v9';
import { sampleSigningKey, signatureVerifyingKey } from '@midnightntwrk/onchain-runtime-v4';
import { type WalletFacade } from '@midnightntwrk/wallet-sdk';
import * as Rx from 'rxjs';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Contract } from '../../managed/contract/index.js';
import {
  assertDeploymentWalletFunded,
  assertMaintenanceAuthorityKey,
  createWalletLogger,
  deploymentWalletSyncTimeoutMs,
  GENESIS_MINT_SEED,
  MANAGED_DIRECTORY,
  privateStateStoreName,
  profileFor,
  verifyAddress,
  walletNetworkIdFor,
  type V2EnvName,
  type V2Profile,
} from '../../scripts/profile.js';
import { RESOLVED_ENV_VAR, RESOLVED_PROFILE_VAR } from './global-setup.js';

/** 10 sNight at 6 decimals — the same unit the 1.x round-trip suite moves. */
const N = 10_000_000n;

/** Hex key of native NIGHT in the wallet's unshielded balance map. */
const NIGHT_HEX = unshieldedToken().raw;

/** The compiler 0.34.0 circuit set; `verifyAddress` compares it against the chain. */
const CIRCUITS = [
  'convertToShielded',
  'convertToUnshielded',
  'decimals',
  'depositShielded',
  'depositUnshielded',
  'getBalance',
  'name',
  'symbol',
  'tokenColor',
  'withdrawShielded',
  'withdrawUnshielded',
] as const;

const DEPLOY_ARGS = ['Shielded Night', 'sNight', 6n] as const;

/** The contract's wrapper domain separator (`pad(32, "shielded-night:wrapper")`). */
const WRAP_DOMAIN = 'shielded-night:wrapper';

type Coin = { nonce: Uint8Array; color: Uint8Array; value: bigint };
type CoinPublicKey = { bytes: Uint8Array };
type EitherAddress = {
  is_left: boolean;
  left: { bytes: Uint8Array };
  right: { bytes: Uint8Array };
};

interface CallOutcome<TResult> {
  readonly public: { readonly txId: string };
  readonly private: { readonly result: TResult };
}

/**
 * The circuit surface of `managed/contract/index.d.ts`, restated at the SDK
 * seam. `deployContract` / `findDeployedContract` are called through the same
 * `as never` seam `scripts/deploy.ts` uses, so their nominal Compact types
 * cannot pull a second runtime identity into this package; the handle below is
 * what the suite actually needs from the result.
 */
interface ShieldedNight {
  readonly deployTxData: { readonly public: { readonly contractAddress: string } };
  readonly callTx: {
    name(): Promise<CallOutcome<string>>;
    symbol(): Promise<CallOutcome<string>>;
    decimals(): Promise<CallOutcome<bigint>>;
    tokenColor(): Promise<CallOutcome<Uint8Array>>;
    getBalance(secret: Uint8Array): Promise<CallOutcome<bigint>>;
    depositUnshielded(secret: Uint8Array, amount: bigint): Promise<CallOutcome<[]>>;
    depositShielded(secret: Uint8Array, coin: Coin): Promise<CallOutcome<[]>>;
    withdrawUnshielded(secret: Uint8Array, amount: bigint, recipient: EitherAddress): Promise<CallOutcome<[]>>;
    withdrawShielded(
      secret: Uint8Array,
      amount: bigint,
      recipient: CoinPublicKey,
      nonce: Uint8Array,
    ): Promise<CallOutcome<Coin>>;
    convertToShielded(amount: bigint, recipient: CoinPublicKey, nonce: Uint8Array): Promise<CallOutcome<Coin>>;
    convertToUnshielded(coin: Coin, recipient: EitherAddress): Promise<CallOutcome<[]>>;
  };
}

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

/** Right-pad a UTF-8 string into a `Bytes<N>` domain separator. */
const padDomain = (value: string, length = 32): Uint8Array => {
  const buffer = new Uint8Array(length);
  const encoded = new TextEncoder().encode(value);
  if (encoded.length > length) throw new Error(`Domain "${value}" is ${encoded.length} bytes; max ${length}.`);
  buffer.set(encoded);
  return buffer;
};

const randomBytes32 = (): Uint8Array => {
  const buffer = new Uint8Array(32);
  globalThis.crypto.getRandomValues(buffer);
  return buffer;
};

/** `Either<ContractAddress, UserAddress>` with the user (right) branch populated. */
const rightUserAddress = (bytes: Uint8Array): EitherAddress => ({
  is_left: false,
  left: { bytes: new Uint8Array(32) },
  right: { bytes },
});

/** Flatten an error chain (Effect wrappers, causes) into searchable text. */
const errorText = (error: unknown): string => {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current != null && depth < 10; depth += 1) {
    if (current instanceof Error) {
      parts.push(current.message, String(current));
      current = current.cause;
    } else {
      parts.push(typeof current === 'string' ? current : JSON.stringify(current));
      break;
    }
  }
  return parts.join('\n');
};

const WAIT_TIMEOUT_MS = 5 * 60_000;

const waitForBalance = (
  wallet: WalletFacade,
  bucket: 'unshielded' | 'shielded',
  tokenHex: string,
  predicate: (balance: bigint) => boolean,
): Promise<bigint> =>
  Rx.firstValueFrom(
    wallet.state().pipe(
      Rx.throttleTime(2_000),
      Rx.filter((state) => state.isSynced),
      Rx.map((state) => state[bucket].balances[tokenHex] ?? 0n),
      Rx.filter(predicate),
      Rx.timeout({
        each: WAIT_TIMEOUT_MS,
        with: () =>
          Rx.throwError(
            () => new Error(`waitForBalance(${bucket}, ${tokenHex}) timed out after ${WAIT_TIMEOUT_MS}ms`),
          ),
      }),
    ),
  );

const firstSyncedState = (wallet: WalletFacade) =>
  Rx.firstValueFrom(wallet.state().pipe(Rx.filter((state) => state.isSynced)));

/** The resolved env/profile the global setup probed, or a clear refusal. */
const resolvedEnv = (): V2EnvName => {
  const value = process.env[RESOLVED_ENV_VAR];
  if (value !== 'stagenet' && value !== 'undeployed') {
    throw new Error(`${RESOLVED_ENV_VAR} was not set by the global setup; run this suite through its own config.`);
  }
  return value;
};

const resolvedProfile = (env: V2EnvName): V2Profile => {
  const raw = process.env[RESOLVED_PROFILE_VAR];
  return raw ? (JSON.parse(raw) as V2Profile) : profileFor(env);
};

/**
 * Driver seed. Genesis-1 is the default only on a local devnet — it is that
 * stack's funding faucet and is shared with every other facade deployed there,
 * so a run that matters passes MN_SEED.
 */
const driverSeed = (env: V2EnvName): string => {
  const seed = process.env.MN_SEED?.trim();
  if (seed) {
    if (!/^[0-9a-f]+$/i.test(seed) || seed.length % 2 !== 0) {
      throw new Error('MN_SEED must be an even-length hexadecimal string.');
    }
    return seed;
  }
  if (env !== 'undeployed') throw new Error(`MN_SEED is required for MN_ENV=${env}.`);
  console.warn(
    '[external] WARNING: no MN_SEED set; using the shared genesis-1 devnet seed. ' +
      'It funds every other facade on a local stack — pass MN_SEED for anything but a throwaway devnet.',
  );
  return GENESIS_MINT_SEED;
};

describe('shielded-night 2.x — external stack', () => {
  const env = resolvedEnv();
  const profile = resolvedProfile(env);
  const environment = { ...profile, walletNetworkId: walletNetworkIdFor(env) };

  let walletProvider: MidnightWalletProvider;
  let providers: ReturnType<typeof initializeMidnightProviders>;
  let contract: ShieldedNight;
  let address: string;
  let wrapperColorHex: string;
  /** Undefined when the suite joined an existing deployment via CV_ADDRESS. */
  let deployedMaintenanceKey: ReturnType<typeof sampleSigningKey> | undefined;

  beforeAll(async () => {
    setNetworkId(profile.networkId);

    // testkit-js logs the seed at info level, so the wallet logger stays silent
    // for the same reason scripts/deploy.ts keeps it silent.
    walletProvider = await MidnightWalletProvider.build(createWalletLogger(), environment, driverSeed(env));

    // `withSyncedDeploymentWallet` unrolled across vitest's lifecycle: the same
    // start -> bounded sync -> funding assertion, but the wallet has to outlive
    // one action here, and the stop moves to afterAll.
    await walletProvider.start(false);
    const state = await syncWallet(walletProvider.wallet, 2_000, deploymentWalletSyncTimeoutMs());
    assertDeploymentWalletFunded(state);

    providers = initializeMidnightProviders(walletProvider, environment, {
      privateStateStoreName: privateStateStoreName(env, '-test'),
      zkConfigPath: MANAGED_DIRECTORY,
    });

    const compiled = CompiledContract.make('shielded-night-v2', Contract).pipe(
      CompiledContract.withVacantWitnesses,
      CompiledContract.withCompiledFileAssets(MANAGED_DIRECTORY),
    );

    const joinAddress = process.env.CV_ADDRESS?.trim();
    if (joinAddress) {
      contract = (await findDeployedContract(providers as never, {
        compiledContract: compiled,
        contractAddress: joinAddress.replace(/^0x/i, '').toLowerCase(),
      } as never)) as unknown as ShieldedNight;
      console.log(`[external] joined ${env} contract ${contract.deployTxData.public.contractAddress}`);
    } else {
      // Test-only maintenance key: sampled per run and never written to a
      // maintenance-key file, because a throwaway contract needs no custody.
      deployedMaintenanceKey = sampleSigningKey('schnorr');
      contract = (await deployContract(providers as never, {
        compiledContract: compiled,
        args: [...DEPLOY_ARGS],
        signingKey: deployedMaintenanceKey,
      } as never)) as unknown as ShieldedNight;
      console.log(`[external] deployed ${env} contract ${contract.deployTxData.public.contractAddress}`);
    }

    address = contract.deployTxData.public.contractAddress.replace(/^0x/i, '').toLowerCase();
    wrapperColorHex = bytesToHex((await contract.callTx.tokenColor()).private.result);
  }, 20 * 60_000);

  afterAll(async () => {
    const disposable = providers?.publicDataProvider as { dispose?: () => Promise<void> } | undefined;
    await disposable?.dispose?.().catch(() => undefined);
    await walletProvider?.stop().catch(() => undefined);
  });

  test(
    'serves the 11-circuit set, matching verifier keys, and the release metadata',
    async () => {
      const verified = await verifyAddress(providers.publicDataProvider, address);

      expect(verified.address).toBe(address);
      expect(Object.keys(verified.verifierKeys).sort()).toEqual([...CIRCUITS]);
      expect(verified.metadata).toEqual({ name: 'Shielded Night', symbol: 'sNight', decimals: 6 });

      if (deployedMaintenanceKey) {
        // A contract this suite deployed must carry this run's sampled key as
        // its sole maintenance authority.
        expect(() =>
          assertMaintenanceAuthorityKey(verified, signatureVerifyingKey(deployedMaintenanceKey!)),
        ).not.toThrow();
      }

      expect((await contract.callTx.name()).private.result).toBe('Shielded Night');
      expect((await contract.callTx.symbol()).private.result).toBe('sNight');
      expect((await contract.callTx.decimals()).private.result).toBe(6n);

      // The wrapper colour is `tokenType(pad(32,"shielded-night:wrapper"), self())`
      // on chain; the same value has to be derivable off chain from the address.
      expect(wrapperColorHex).toHaveLength(64);
      expect(wrapperColorHex).toBe(rawTokenType(padDomain(WRAP_DOMAIN), address));
    },
    10 * 60_000,
  );

  test(
    'two-step round trip: NIGHT -> credit -> sNight -> credit -> NIGHT',
    async () => {
      const secret = randomBytes32();
      const night0 = (await firstSyncedState(walletProvider.wallet)).unshielded.balances[NIGHT_HEX] ?? 0n;
      expect(night0).toBeGreaterThanOrEqual(N);
      const wrapped0 = (await firstSyncedState(walletProvider.wallet)).shielded.balances[wrapperColorHex] ?? 0n;

      // 1. Lock native NIGHT, credit hash(secret).
      await contract.callTx.depositUnshielded(secret, N);
      expect((await contract.callTx.getBalance(secret)).private.result).toBe(N);
      expect(
        await waitForBalance(walletProvider.wallet, 'unshielded', NIGHT_HEX, (balance) => balance <= night0 - N),
      ).toBe(night0 - N);

      // 2. Mint the shielded wrapper against the credit.
      const coinPublicKey: CoinPublicKey = {
        bytes: (await firstSyncedState(walletProvider.wallet)).shielded.coinPublicKey.data,
      };
      const coin = (await contract.callTx.withdrawShielded(secret, N, coinPublicKey, randomBytes32())).private.result;
      expect(coin.value).toBe(N);
      expect(bytesToHex(coin.color)).toBe(wrapperColorHex);
      expect((await contract.callTx.getBalance(secret)).private.result).toBe(0n);
      expect(
        await waitForBalance(
          walletProvider.wallet,
          'shielded',
          wrapperColorHex,
          (balance) => balance >= wrapped0 + N,
        ),
      ).toBe(wrapped0 + N);

      // 3. Burn that exact wrapper coin, credit hash(secret) again.
      await contract.callTx.depositShielded(secret, coin);
      expect((await contract.callTx.getBalance(secret)).private.result).toBe(N);
      expect(
        await waitForBalance(walletProvider.wallet, 'shielded', wrapperColorHex, (balance) => balance <= wrapped0),
      ).toBe(wrapped0);

      // 4. Release the locked NIGHT back to the caller.
      const me = rightUserAddress(encodeUserAddress(walletProvider.unshieldedKeystore.getAddress()));
      await contract.callTx.withdrawUnshielded(secret, N, me);
      expect((await contract.callTx.getBalance(secret)).private.result).toBe(0n);
      expect(
        await waitForBalance(walletProvider.wallet, 'unshielded', NIGHT_HEX, (balance) => balance >= night0),
      ).toBe(night0);
    },
    10 * 60_000,
  );

  test(
    'atomic round trip: convertToShielded then convertToUnshielded',
    async () => {
      const night0 = (await firstSyncedState(walletProvider.wallet)).unshielded.balances[NIGHT_HEX] ?? 0n;
      expect(night0).toBeGreaterThanOrEqual(N);
      const wrapped0 = (await firstSyncedState(walletProvider.wallet)).shielded.balances[wrapperColorHex] ?? 0n;
      const coinPublicKey: CoinPublicKey = {
        bytes: (await firstSyncedState(walletProvider.wallet)).shielded.coinPublicKey.data,
      };

      // One transaction, one approval: lock NIGHT and mint the wrapper.
      const coin = (await contract.callTx.convertToShielded(N, coinPublicKey, randomBytes32())).private.result;
      expect(coin.value).toBe(N);
      expect(bytesToHex(coin.color)).toBe(wrapperColorHex);
      expect(
        await waitForBalance(walletProvider.wallet, 'unshielded', NIGHT_HEX, (balance) => balance <= night0 - N),
      ).toBe(night0 - N);
      expect(
        await waitForBalance(
          walletProvider.wallet,
          'shielded',
          wrapperColorHex,
          (balance) => balance >= wrapped0 + N,
        ),
      ).toBe(wrapped0 + N);

      // One transaction back: burn the wrapper and release the NIGHT.
      const me = rightUserAddress(encodeUserAddress(walletProvider.unshieldedKeystore.getAddress()));
      await contract.callTx.convertToUnshielded(coin, me);
      expect(
        await waitForBalance(walletProvider.wallet, 'shielded', wrapperColorHex, (balance) => balance <= wrapped0),
      ).toBe(wrapped0);
      expect(
        await waitForBalance(walletProvider.wallet, 'unshielded', NIGHT_HEX, (balance) => balance >= night0),
      ).toBe(night0);
    },
    10 * 60_000,
  );

  test(
    'a withdrawal with the wrong secret is refused',
    async () => {
      const secret = randomBytes32();
      await contract.callTx.depositUnshielded(secret, N);
      expect((await contract.callTx.getBalance(secret)).private.result).toBe(N);

      const me = rightUserAddress(encodeUserAddress(walletProvider.unshieldedKeystore.getAddress()));
      let failure: unknown;
      try {
        await contract.callTx.withdrawUnshielded(randomBytes32(), N, me);
      } catch (error) {
        failure = error;
      }
      expect(failure, 'expected the wrong-secret withdrawal to fail').toBeDefined();
      expect(errorText(failure)).toContain('no balance for this secret');

      // The credit is untouched, and the rightful secret still redeems it.
      expect((await contract.callTx.getBalance(secret)).private.result).toBe(N);
      await contract.callTx.withdrawUnshielded(secret, N, me);
      expect((await contract.callTx.getBalance(secret)).private.result).toBe(0n);
    },
    10 * 60_000,
  );
});
