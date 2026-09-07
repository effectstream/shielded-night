import { beforeEach, describe, expect, it } from 'vitest';
import {
  createCircuitContext,
  createConstructorContext,
  sampleContractAddress,
  type ChargedState,
  type CircuitResults,
  type Effects,
  type StateValue,
} from '@midnight-ntwrk/compact-runtime';
import { Contract, ledger, type Ledger } from '../managed/contract/index.js';

type PrivateState = Record<string, never>;
type ShieldedCoin = { nonce: Uint8Array; color: Uint8Array; value: bigint };
type Recipient = {
  is_left: boolean;
  left: { bytes: Uint8Array };
  right: { bytes: Uint8Array };
};

const COIN_PUBLIC_KEY = '0'.repeat(64);
const AMOUNT = 10_000_000n;

function bytes32(label: string): Uint8Array {
  const value = new Uint8Array(32);
  value.set(new TextEncoder().encode(label).subarray(0, 32));
  return value;
}

function userRecipient(bytes = bytes32('user-address')): Recipient {
  return {
    is_left: false,
    left: { bytes: new Uint8Array(32) },
    right: { bytes },
  };
}

class V2Simulator {
  private readonly contract = new Contract<PrivateState>({});
  private readonly address = sampleContractAddress();
  private state!: StateValue | ChargedState;
  private privateState: PrivateState = {};
  effects!: Effects;

  static async create(): Promise<V2Simulator> {
    const simulator = new V2Simulator();
    const initial = await simulator.contract.initialState(
      createConstructorContext<PrivateState>({}, COIN_PUBLIC_KEY),
      'Shielded Night',
      'sNight',
      6n,
    );
    simulator.state = initial.currentContractState.data;
    simulator.privateState = initial.currentPrivateState;
    return simulator;
  }

  getLedger(): Ledger {
    return ledger(this.state);
  }

  private async advance<R>(
    circuitId: string,
    invoke: (context: ReturnType<typeof createCircuitContext<PrivateState>>) => Promise<CircuitResults<PrivateState, R>>,
  ): Promise<R> {
    const context = createCircuitContext(
      circuitId,
      this.address,
      COIN_PUBLIC_KEY,
      this.state,
      this.privateState,
    );
    const result = await invoke(context);
    this.state = result.context.callContext.currentQueryContext.state;
    this.privateState = result.context.callContext.currentPrivateState ?? {};
    this.effects = result.context.callContext.currentQueryContext.effects;
    return result.result;
  }

  name() { return this.advance('name', (context) => this.contract.impureCircuits.name(context)); }
  symbol() { return this.advance('symbol', (context) => this.contract.impureCircuits.symbol(context)); }
  decimals() { return this.advance('decimals', (context) => this.contract.impureCircuits.decimals(context)); }
  tokenColor() { return this.advance('tokenColor', (context) => this.contract.impureCircuits.tokenColor(context)); }
  getBalance(secret: Uint8Array) {
    return this.advance('getBalance', (context) => this.contract.impureCircuits.getBalance(context, secret));
  }
  depositUnshielded(secret: Uint8Array, amount: bigint) {
    return this.advance('depositUnshielded', (context) => this.contract.impureCircuits.depositUnshielded(context, secret, amount));
  }
  withdrawShielded(secret: Uint8Array, amount: bigint, recipient: { bytes: Uint8Array }, nonce: Uint8Array) {
    return this.advance('withdrawShielded', (context) => this.contract.impureCircuits.withdrawShielded(context, secret, amount, recipient, nonce));
  }
  depositShielded(secret: Uint8Array, coin: ShieldedCoin) {
    return this.advance('depositShielded', (context) => this.contract.impureCircuits.depositShielded(context, secret, coin));
  }
  withdrawUnshielded(secret: Uint8Array, amount: bigint, recipient: Recipient) {
    return this.advance('withdrawUnshielded', (context) => this.contract.impureCircuits.withdrawUnshielded(context, secret, amount, recipient));
  }
  convertToShielded(amount: bigint, recipient: { bytes: Uint8Array }, nonce: Uint8Array) {
    return this.advance('convertToShielded', (context) => this.contract.impureCircuits.convertToShielded(context, amount, recipient, nonce));
  }
  convertToUnshielded(coin: ShieldedCoin, recipient: Recipient) {
    return this.advance('convertToUnshielded', (context) => this.contract.impureCircuits.convertToUnshielded(context, coin, recipient));
  }
}

