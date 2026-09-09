import type { ConnectedAPI } from '@midnight-ntwrk/dapp-connector-api';
import type {
  Balances,
  Direction,
  ProfileBridge,
  ProtocolSession,
  ShieldedCoinInfo,
  SwapCallbacks,
} from './types.js';
import { createWrapperCoinStore, type CoinStorage } from './coin-store.js';

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(value: string): Uint8Array {
  const hex = value.trim().replace(/^0x/i, '');
  if (!hex || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) {
    throw new Error('The wallet returned an invalid transaction encoding.');
  }
  return Uint8Array.from(hex.match(/.{2}/g) ?? [], (part) => Number.parseInt(part, 16));
}

function normalizeTokenId(value: string): string {
  return value.trim().replace(/^0x/i, '').toLowerCase();
}

function pickBalance(
  balances: Record<string, bigint>,
  candidates: readonly string[],
): { key: string; value: bigint } | undefined {
  const normalized = new Set(candidates.map(normalizeTokenId));
  const matches = Object.entries(balances).filter(([key]) => normalized.has(normalizeTokenId(key)));
  if (matches.length > 1) throw new Error(`Wallet returned duplicate token identifiers for ${candidates[0]}.`);
  return matches.length === 1 ? { key: matches[0][0], value: BigInt(matches[0][1]) } : undefined;
}

function randomBytes32(): Uint8Array {
  const value = new Uint8Array(32);
  globalThis.crypto.getRandomValues(value);
  return value;
}

function inactiveError(): Error {
  return new Error('The selected network changed; reconnect the wallet before submitting.');
}

function requireShieldedCoin(value: unknown, expected: ShieldedCoinInfo): ShieldedCoinInfo {
  if (!value || typeof value !== 'object') throw new Error('The contract did not return the minted sNight coin.');
  const coin = value as Partial<ShieldedCoinInfo>;
  if (!(coin.nonce instanceof Uint8Array) || !(coin.color instanceof Uint8Array) || typeof coin.value !== 'bigint') {
    throw new Error('The contract returned malformed sNight coin data.');
  }
  if (coin.nonce.length !== 32 || coin.color.length !== 32 || coin.value !== expected.value) {
    throw new Error('The contract returned unexpected sNight coin data.');
  }
  if (bytesToHex(coin.color) !== bytesToHex(expected.color) || bytesToHex(coin.nonce) !== bytesToHex(expected.nonce)) {
    throw new Error('The contract returned a coin with an unexpected nonce or token identity.');
  }
  return { nonce: coin.nonce.slice(), color: coin.color.slice(), value: coin.value };
}

function isWalletCancellation(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current = error;
  for (let depth = 0; current != null && depth < 8 && !seen.has(current); depth += 1) {
    seen.add(current);
    if (typeof current !== 'object') return false;
    const value = current as { code?: unknown; reason?: unknown; message?: unknown; cause?: unknown };
    const code = String(value.code ?? '').toUpperCase();
    if (['4001', 'ACTION_REJECTED', 'USER_REJECTED', 'USER_CANCELLED', 'USER_CANCELED'].includes(code)) return true;
    const detail = [value.reason, value.message].filter((part): part is string => typeof part === 'string').join(' ');
    if (/\buser (?:rejected|declined|cancelled|canceled|denied|aborted)\b/i.test(detail)) return true;
    current = value.cause;
  }
  return false;
}

function submissionIdentity(error: unknown): { transactionId: string; networkId?: string } | undefined {
  const seen = new Set<unknown>();
  let current = error;
  for (let depth = 0; current != null && depth < 10 && !seen.has(current); depth += 1) {
    seen.add(current);
    if (typeof current !== 'object') return undefined;
    const value = current as { transactionId?: unknown; networkId?: unknown; cause?: unknown };
    if (typeof value.transactionId === 'string' && value.transactionId) {
      return {
        transactionId: value.transactionId,
        ...(typeof value.networkId === 'string' && value.networkId ? { networkId: value.networkId } : {}),
      };
    }
    current = value.cause;
  }
  return undefined;
}

