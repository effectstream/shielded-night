import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { FetchZkConfigProvider } from '@midnight-ntwrk/midnight-js-fetch-zk-config-provider';
import { createProofProvider } from '@midnight-ntwrk/midnight-js/types';
import type { ProvingProvider as LedgerProvingProvider } from '@midnightntwrk/ledger-v9';
import type { ConnectedAPI } from '@midnight-ntwrk/dapp-connector-api';
import type { BlockHashConfig, BlockHeightConfig } from '@midnight-ntwrk/midnight-js/types';
import type { ContractAddress } from '@midnightntwrk/ledger-v9';

import { createWalletProvidersFromConnectedAPI } from './walletAdapter';
import { type ShieldedNightCircuits, type ShieldedNightProviders, ZK_CONFIG_CONTRACT_NAME } from './contract';

export type ShieldedAddress = {
  shieldedAddress: string;
  shieldedCoinPublicKey: string;
  shieldedEncryptionPublicKey: string;
};

/**
 * Assemble the midnight-js provider suite from a connected wallet:
 * - zkConfig: fetched from the served /contract/compiled/shielded-night path
 * - publicData: the wallet's indexer (with a post-block zswap-state refresh)
 * - proof: the WALLET's proving provider - the frontend never names a proof
 *   server (proverServerUri is deprecated in favor of getProvingProvider), so
 *   the wallet owns proving and this works on any deployment.
 * - wallet/midnight: the connected wallet (balance + submit)
 * - privateState: browser leveldb (empty for ShieldedNight, but required)
 */
export async function buildProviders(connectedAPI: ConnectedAPI): Promise<ShieldedNightProviders> {
  const zkConfigBase = window.location.origin + '/contract/compiled/' + ZK_CONFIG_CONTRACT_NAME;
  // midnight-js 5: the second argument is an options bag, not a bare fetch. Integrity
  // verification defaults to 'require' (fail-closed) and checks every artifact against
  // compactc's `compiler/contract-manifest.json` — a file compactc only started emitting
  // at 0.33, so serving `src/managed/` WHOLE (manifest included) is now load-bearing,
  // not merely tidy.
  const zkConfigProvider = new FetchZkConfigProvider<ShieldedNightCircuits>(zkConfigBase, {
    fetchFunc: fetch.bind(window),
  });

  const config = await connectedAPI.getConfiguration();

  const rawPublicDataProvider = indexerPublicDataProvider(config.indexerUri, config.indexerWsUri);
  const publicDataProvider = {
    ...rawPublicDataProvider,
    async queryZSwapAndContractState(addr: ContractAddress, q?: BlockHeightConfig | BlockHashConfig) {
      const result = await rawPublicDataProvider.queryZSwapAndContractState(addr, q);
      if (!result) return result;
      const [zswapChainState, contractState, ledgerParameters] = result;
      return [
        zswapChainState.postBlockUpdate(new Date(), ZSWAP_MERKLE_ROOT_RETENTION_SECONDS),
        contractState,
        ledgerParameters,
      ] as typeof result;
    },
  };

  // Proving is entirely the wallet's domain. The dApp hands over the contract's
  // ZK key material and the WALLET proves, in its own trust boundary - the dApp
  // never names or reaches a proof server (doing so could leak the private
  // witness to a dApp-chosen prover). If a wallet doesn't implement this yet,
  // that's a wallet gap; we surface it rather than working around it.
  if (typeof (connectedAPI as { getProvingProvider?: unknown }).getProvingProvider !== 'function') {
    throw new Error(
      'This wallet does not support dApp proving yet (no getProvingProvider). ' +
        'Proving is wallet-owned by design - update to a wallet build that implements getProvingProvider.',
    );
  }
  const walletProvingProvider = await connectedAPI.getProvingProvider(zkConfigProvider.asKeyMaterialProvider());
  const proofProvider = createProofProvider(withLookupKey(walletProvingProvider, zkConfigProvider));

  const shieldedAddress: ShieldedAddress = await connectedAPI.getShieldedAddresses();
  const { walletProvider, midnightProvider } = createWalletProvidersFromConnectedAPI(connectedAPI, shieldedAddress);

  const privateStateProvider = levelPrivateStateProvider({
    privateStoragePasswordProvider: () => 'shielded-night-dapp-storage-password!',
    accountId: shieldedAddress.shieldedAddress,
  });

  return {
    privateStateProvider,
    publicDataProvider,
    zkConfigProvider,
    proofProvider,
    walletProvider,
    midnightProvider,
  } as unknown as ShieldedNightProviders;
}

/**
 * Seconds of past Merkle-tree roots to retain when rehashing a `ZswapChainState`.
 * ledger-v9 made this argument REQUIRED on `ZswapChainState.postBlockUpdate` (it was
 * implicit in v8); note `LedgerState.postBlockUpdate` is a different method that did
 * not change this way. One hour is the value midnight-js 5 itself uses
 * (`ZSWAP_MERKLE_ROOT_RETENTION_SECONDS` in midnight-js-contracts) — it governs
 * historical roots only, not the current root used here.
 */
const ZSWAP_MERKLE_ROOT_RETENTION_SECONDS = 3600n;

/**
 * Bridge the dApp-connector's `ProvingProvider` to ledger-v9's.
 *
 * ledger-v9 added a third method, `lookupKey(keyLocation) => ProvingKeyMaterial | undefined`,
 * which `createProofProvider` requires. `@midnight-ntwrk/dapp-connector-api` has NOT caught up:
 * neither 4.0.1 (the pinned version) nor 4.1.0-beta.1 declares it, so a wallet that implements
 * it — as a ledger-v9 wallet must — still hands back a value the connector types describe
 * without it.
 *
 * If the wallet supplies `lookupKey`, it is used unchanged. If it does not, we fill it from THIS
 * dApp's own `zkConfigProvider` — the identical artifacts the dApp already served and already
 * handed the wallet through `asKeyMaterialProvider()` above. Nothing private crosses the
 * boundary and nothing moves proving out of the wallet: `check` and `prove` are still the
 * wallet's. Which lane was taken is logged, never silent.
 */
function withLookupKey(
  provider: unknown,
  zkConfigProvider: FetchZkConfigProvider<ShieldedNightCircuits>,
): LedgerProvingProvider {
  const p = provider as Partial<LedgerProvingProvider>;
  if (typeof p.lookupKey === 'function') {
    console.info('[providers] wallet proving provider implements lookupKey (ledger-v9 native)');
    return p as LedgerProvingProvider;
  }
  console.info(
    '[providers] wallet proving provider has no lookupKey; serving key material from the dApp\'s ' +
      'own zkConfigProvider (same public artifacts already passed to getProvingProvider)',
  );
  return {
    ...(p as LedgerProvingProvider),
    async lookupKey(keyLocation: string) {
      const circuitId = keyLocation.split('/').pop() as ShieldedNightCircuits;
      const [proverKey, verifierKey, ir] = await Promise.all([
        zkConfigProvider.getProverKey(circuitId),
        zkConfigProvider.getVerifierKey(circuitId),
        zkConfigProvider.getZKIR(circuitId),
      ]);
      return { proverKey, verifierKey, ir };
    },
  } as LedgerProvingProvider;
}
