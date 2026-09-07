import type { ConnectedAPI } from '@midnight-ntwrk/dapp-connector-api';

export type ProtocolFamily = 'midnight-1.x' | 'midnight-2.x';
export type Direction = 'toShielded' | 'toUnshielded';
export type SwapStep = 'started' | 'deposited' | 'done';

export interface Balances {
  nativeNight: bigint;
  wrapper: bigint;
  wrapperMatched: boolean;
  nativeTokenId?: string;
  wrapperTokenId?: string;
  allShielded: Record<string, bigint>;
  allUnshielded: Record<string, bigint>;
  trackedWrapperCoins: ShieldedCoinInfo[];
  blockedWrapperCoins: BlockedWrapperCoin[];
}

export interface BlockedWrapperCoin {
  status: 'pending' | 'uncertain';
  value: bigint;
  transactionId?: string;
  networkId?: string;
}

export interface SwapCallbacks {
  onStep?: (step: SwapStep, label: string) => void;
  onLog?: (message: string) => void;
}

export interface ShieldedCoinInfo {
  nonce: Uint8Array;
  color: Uint8Array;
  value: bigint;
}

export interface ProtocolSession {
  readonly protocolFamily: ProtocolFamily;
  readonly connectedAPI: ConnectedAPI;
  readonly networkId: string;
  readonly contractAddress: string;
  readonly coinPublicKey: string;
  readonly unshieldedAddress: string;
  readonly wrapperColorHex: string;
  addressToBytes(address: string): Uint8Array;
  trackedWrapperCoins(): ShieldedCoinInfo[];
  wrapperCoinState(): { available: ShieldedCoinInfo[]; blocked: BlockedWrapperCoin[] };
  resumeShieldedWithdrawal(secret: Uint8Array, amount: bigint): Promise<void>;
  readMetadata(): Promise<{ name: string; symbol: string }>;
  refreshBalances(): Promise<Balances>;
  convert(direction: Direction, amount: bigint, callbacks?: SwapCallbacks): Promise<void>;
  callCircuit(circuitId: string, args: unknown[]): Promise<{ private: { result: unknown } }>;
  dispose(): void;
}

export interface ProfileBridge {
  readonly protocolFamily: ProtocolFamily;
  setNetworkId(networkId: string): void;
  deserializeFinalizedTransaction(bytes: Uint8Array): {
    identifiers(): string[];
    serialize(): Uint8Array;
  };
  addressToBytes(address: string): Uint8Array;
  nativeNightKeys(): string[];
  deriveWrapperColor(contractAddress: string): string;
  buildProviders(input: {
    connectedAPI: ConnectedAPI;
    networkId: string;
    contractAddress: string;
    shieldedAddress: {
      shieldedAddress: string;
      shieldedCoinPublicKey: string;
      shieldedEncryptionPublicKey: string;
    };
    isActive(): boolean;
    onSubmitted(transactionId: string): void;
  }): Promise<{
    providers: Record<string, unknown> & {
      publicDataProvider: {
        queryContractState(address: string): Promise<unknown>;
        dispose?: () => void | Promise<void>;
      };
    };
    call(circuitId: string, args: unknown[]): Promise<{ private: { result: unknown } }>;
    readMetadata(): Promise<{ name: string; symbol: string }>;
  }>;
}