describe('ShieldedNight compiler 0.34.0 / runtime 0.19.0', () => {
  let contract: V2Simulator;

  beforeEach(async () => {
    contract = await V2Simulator.create();
  });

  it('preserves metadata and derives one stable wrapper color', async () => {
    await expect(contract.name()).resolves.toBe('Shielded Night');
    await expect(contract.symbol()).resolves.toBe('sNight');
    await expect(contract.decimals()).resolves.toBe(6n);
    const first = await contract.tokenColor();
    const second = await contract.tokenColor();
    expect(first).toHaveLength(32);
    expect(first).toEqual(second);
  });

  it('round-trips both atomic conversion directions with 1:1 backing', async () => {
    const nonce = bytes32('atomic-round-trip');
    const color = await contract.tokenColor();
    const wrapper = await contract.convertToShielded(AMOUNT, { bytes: bytes32('recipient') }, nonce);
    expect(wrapper).toEqual({ nonce, color, value: AMOUNT });
    expect([...contract.effects.unshieldedInputs.values()]).toEqual([AMOUNT]);
    expect([...contract.effects.shieldedMints.values()]).toEqual([AMOUNT]);

    await contract.convertToUnshielded(wrapper, userRecipient());
    expect([...contract.effects.unshieldedOutputs.values()]).toEqual([AMOUNT]);
    expect(contract.effects.claimedShieldedReceives).toHaveLength(1);
    expect(contract.getLedger().balances.isEmpty()).toBe(true);
  });

  it('round-trips the credit bridge without creating unbacked value', async () => {
    const secret = bytes32('credit-round-trip');
    await contract.depositUnshielded(secret, AMOUNT);
    expect([...contract.effects.unshieldedInputs.values()]).toEqual([AMOUNT]);
    await expect(contract.getBalance(secret)).resolves.toBe(AMOUNT);

    const wrapper = await contract.withdrawShielded(secret, AMOUNT, { bytes: bytes32('recipient') }, bytes32('nonce'));
    expect([...contract.effects.shieldedMints.values()]).toEqual([AMOUNT]);
    await expect(contract.getBalance(secret)).resolves.toBe(0n);
    await contract.depositShielded(secret, wrapper);
    expect(contract.effects.claimedShieldedReceives).toHaveLength(1);
    await expect(contract.getBalance(secret)).resolves.toBe(AMOUNT);
    await contract.withdrawUnshielded(secret, AMOUNT, userRecipient());
    expect([...contract.effects.unshieldedOutputs.values()]).toEqual([AMOUNT]);
    await expect(contract.getBalance(secret)).resolves.toBe(0n);
  });

  it('keeps the zero-value and wrong-token guards', async () => {
    await expect(contract.convertToShielded(0n, { bytes: bytes32('recipient') }, bytes32('nonce')))
      .rejects.toThrow('amount must be positive');
    await expect(contract.convertToShielded(AMOUNT, { bytes: new Uint8Array(32) }, bytes32('nonce')))
      .rejects.toThrow('invalid recipient');

    const wrapper = await contract.convertToShielded(AMOUNT, { bytes: bytes32('recipient') }, bytes32('nonce'));
    const foreign = { ...wrapper, color: wrapper.color.slice() };
    foreign.color[0] ^= 0xff;
    await expect(contract.convertToUnshielded(foreign, userRecipient()))
      .rejects.toThrow("not this contract's shielded wrapper");

    const secret = bytes32('overwithdraw');
    await contract.depositUnshielded(secret, 1n);
    await expect(contract.withdrawUnshielded(secret, 2n, userRecipient()))
      .rejects.toThrow('insufficient pool balance');
  });
});
