import { describe, expect, it, vi } from 'vitest';
import { createProtocolSession, createWalletBoundary } from '../../frontend/protocols/shared/adapter-core.js';
import { createWrapperCoinStore, type CoinStorage } from '../../frontend/protocols/shared/coin-store.js';
import type { ProfileBridge, ProtocolSession, ShieldedCoinInfo } from '../../frontend/protocols/shared/types.js';
import { isCompatibleApiVersion } from '../../frontend/src/lib/connector.js';
import { NETWORKS } from '../../frontend/src/lib/networks.js';
import { loadPending, resumeSwap, type PendingSwap } from '../../frontend/src/lib/swap.js';

const shieldedAddress = {
  shieldedCoinPublicKey: 'coin-key',
  shieldedEncryptionPublicKey: 'encryption-key',
};

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

const transaction = (bytes: number[], id = 'balanced-transaction') => ({
  identifiers: () => [id],
  serialize: () => Uint8Array.from(bytes),
});

const bridge = {
  deserializeFinalizedTransaction(bytes: Uint8Array) {
    return transaction([...bytes]);
  },
};

class MemoryStorage implements CoinStorage {
  readonly values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

async function makeProtocolSession(
  storage: MemoryStorage,
  call: (
    circuitId: string,
    args: unknown[],
    onSubmitted: (transactionId: string) => void,
  ) => Promise<{ private: { result: unknown } }>,
) {
  const wrapperColor = 'ab'.repeat(32);
  const profile: ProfileBridge = {
    protocolFamily: 'midnight-2.x',
    setNetworkId: vi.fn(),
    deserializeFinalizedTransaction: bridge.deserializeFinalizedTransaction,
    addressToBytes: () => new Uint8Array(32),
    nativeNightKeys: () => ['night'],
    deriveWrapperColor: () => wrapperColor,
    buildProviders: async (input) => ({
      providers: { publicDataProvider: { queryContractState: async () => undefined } },
      call: (circuitId, args) => call(circuitId, args, input.onSubmitted),
      readMetadata: async () => ({ name: 'Shielded Night', symbol: 'sNight' }),
    }),
  };
  const api = {
    getConfiguration: vi.fn(async () => ({ networkId: 'stagenet' })),
    getShieldedAddresses: vi.fn(async () => ({
      shieldedAddress: 'shielded',
      shieldedCoinPublicKey: 'coin-key',
      shieldedEncryptionPublicKey: 'encryption-key',
    })),
    getUnshieldedAddress: vi.fn(async () => ({ unshieldedAddress: 'unshielded' })),
    getShieldedBalances: vi.fn(async () => ({ [wrapperColor]: 7n })),
    getUnshieldedBalances: vi.fn(async () => ({ night: 10n })),
  };
  const session = await createProtocolSession({
    bridge: profile,
    connectedAPI: api as never,
    networkId: 'stagenet',
    contractAddress: 'cd'.repeat(32),
    coinStorage: storage,
  });
  return { session, wrapperColor };
}

describe('frontend wallet transaction boundary', () => {
  it('maps the three public selector choices to the required protocol generations', () => {
    expect(NETWORKS.slice(0, 3).map(({ key, protocolFamily }) => ({ key, protocolFamily }))).toEqual([
      { key: 'preview', protocolFamily: 'midnight-1.x' },
      { key: 'preprod', protocolFamily: 'midnight-1.x' },
      { key: 'stagenet', protocolFamily: 'midnight-2.x' },
    ]);
    expect(isCompatibleApiVersion('4.0.1')).toBe(true);
    expect(isCompatibleApiVersion('3.2.0')).toBe(false);
    expect(isCompatibleApiVersion('5.0.0')).toBe(false);
  });

  it('submits the exact wallet-balanced bytes', async () => {
    const submitTransaction = vi.fn(async () => undefined);
    const api = {
      getConfiguration: vi.fn(async () => ({ networkId: 'preview' })),
      balanceUnsealedTransaction: vi.fn(async () => ({ tx: '0A0B0C' })),
      submitTransaction,
    };
    const boundary = createWalletBoundary(api as never, shieldedAddress, bridge, () => true, 'preview');

    const balanced = await boundary.walletProvider.balanceTx({ serialize: () => Uint8Array.of(9, 9) });
    await boundary.midnightProvider.submitTx(balanced);

    expect(api.balanceUnsealedTransaction).toHaveBeenCalledWith('0909');
    expect(submitTransaction).toHaveBeenCalledWith('0a0b0c');
  });

  it('binds interleaved wallet balances to their own transaction objects', async () => {
    const walletResults = [{ tx: 'AAAA' }, { tx: 'BBBB' }];
    const submitTransaction = vi.fn(async () => undefined);
    const api = {
      getConfiguration: vi.fn(async () => ({ networkId: 'preview' })),
      balanceUnsealedTransaction: vi.fn(async () => walletResults.shift()!),
      submitTransaction,
    };
    const boundary = createWalletBoundary(api as never, shieldedAddress, bridge, () => true, 'preview');

    const first = await boundary.walletProvider.balanceTx(transaction([1]));
    const second = await boundary.walletProvider.balanceTx(transaction([2]));
    await boundary.midnightProvider.submitTx(first);
    await boundary.midnightProvider.submitTx(second);

    expect(submitTransaction.mock.calls).toEqual([['aaaa'], ['bbbb']]);
  });

  it('rejects a concurrent production session call while the first call is pending', async () => {
    const storage = new MemoryStorage();
    let releaseFirst!: () => void;
    const firstPending = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const call = vi.fn(async () => {
      await firstPending;
      return { private: { result: undefined } };
    });
    const { session } = await makeProtocolSession(storage, call);

    const first = session.callCircuit('first', []);
    await expect(session.callCircuit('second', [])).rejects.toThrow('Another wallet transaction is already in progress');
    expect(call).toHaveBeenCalledTimes(1);
    releaseFirst();
    await expect(first).resolves.toEqual({ private: { result: undefined } });
  });

  it('does not submit when the session is disposed while wallet balancing is pending', async () => {
    let active = true;
    const submitTransaction = vi.fn(async () => undefined);
    const api = {
      getConfiguration: vi.fn(async () => ({ networkId: 'preview' })),
      balanceUnsealedTransaction: vi.fn(async () => {
        active = false;
        return { tx: '0102' };
      }),
      submitTransaction,
    };
    const boundary = createWalletBoundary(api as never, shieldedAddress, bridge, () => active, 'preview');

    await expect(boundary.walletProvider.balanceTx(transaction([3, 4]))).rejects.toThrow('selected network changed');
    expect(submitTransaction).not.toHaveBeenCalled();
  });

  it('rechecks the wallet network immediately before submission', async () => {
    const networks = ['preview', 'preview', 'preprod'];
    const submitTransaction = vi.fn(async () => undefined);
    const api = {
      getConfiguration: vi.fn(async () => ({ networkId: networks.shift() ?? 'preprod' })),
      balanceUnsealedTransaction: vi.fn(async () => ({ tx: '0506' })),
      submitTransaction,
    };
    const boundary = createWalletBoundary(api as never, shieldedAddress, bridge, () => true, 'preview');

    const balanced = await boundary.walletProvider.balanceTx(transaction([1, 2]));
    await expect(boundary.midnightProvider.submitTx(balanced)).rejects.toThrow('Wallet changed to preprod');
    expect(submitTransaction).not.toHaveBeenCalled();
  });

  it('checks active state again after the final async wallet guard resolves', async () => {
    let activeChecks = 0;
    const submitTransaction = vi.fn(async () => undefined);
    const api = {
      getConfiguration: vi.fn(async () => ({ networkId: 'preview' })),
      balanceUnsealedTransaction: vi.fn(async () => ({ tx: '0102' })),
      submitTransaction,
    };
    const boundary = createWalletBoundary(
      api as never,
      shieldedAddress,
      bridge,
      () => ++activeChecks < 3,
      'preview',
    );

    await expect(boundary.midnightProvider.submitTx(transaction([1, 2]))).rejects.toThrow('selected network changed');
    expect(submitTransaction).not.toHaveBeenCalled();
  });

  it('returns the original transaction id when disposal happens after submission starts', async () => {
    let active = true;
    const api = {
      getConfiguration: vi.fn(async () => ({ networkId: 'preview' })),
      balanceUnsealedTransaction: vi.fn(async () => ({ tx: '0708' })),
      submitTransaction: vi.fn(async () => {
        active = false;
      }),
    };
    const boundary = createWalletBoundary(api as never, shieldedAddress, bridge, () => active, 'preview');

    const id = await boundary.midnightProvider.submitTx(transaction([7, 8], 'original-network-tx'));
    expect(id).toBe('original-network-tx');
    expect(api.submitTransaction).toHaveBeenCalledWith('0708');
  });

  it('keeps transaction and original-network identity when submission is uncertain', async () => {
    let active = true;
    const api = {
      getConfiguration: vi.fn(async () => ({ networkId: 'stagenet' })),
      balanceUnsealedTransaction: vi.fn(async () => ({ tx: '090a' })),
      submitTransaction: vi.fn(async () => {
        active = false;
        throw new Error('connector response lost');
      }),
    };
    const boundary = createWalletBoundary(api as never, shieldedAddress, bridge, () => active, 'stagenet');

    const error = await boundary.midnightProvider.submitTx(transaction([9, 10], 'stagenet-tx')).catch((caught) => caught);
    expect(error).toMatchObject({ transactionId: 'stagenet-tx', networkId: 'stagenet' });
    expect(error.message).toContain('stagenet-tx submission on stagenet could not be confirmed');
  });

  it('stores the exact forward result the contract returned instead of a fabricated coin', async () => {
    const storage = new MemoryStorage();
    const wrapperColor = 'ab'.repeat(32);
    let mintedCoin: ShieldedCoinInfo | undefined;
    let stagedBeforeWalletCall = false;
    const call = vi.fn(async (circuitId: string, args: unknown[]) => {
      if (circuitId === 'convertToShielded') {
        stagedBeforeWalletCall = [...storage.values.values()].some((raw) => raw.includes('"status":"pending"'));
        mintedCoin = {
          nonce: (args[2] as Uint8Array).slice(),
          color: Uint8Array.from({ length: 32 }, () => 0xab),
          value: 7n,
        };
      }
      return { private: { result: circuitId === 'convertToShielded' ? mintedCoin : undefined } };
    });
    const profile: ProfileBridge = {
      protocolFamily: 'midnight-2.x',
      setNetworkId: vi.fn(),
      deserializeFinalizedTransaction: bridge.deserializeFinalizedTransaction,
      addressToBytes: () => new Uint8Array(32),
      nativeNightKeys: () => ['night'],
      deriveWrapperColor: () => wrapperColor,
      buildProviders: async () => ({
        providers: { publicDataProvider: { queryContractState: async () => undefined } },
        call,
        readMetadata: async () => ({ name: 'Shielded Night', symbol: 'sNight' }),
      }),
    };
    const api = {
      getConfiguration: vi.fn(async () => ({ networkId: 'stagenet' })),
      getShieldedAddresses: vi.fn(async () => ({
        shieldedAddress: 'shielded',
        shieldedCoinPublicKey: 'coin-key',
        shieldedEncryptionPublicKey: 'encryption-key',
      })),
      getUnshieldedAddress: vi.fn(async () => ({ unshieldedAddress: 'unshielded' })),
      getShieldedBalances: vi.fn(async () => ({ [wrapperColor]: 7n })),
      getUnshieldedBalances: vi.fn(async () => ({ night: 10n })),
    };
    const session = await createProtocolSession({
      bridge: profile,
      connectedAPI: api as never,
      networkId: 'stagenet',
      contractAddress: 'cd'.repeat(32),
      coinStorage: storage,
    });

    await session.convert('toShielded', 7n);
    expect(stagedBeforeWalletCall).toBe(true);
    expect(session.trackedWrapperCoins()).toEqual([mintedCoin!]);
  });

  it('migrates valid legacy v1 coin records into the scoped store', () => {
    const storage = new MemoryStorage();
    const address = 'ef'.repeat(32);
    storage.setItem(`cv:coins:${address}`, JSON.stringify([{
      nonceHex: '01'.repeat(32),
      colorHex: '02'.repeat(32),
      value: '5',
    }]));
    const store = createWrapperCoinStore({
      protocolFamily: 'midnight-1.x',
      networkId: 'preview',
      contractAddress: address,
      storage,
    });

    expect(store.key).toBe(`shielded-night:coins:midnight-1.x:preview:${address}`);
    expect(store.available()).toEqual([{
      nonce: Uint8Array.from({ length: 32 }, () => 1),
      color: Uint8Array.from({ length: 32 }, () => 2),
      value: 5n,
    }]);
  });

  it('keeps pending and uncertain coins non-spendable through recovery transitions', () => {
    const storage = new MemoryStorage();
    const coin = {
      nonce: Uint8Array.from({ length: 32 }, () => 3),
      color: Uint8Array.from({ length: 32 }, () => 4),
      value: 9n,
    };
    const store = createWrapperCoinStore({
      protocolFamily: 'midnight-2.x',
      networkId: 'stagenet',
      contractAddress: 'ac'.repeat(32),
      storage,
    });

    store.stage(coin);
    expect(store.available()).toEqual([]);
    expect(storage.getItem(store.key)).toContain('"status":"pending"');
    store.markUncertain(coin, 'tx-unknown', 'stagenet');
    expect(store.available()).toEqual([]);
    expect(store.blocked()).toEqual([{
      status: 'uncertain',
      value: 9n,
      transactionId: 'tx-unknown',
      networkId: 'stagenet',
    }]);
    expect(storage.getItem(store.key)).toContain('"transactionId":"tx-unknown"');

    store.stage(coin);
    store.remove(coin);
    expect(store.available()).toEqual([]);
    store.stage(coin);
    store.add(coin);
    expect(store.available()).toEqual([coin]);
  });

  it('finds nested submission identity and quarantines an uncertain forward coin', async () => {
    const storage = new MemoryStorage();
    const identity = Object.assign(new Error('connector response lost'), {
      transactionId: 'nested-forward-tx',
      networkId: 'stagenet',
    });
    const wrapped = new Error('Midnight.js call failed', { cause: identity });
    const { session } = await makeProtocolSession(storage, async () => { throw wrapped; });

    await expect(session.convert('toShielded', 7n)).rejects.toBe(wrapped);
    expect(session.trackedWrapperCoins()).toEqual([]);
    expect([...storage.values.values()].join('\n')).toContain('"transactionId":"nested-forward-tx"');
    expect([...storage.values.values()].join('\n')).toContain('"status":"uncertain"');
  });

  it('retains identity when finalization watching fails after wallet submission', async () => {
    const storage = new MemoryStorage();
    const watchFailure = new Error('indexer watch timed out');
    const { session } = await makeProtocolSession(storage, async (_circuitId, _args, onSubmitted) => {
      onSubmitted('submitted-before-watch');
      throw watchFailure;
    });

    const error = await session.convert('toShielded', 7n).catch((caught) => caught);
    expect(error).toMatchObject({ transactionId: 'submitted-before-watch', networkId: 'stagenet' });
    expect(error.cause).toBe(watchFailure);
    expect(session.trackedWrapperCoins()).toEqual([]);
    expect([...storage.values.values()].join('\n')).toContain('"transactionId":"submitted-before-watch"');
  });

  it('removes a staged forward candidate after a known wallet cancellation', async () => {
    const storage = new MemoryStorage();
    const cancellation = Object.assign(new Error('user rejected'), { code: '4001' });
    const { session } = await makeProtocolSession(storage, async () => { throw cancellation; });

    await expect(session.convert('toShielded', 7n)).rejects.toBe(cancellation);
    expect(session.trackedWrapperCoins()).toEqual([]);
    expect([...storage.values.values()].join('\n')).not.toContain('"status":"pending"');
    expect([...storage.values.values()].join('\n')).not.toContain('"status":"uncertain"');
  });

  // Reverse conversion claims a contract-owned output that the wallet funds by
  // ordinary coin selection over its sNight balance, so the browser's coin store
  // is irrelevant to it. Proven on chain in
  // test/integration/shielded-night.reverse-any-amount.test.ts.
  it('reverses any amount the wallet holds with a fresh nonce and never reads the coin store', async () => {
    const storage = new MemoryStorage();
    const call = vi.fn(async (_circuitId: string, _args: unknown[]) => ({ private: { result: undefined } }));
    const { session, wrapperColor } = await makeProtocolSession(storage, call);
    expect(session.trackedWrapperCoins()).toEqual([]); // nothing this browser minted

    await session.convert('toUnshielded', 5n); // wallet total is 7n
    await session.convert('toUnshielded', 5n);

    expect(call.mock.calls.map(([circuitId]) => circuitId)).toEqual(['convertToUnshielded', 'convertToUnshielded']);
    const coins = call.mock.calls.map(([, args]) => args[0] as ShieldedCoinInfo);
    for (const coin of coins) {
      expect(coin.nonce).toBeInstanceOf(Uint8Array);
      expect(coin.nonce.length).toBe(32);
      expect(bytesToHex(coin.color)).toBe(wrapperColor);
      expect(coin.value).toBe(5n);
    }
    // A fresh nonce per call: reusing one would reproduce a coin commitment.
    expect(bytesToHex(coins[0].nonce)).not.toBe(bytesToHex(coins[1].nonce));
    expect(call.mock.calls[0][1][1]).toEqual({
      is_left: false,
      left: { bytes: new Uint8Array(32) },
      right: { bytes: new Uint8Array(32) },
    });
    // The store is untouched by the reverse path.
    expect(session.wrapperCoinState()).toEqual({ available: [], blocked: [] });
    expect([...storage.values.values()].join('\n')).not.toContain('"status":"pending"');
  });

  it('reports the wallet total and calls no circuit when the amount exceeds the balance', async () => {
    const storage = new MemoryStorage();
    const call = vi.fn(async (_circuitId: string, _args: unknown[]) => ({ private: { result: undefined } }));
    const { session } = await makeProtocolSession(storage, call);

    await expect(session.convert('toUnshielded', 8n)).rejects.toThrow(
      'The wallet holds 7 sNight; enter an amount up to that total.',
    );
    expect(call).not.toHaveBeenCalled();
  });

  it('surfaces the transaction id and warns against a blind retry when a reverse is uncertain', async () => {
    const storage = new MemoryStorage();
    const identity = Object.assign(new Error('connector response lost'), {
      transactionId: 'nested-reverse-tx',
      networkId: 'stagenet',
    });
    const wrapped = new Error('Midnight.js call failed', { cause: identity });
    const { session } = await makeProtocolSession(storage, async () => { throw wrapped; });

    const error = await session.convert('toUnshielded', 7n).catch((caught) => caught);
    expect(error).toMatchObject({ transactionId: 'nested-reverse-tx', networkId: 'stagenet' });
    expect(error.message).toContain('nested-reverse-tx');
    expect(error.message).toContain('a blind retry converts more sNight');
    expect(error.cause).toBe(wrapped);
    expect(session.wrapperCoinState()).toEqual({ available: [], blocked: [] });
  });

  it('leaves this browser’s minted coins untouched when the wallet cancels a reverse', async () => {
    const storage = new MemoryStorage();
    const coin = {
      nonce: Uint8Array.from({ length: 32 }, () => 7),
      color: Uint8Array.from({ length: 32 }, () => 0xab),
      value: 7n,
    };
    createWrapperCoinStore({
      protocolFamily: 'midnight-2.x',
      networkId: 'stagenet',
      contractAddress: 'cd'.repeat(32),
      storage,
    }).add(coin);
    const cancellation = Object.assign(new Error('user rejected'), { code: '4001' });
    const { session } = await makeProtocolSession(storage, async () => { throw cancellation; });

    await expect(session.convert('toUnshielded', 7n)).rejects.toBe(cancellation);
    expect(session.trackedWrapperCoins()).toEqual([coin]);
    expect(session.wrapperCoinState().blocked).toEqual([]);
  });

  it('stages and retains the exact legacy withdrawal coin before completing resume', async () => {
    const storage = new MemoryStorage();
    const address = 'cd'.repeat(32);
    const pending: PendingSwap = {
      id: 'legacy-shielded',
      direction: 'toShielded',
      secretHex: '01'.repeat(32),
      amount: '5',
      step: 'deposited',
      createdAt: 1,
    };
    storage.setItem(`cv:pending:${address}`, JSON.stringify([pending]));
    let stagedBeforeWalletCall = false;
    let returnedCoin: ShieldedCoinInfo | undefined;
    const { session } = await makeProtocolSession(storage, async (circuitId, args) => {
      expect(circuitId).toBe('withdrawShielded');
      stagedBeforeWalletCall = [...storage.values.values()].some((raw) => raw.includes('"status":"pending"'));
      returnedCoin = {
        nonce: (args[3] as Uint8Array).slice(),
        color: Uint8Array.from({ length: 32 }, () => 0xab),
        value: 5n,
      };
      return { private: { result: returnedCoin } };
    });
    const globalValue = globalThis as unknown as { localStorage?: CoinStorage };
    globalValue.localStorage = storage;
    try {
      await resumeSwap(session, address, pending);
      expect(stagedBeforeWalletCall).toBe(true);
      expect(session.trackedWrapperCoins()).toEqual([returnedCoin!]);
      expect(loadPending(address)).toEqual([]);
    } finally {
      delete globalValue.localStorage;
    }
  });

  it('quarantines a legacy withdrawal coin when finalization fails after submission', async () => {
    const storage = new MemoryStorage();
    const address = 'cd'.repeat(32);
    const pending: PendingSwap = {
      id: 'legacy-uncertain',
      direction: 'toShielded',
      secretHex: '02'.repeat(32),
      amount: '5',
      step: 'deposited',
      createdAt: 1,
    };
    storage.setItem(`cv:pending:${address}`, JSON.stringify([pending]));
    const watchFailure = new Error('indexer watch timed out');
    const { session } = await makeProtocolSession(storage, async (_circuitId, _args, onSubmitted) => {
      onSubmitted('legacy-submitted-tx');
      throw watchFailure;
    });
    const globalValue = globalThis as unknown as { localStorage?: CoinStorage };
    globalValue.localStorage = storage;
    try {
      const error = await resumeSwap(session, address, pending).catch((caught) => caught);
      expect(error).toMatchObject({ transactionId: 'legacy-submitted-tx', networkId: 'stagenet' });
      expect(session.wrapperCoinState().blocked).toEqual([{
        status: 'uncertain',
        value: 5n,
        transactionId: 'legacy-submitted-tx',
        networkId: 'stagenet',
      }]);
      expect(loadPending(address)).toEqual([pending]);
    } finally {
      delete globalValue.localStorage;
    }
  });

  it.each([
    Object.assign(new Error('submission uncertain'), { transactionId: 'tx-1', networkId: 'preview' }),
    Object.assign(new Error('user rejected'), { code: '4001' }),
  ])('does not retry or remove a legacy pending swap after terminal failure', async (failure) => {
    const storage = new MemoryStorage();
    const address = 'fa'.repeat(32);
    const pending: PendingSwap = {
      id: 'pending-1',
      direction: 'toUnshielded',
      secretHex: '01'.repeat(32),
      amount: '3',
      step: 'deposited',
      createdAt: 1,
    };
    storage.setItem(`cv:pending:${address}`, JSON.stringify([pending]));
    const globalValue = globalThis as unknown as { localStorage?: CoinStorage };
    globalValue.localStorage = storage;
    const callCircuit = vi.fn(async () => { throw failure; });
    const session = {
      contractAddress: address,
      unshieldedAddress: 'unshielded',
      callCircuit,
      addressToBytes: () => new Uint8Array(32),
    } as unknown as ProtocolSession;
    try {
      await expect(resumeSwap(session, address, pending)).rejects.toBe(failure);
      expect(callCircuit).toHaveBeenCalledTimes(1);
      expect(loadPending(address)).toEqual([pending]);
    } finally {
      delete globalValue.localStorage;
    }
  });
});
