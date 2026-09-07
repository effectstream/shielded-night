import { CompiledContract } from '@midnight-ntwrk/compact-js';
import { ContractState } from '@midnight-ntwrk/compact-runtime';
import * as ledgerV1 from '@midnight-ntwrk/ledger-v8';
import { submitCallTx } from '@midnight-ntwrk/midnight-js-contracts';
import { FetchZkConfigProvider } from '@midnight-ntwrk/midnight-js-fetch-zk-config-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { createProofProvider } from '@midnight-ntwrk/midnight-js-types';
import { MidnightBech32m } from '@midnight-ntwrk/wallet-sdk-address-format';
import * as ShieldedNight from '../../../../src/managed/contract/index.js';
import { createProtocolSession, createWalletBoundary } from '../../shared/adapter-core';
import type { ProfileBridge } from '../../shared/types';

const ASSET_PATH = './contract/v1/shielded-night';
const compiled = (CompiledContract.make as unknown as (name: string, contract: unknown) => any)(
  'ShieldedNight-v1',
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
  return ledgerV1.rawTokenType(domain, contractAddress).toLowerCase();
}

const bridge: ProfileBridge = {
  protocolFamily: 'midnight-1.x',
  setNetworkId,
  deserializeFinalizedTransaction: (bytes) => ledgerV1.Transaction.deserialize(
    'signature',
    'proof',
    'binding',
    bytes,
  ) as unknown as ReturnType<ProfileBridge['deserializeFinalizedTransaction']>,
  addressToBytes,
  nativeNightKeys() {
    return [ledgerV1.nativeToken().raw, ledgerV1.unshieldedToken().raw].map((value) => value.toLowerCase());
  },
  deriveWrapperColor,
  async buildProviders(input) {
    const configuration = await input.connectedAPI.getConfiguration();
    const zkConfigProvider = new FetchZkConfigProvider(ASSET_PATH, window.fetch.bind(window));
    const publicDataProvider = indexerPublicDataProvider(configuration.indexerUri, configuration.indexerWsUri);
    const originalQuery = publicDataProvider.queryZSwapAndContractState.bind(publicDataProvider);
    publicDataProvider.queryZSwapAndContractState = async (...args: Parameters<typeof originalQuery>) => {
      const result = await originalQuery(...args);
      return result
        ? [result[0].postBlockUpdate(new Date()), result[1], result[2]]
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
      proofProvider: createProofProvider(provingProvider),
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
        const runtimeState = ContractState.deserialize(state.serialize());
        const value = ShieldedNight.ledger(runtimeState.data);
        return { name: value._name, symbol: value._symbol };
      },
    };
  },
};

export function createV1Adapter(
  connectedAPI: Parameters<typeof createProtocolSession>[0]['connectedAPI'],
  networkId: string,
  contractAddress: string,
) {
  return createProtocolSession({ bridge, connectedAPI, networkId, contractAddress });
}