export function createWalletBoundary(
  connectedAPI: ConnectedAPI,
  shieldedAddress: {
    shieldedCoinPublicKey: string;
    shieldedEncryptionPublicKey: string;
  },
  bridge: Pick<ProfileBridge, 'deserializeFinalizedTransaction'>,
  isActive: () => boolean,
  expectedNetworkId: string,
  onSubmitted: (transactionId: string) => void = () => undefined,
) {
  const walletBalancedTransactions = new WeakMap<object, string>();
  const assertWalletNetwork = async () => {
    if (!isActive()) throw inactiveError();
    const configuration = await connectedAPI.getConfiguration();
    if (!isActive()) throw inactiveError();
    if (configuration.networkId !== expectedNetworkId) {
      throw new Error(`Wallet changed to ${configuration.networkId}; reconnect it to ${expectedNetworkId}.`);
    }
  };
  const walletProvider = {
    getCoinPublicKey: () => shieldedAddress.shieldedCoinPublicKey,
    getEncryptionPublicKey: () => shieldedAddress.shieldedEncryptionPublicKey,
    async balanceTx(transaction: { serialize(): Uint8Array }) {
      await assertWalletNetwork();
      if (!isActive()) throw inactiveError();
      const result = await connectedAPI.balanceUnsealedTransaction(bytesToHex(transaction.serialize()));
      await assertWalletNetwork();
      const balanced = bridge.deserializeFinalizedTransaction(hexToBytes(result.tx));
      walletBalancedTransactions.set(balanced, normalizeTokenId(result.tx));
      return balanced;
    },
  };
  const midnightProvider = {
    async submitTx(transaction: { identifiers(): string[]; serialize(): Uint8Array }) {
      await assertWalletNetwork();
      if (!isActive()) throw inactiveError();
      const transactionId = transaction.identifiers()[0];
      if (!transactionId) throw new Error('The balanced transaction has no identifier.');
      const exactWalletBytes = walletBalancedTransactions.get(transaction) ?? bytesToHex(transaction.serialize());
      walletBalancedTransactions.delete(transaction);
      try {
        if (!isActive()) throw inactiveError();
        await connectedAPI.submitTransaction(exactWalletBytes);
        onSubmitted(transactionId);
      } catch (error) {
        if (isWalletCancellation(error)) throw error;
        throw Object.assign(
          new Error(`Transaction ${transactionId} submission on ${expectedNetworkId} could not be confirmed.`, { cause: error }),
          { transactionId, networkId: expectedNetworkId },
        );
      }
      return transactionId;
    },
  };
  return { walletProvider, midnightProvider };
}

