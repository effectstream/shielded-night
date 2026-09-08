import { CompiledContract } from '@midnight-ntwrk/compact-js';
import { ContractState } from '@midnight-ntwrk/compact-runtime';
import { submitCallTx } from '@midnight-ntwrk/midnight-js-contracts';
import { FetchZkConfigProvider } from '@midnight-ntwrk/midnight-js-fetch-zk-config-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { createProofProvider } from '@midnight-ntwrk/midnight-js-types';
import * as ledgerV2 from '@midnightntwrk/ledger-v9';
import { MidnightBech32m } from '@midnightntwrk/wallet-sdk-address-format';
import * as ShieldedNight from '../../../../contracts/v2/managed/contract/index.js';
import { createProtocolSession, createWalletBoundary } from '../../shared/adapter-core';
import { contractAssetBaseUrl, requireAbsoluteUrl } from '../../shared/asset-url';
import type { ProfileBridge } from '../../shared/types';

// Metadata only: `withCompiledFileAssets` stores this path on the compiled
// contract and never fetches with it. The provider below needs an absolute URL.
const ASSET_PATH = './contract/v2/shielded-night';
const compiled = (CompiledContract.make as unknown as (name: string, contract: unknown) => any)(
  'ShieldedNight-v2',
  ShieldedNight.Contract,
).pipe(
  CompiledContract.withVacantWitnesses,
  (CompiledContract.withCompiledFileAssets as unknown as (path: string) => unknown)(ASSET_PATH),
);

function addressToBytes(value: string): Uint8Array {
  const clean = value.trim().replace(/^0x/i, '');
  if (/^[0-9a-f]+$/i.test(clean) && clean.length % 2 === 0) {
    return Uint8Array.from(clean.match(/.{2}/g) ?? [], (part) => Number.parseInt(part, 16));
  }
  return Uint8Array.from((MidnightBech32m.parse(value) as unknown as { data: Uint8Array }).data);
}

function deriveWrapperColor(contractAddress: string): string {
  const domain = new Uint8Array(32);
  domain.set(new TextEncoder().encode('shielded-night:wrapper'));
  return ledgerV2.rawTokenType(domain, contractAddress).toLowerCase();
}

const bridge: ProfileBridge = {
  protocolFamily: 'midnight-2.x',
  setNetworkId,
  deserializeFinalizedTransaction: (bytes) => ledgerV2.Transaction.deserialize(
    'signature',
    'proof',
    'binding',
    bytes,
  ) as unknown as ReturnType<ProfileBridge['deserializeFinalizedTransaction']>,
  addressToBytes,
  nativeNightKeys() {
    return [ledgerV2.nativeToken().raw, ledgerV2.unshieldedToken().raw].map((value) => value.toLowerCase());
  },
  deriveWrapperColor,
  async buildProviders(input) {
    const configuration = await input.connectedAPI.getConfiguration();
    // The SDK validates this argument with a bare `new URL(baseURL)`, so it must
    // be absolute; a relative path throws "Failed to construct 'URL': Invalid URL".
    const zkConfigProvider = new FetchZkConfigProvider(
      contractAssetBaseUrl('v2', { origin: window.location.origin, base: import.meta.env.BASE_URL }),
      { fetchFunc: window.fetch.bind(window) },
    );
    // Same bare `new URL()` check inside the indexer provider: name the offending
    // field and value instead of surfacing the opaque TypeError.
    const publicDataProvider = indexerPublicDataProvider({
      queryURL: requireAbsoluteUrl(configuration.indexerUri, 'indexer URL', ['http:', 'https:']),
      subscriptionURL: requireAbsoluteUrl(configuration.indexerWsUri, 'indexer WebSocket URL', ['ws:', 'wss:']),
    });
    const originalQuery = publicDataProvider.queryZSwapAndContractState.bind(publicDataProvider);
    publicDataProvider.queryZSwapAndContractState = async (...args: Parameters<typeof originalQuery>) => {
      const result = await originalQuery(...args);
      return result
        // v9 requires the Merkle-root retention window explicitly. The newly
        // inserted current root is sufficient for the transaction being built.
        ? [result[0].postBlockUpdate(new Date(), 0n), result[1], result[2]]
        : result;
    };
    const provingProvider = await input.connectedAPI.getProvingProvider(zkConfigProvider.asKeyMaterialProvider());
    const { walletProvider, midnightProvider } = createWalletBoundary(
      input.connectedAPI,
      input.shieldedAddress,
      bridge,
      input.isActive,
      input.networkId,
      input.onSubmitted,
    );
    const providers = {
      privateStateProvider: levelPrivateStateProvider({
        privateStoragePasswordProvider: () => 'shielded-night-dapp-storage-password!',
        accountId: input.shieldedAddress.shieldedAddress,
      }),
      publicDataProvider,
      zkConfigProvider,
      // Connector API 4.x types predate ledger-v9's added lookupKey method;
      // stagenet wallets implement the v9 proving boundary at runtime.
      proofProvider: createProofProvider(provingProvider as Parameters<typeof createProofProvider>[0]),
      walletProvider,
      midnightProvider,
    };
    return {
      providers,
      call: (circuitId, args) => submitCallTx(providers as never, {
        compiledContract: compiled,
        contractAddress: input.contractAddress,
        circuitId,
        args,
      } as never) as unknown as Promise<{ private: { result: unknown } }>,
      async readMetadata() {
        const state = await publicDataProvider.queryContractState(input.contractAddress);
        if (!state) throw new Error(`No contract state found at ${input.contractAddress}.`);
        // Both the indexer and generated contract resolve through this profile's
        // single runtime identity; serialize/deserialize also pins the boundary.
        const runtimeState = ContractState.deserialize(state.serialize());
        const value = ShieldedNight.ledger(runtimeState.data);
        return { name: value._name, symbol: value._symbol };
      },
    };
  },
};

export function createV2Adapter(
  connectedAPI: Parameters<typeof createProtocolSession>[0]['connectedAPI'],
  networkId: string,
  contractAddress: string,
) {
  return createProtocolSession({ bridge, connectedAPI, networkId, contractAddress });
}