export async function createProtocolSession(input: {
  bridge: ProfileBridge;
  connectedAPI: ConnectedAPI;
  networkId: string;
  contractAddress: string;
  coinStorage?: CoinStorage;
}): Promise<ProtocolSession> {
  const { bridge, connectedAPI, networkId, contractAddress } = input;
  let active = true;
  bridge.setNetworkId(networkId);
  const configuration = await connectedAPI.getConfiguration();
  if (configuration.networkId !== networkId) {
    throw new Error(`Wallet is on ${configuration.networkId}; select ${networkId} in the wallet and reconnect.`);
  }
  const [shieldedAddress, unshielded] = await Promise.all([
    connectedAPI.getShieldedAddresses(),
    connectedAPI.getUnshieldedAddress(),
  ]);
  const wrapperColorHex = bridge.deriveWrapperColor(contractAddress);
  const coinStore = createWrapperCoinStore({
    protocolFamily: bridge.protocolFamily,
    networkId,
    contractAddress,
    storage: input.coinStorage,
  });
  const submissionState: { current?: { transactionId: string; networkId: string } } = {};
  const readSubmittedIdentity = (): { transactionId: string; networkId: string } | undefined =>
    submissionState.current;
  const built = await bridge.buildProviders({
    connectedAPI,
    networkId,
    contractAddress,
    shieldedAddress,
    isActive: () => active,
    onSubmitted: (transactionId) => {
      submissionState.current = { transactionId, networkId };
    },
  });
  let callInFlight = false;

  const assertActiveNetwork = async () => {
    if (!active) throw inactiveError();
    const latest = await connectedAPI.getConfiguration();
    if (!active) throw inactiveError();
    if (latest.networkId !== networkId) {
      throw new Error(`Wallet changed to ${latest.networkId}; reconnect it to ${networkId}.`);
    }
    bridge.setNetworkId(networkId);
  };

  const callCircuit = async (circuitId: string, args: unknown[]) => {
    if (callInFlight) throw new Error('Another wallet transaction is already in progress.');
    callInFlight = true;
    submissionState.current = undefined;
    try {
      await assertActiveNetwork();
      return await built.call(circuitId, args);
    } catch (error) {
      const submitted = readSubmittedIdentity();
      if (!submissionIdentity(error) && submitted) {
        throw Object.assign(
          new Error(`Transaction ${submitted.transactionId} was submitted on ${submitted.networkId}, but finalization could not be confirmed.`, { cause: error }),
          submitted,
        );
      }
      throw error;
    } finally {
      callInFlight = false;
    }
  };

  const mintTrackedCoin = async (
    circuitId: 'convertToShielded' | 'withdrawShielded',
    amount: bigint,
    buildArguments: (nonce: Uint8Array) => unknown[],
  ): Promise<void> => {
    const expectedCoin: ShieldedCoinInfo = {
      nonce: randomBytes32(),
      color: hexToBytes(wrapperColorHex),
      value: amount,
    };
    // Persist the coin preimage before wallet interaction. A pending record is
    // deliberately non-spendable until the submitted call returns the exact
    // nonce, color and value that were staged here.
    coinStore.stage(expectedCoin);
    let response: { private: { result: unknown } };
    try {
      response = await callCircuit(circuitId, buildArguments(expectedCoin.nonce));
    } catch (error) {
      const identity = submissionIdentity(error);
      if (identity) coinStore.markUncertain(expectedCoin, identity.transactionId, identity.networkId ?? networkId);
      else coinStore.remove(expectedCoin);
      throw error;
    }
    const returnedCoin = requireShieldedCoin(response.private.result, expectedCoin);
    coinStore.add(returnedCoin);
  };

  return {
    protocolFamily: bridge.protocolFamily,
    connectedAPI,
    networkId,
    contractAddress,
    coinPublicKey: shieldedAddress.shieldedCoinPublicKey,
    unshieldedAddress: unshielded.unshieldedAddress,
    wrapperColorHex,
    addressToBytes: bridge.addressToBytes,
    trackedWrapperCoins: coinStore.available,
    wrapperCoinState: () => ({ available: coinStore.available(), blocked: coinStore.blocked() }),
    async resumeShieldedWithdrawal(secret: Uint8Array, amount: bigint) {
      if (amount <= 0n) throw new Error('Stored swap contains an invalid amount.');
      await mintTrackedCoin('withdrawShielded', amount, (nonce) => [
        secret,
        amount,
        { bytes: bridge.addressToBytes(shieldedAddress.shieldedCoinPublicKey) },
        nonce,
      ]);
    },
    async readMetadata() {
      await assertActiveNetwork();
      const metadata = await built.readMetadata();
      await assertActiveNetwork();
      return metadata;
    },
    async refreshBalances(): Promise<Balances> {
      await assertActiveNetwork();
      const [shielded, unshieldedBalances] = await Promise.all([
        connectedAPI.getShieldedBalances(),
        connectedAPI.getUnshieldedBalances(),
      ]);
      await assertActiveNetwork();
      const native = pickBalance(unshieldedBalances, bridge.nativeNightKeys());
      const wrapper = pickBalance(shielded, [wrapperColorHex]);
      return {
        nativeNight: native?.value ?? 0n,
        wrapper: wrapper?.value ?? 0n,
        wrapperMatched: wrapper !== undefined,
        nativeTokenId: native?.key ?? bridge.nativeNightKeys()[0],
        wrapperTokenId: wrapper?.key ?? wrapperColorHex,
        allShielded: shielded,
        allUnshielded: unshieldedBalances,
        trackedWrapperCoins: coinStore.available(),
        blockedWrapperCoins: coinStore.blocked(),
      };
    },
    async convert(direction: Direction, amount: bigint, callbacks: SwapCallbacks = {}) {
      if (amount <= 0n) throw new Error('Enter an amount greater than zero');
      if (direction === 'toShielded') {
        callbacks.onStep?.('started', 'Converting NIGHT → sNight in one transaction…');
        callbacks.onLog?.('convertToShielded — approve in wallet');
        await mintTrackedCoin('convertToShielded', amount, (nonce) => [
          amount,
          { bytes: bridge.addressToBytes(shieldedAddress.shieldedCoinPublicKey) },
          nonce,
        ]);
        callbacks.onStep?.('done', 'Converted in one transaction ✓');
        callbacks.onLog?.(`Minted ${amount} sNight (single tx)`);
        return;
      }
      callbacks.onStep?.('started', 'Converting sNight → NIGHT in one transaction…');
      callbacks.onLog?.('convertToUnshielded — approve in wallet');
      // `convertToUnshielded` claims its coin as an output addressed to the
      // contract; the wallet funds that output from the sNight it holds, with
      // ordinary coin selection (inputs of that token type + change). The nonce
      // is ours to choose and need not match an owned coin, so any amount up to
      // the wallet's balance converts — including coins this browser never saw.
      // Proven on chain in test/integration/shielded-night.reverse-any-amount.test.ts.
      const walletTotal = pickBalance(await connectedAPI.getShieldedBalances(), [wrapperColorHex])?.value ?? 0n;
      if (amount > walletTotal) {
        throw new Error(`The wallet holds ${walletTotal} sNight; enter an amount up to that total.`);
      }
      const coin: ShieldedCoinInfo = {
        nonce: randomBytes32(),
        color: hexToBytes(wrapperColorHex),
        value: amount,
      };
      // No coin-store bookkeeping on this path: the store records what this
      // browser minted, not what can be reversed.
      try {
        await callCircuit('convertToUnshielded', [
          coin,
          {
            is_left: false,
            left: { bytes: new Uint8Array(32) },
            right: { bytes: bridge.addressToBytes(unshielded.unshieldedAddress) },
          },
        ]);
      } catch (error) {
        const identity = submissionIdentity(error);
        if (identity) {
          throw Object.assign(
            new Error(
              `Transaction ${identity.transactionId} was submitted on ${identity.networkId ?? networkId}, but finalization could not be confirmed. Check that transaction before converting again — a blind retry converts more sNight.`,
              { cause: error },
            ),
            { transactionId: identity.transactionId, networkId: identity.networkId ?? networkId },
          );
        }
        throw error;
      }
      callbacks.onStep?.('done', 'Converted in one transaction ✓');
      callbacks.onLog?.(`Released ${amount} NIGHT (single tx)`);
    },
    callCircuit,
    dispose() {
      active = false;
      void built.providers.publicDataProvider.dispose?.();
    },
  };
}
