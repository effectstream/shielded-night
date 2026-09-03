import {
  type CircuitContext,
  type CircuitId,
  type CircuitResults,
  createCircuitContext,
  createConstructorContext,
  sampleContractAddress,
} from '@midnight-ntwrk/compact-runtime';
import {
  Contract,
  type Ledger,
  ledger,
} from '../../../src/managed/contract/index.js';

/** ShieldedNight has no witnesses; its private state is empty. */
export type ShieldedNightPrivateState = Record<string, never>;

/** Zswap coin public key of the simulated caller (value is irrelevant to the contract). */
const COIN_PK = '0'.repeat(64);

export interface ShieldedCoin {
  nonce: Uint8Array;
  color: Uint8Array;
  value: bigint;
}

export type EitherContractOrUser = {
  is_left: boolean;
  left: { bytes: Uint8Array };
  right: { bytes: Uint8Array };
};

/** Builds the `Either<ContractAddress, UserAddress>` param for withdrawUnshielded. */
export const rightUserAddress = (bytes: Uint8Array): EitherContractOrUser => ({
  is_left: false,
  left: { bytes: new Uint8Array(32) },
  right: { bytes },
});

/**
 * In-memory simulator for the ShieldedNight contract, following the
 * OpenZeppelin compact-contracts simulator pattern: the compiled contract's
 * impure circuits run against a locally held CircuitContext, and each
 * successful call threads the updated context back so ledger state advances
 * across calls. Failed calls reject before the context is replaced, so state
 * is untouched — matching on-chain semantics.
 *
 * @dev ASYNC ON THE LEDGER-V9 LINE. compact-runtime 0.19 makes every generated
 * circuit — and `Contract.initialState` — return a Promise (it has to: a circuit
 * may perform a cross-contract call, which fetches state). Construction therefore
 * moves to the static `create()` factory and every circuit accessor is async.
 * `getLedger()` stays synchronous: it only reads the context this simulator holds.
 *
 * @dev The runtime-0.19 `CircuitContext` also collapsed `currentQueryContext`,
 * `currentPrivateState`, `currentZswapLocalState` and `gasCost` under a single
 * `callContext`, and `createCircuitContext` gained the executing circuit's id as
 * its first argument — so each call builds its context with its own id.
 */
export class ShieldedNightSimulator {
  readonly contract: Contract<ShieldedNightPrivateState>;
  readonly contractAddress: string;
  private ctx: CircuitContext<ShieldedNightPrivateState>;

  private constructor(
    contract: Contract<ShieldedNightPrivateState>,
    contractAddress: string,
    ctx: CircuitContext<ShieldedNightPrivateState>,
  ) {
    this.contract = contract;
    this.contractAddress = contractAddress;
    this.ctx = ctx;
  }

  static async create(
    name: string,
    symbol: string,
    decimals: bigint,
  ): Promise<ShieldedNightSimulator> {
    const contract = new Contract<ShieldedNightPrivateState>({});
    const init = await contract.initialState(
      createConstructorContext<ShieldedNightPrivateState>({}, COIN_PK),
      name,
      symbol,
      decimals,
    );
    const contractAddress = sampleContractAddress();
    const ctx = createCircuitContext<ShieldedNightPrivateState>(
      'constructor',
      contractAddress,
      COIN_PK,
      init.currentContractState,
      {},
    );
    return new ShieldedNightSimulator(contract, contractAddress, ctx);
  }

  /** Read the public ledger state (balances map + sealed metadata). */
  getLedger(): Ledger {
    return ledger(this.ctx.callContext.currentQueryContext.state);
  }

  /**
   * A fresh context for `circuitId` carrying the current ledger and private
   * state. Each simulator call models its own transaction: keep the updated
   * ledger state but discard the accumulated Zswap local state (coin
   * receives/sends recorded by the previous call). Without this, successive
   * deposits share one transaction-level receive accumulator and large amounts
   * trip its Uint<64> overflow instead of exercising the contract's own logic.
   */
  private contextFor(circuitId: CircuitId): CircuitContext<ShieldedNightPrivateState> {
    return createCircuitContext<ShieldedNightPrivateState>(
      circuitId,
      this.contractAddress,
      COIN_PK,
      this.ctx.callContext.currentQueryContext.state,
      this.ctx.callContext.currentPrivateState ?? ({} as ShieldedNightPrivateState),
    );
  }

  private async run<R>(
    circuitId: CircuitId,
    call: (ctx: CircuitContext<ShieldedNightPrivateState>) => Promise<CircuitResults<ShieldedNightPrivateState, R>>,
  ): Promise<R> {
    const res = await call(this.contextFor(circuitId));
    this.ctx = res.context;
    return res.result;
  }

  name(): Promise<string> {
    return this.run('name', (c) => this.contract.impureCircuits.name(c));
  }

  symbol(): Promise<string> {
    return this.run('symbol', (c) => this.contract.impureCircuits.symbol(c));
  }

  decimals(): Promise<bigint> {
    return this.run('decimals', (c) => this.contract.impureCircuits.decimals(c));
  }

  tokenColor(): Promise<Uint8Array> {
    return this.run('tokenColor', (c) => this.contract.impureCircuits.tokenColor(c));
  }

  getBalance(secret: Uint8Array): Promise<bigint> {
    return this.run('getBalance', (c) => this.contract.impureCircuits.getBalance(c, secret));
  }

  async depositUnshielded(secret: Uint8Array, amount: bigint): Promise<void> {
    await this.run('depositUnshielded', (c) =>
      this.contract.impureCircuits.depositUnshielded(c, secret, amount),
    );
  }

  async depositShielded(secret: Uint8Array, coin: ShieldedCoin): Promise<void> {
    await this.run('depositShielded', (c) =>
      this.contract.impureCircuits.depositShielded(c, secret, coin),
    );
  }

  async withdrawUnshielded(
    secret: Uint8Array,
    amount: bigint,
    recipient: EitherContractOrUser,
  ): Promise<void> {
    await this.run('withdrawUnshielded', (c) =>
      this.contract.impureCircuits.withdrawUnshielded(c, secret, amount, recipient),
    );
  }

  withdrawShielded(
    secret: Uint8Array,
    amount: bigint,
    recipient: { bytes: Uint8Array },
    nonce: Uint8Array,
  ): Promise<ShieldedCoin> {
    return this.run('withdrawShielded', (c) =>
      this.contract.impureCircuits.withdrawShielded(c, secret, amount, recipient, nonce),
    );
  }

  /** Atomic NIGHT -> sNight (no secret): lock NIGHT and mint the wrapper. */
  convertToShielded(
    amount: bigint,
    recipient: { bytes: Uint8Array },
    nonce: Uint8Array,
  ): Promise<ShieldedCoin> {
    return this.run('convertToShielded', (c) =>
      this.contract.impureCircuits.convertToShielded(c, amount, recipient, nonce),
    );
  }

  /** Atomic sNight -> NIGHT (no secret): burn the wrapper coin and release NIGHT. */
  async convertToUnshielded(coin: ShieldedCoin, recipient: EitherContractOrUser): Promise<void> {
    await this.run('convertToUnshielded', (c) =>
      this.contract.impureCircuits.convertToUnshielded(c, coin, recipient),
    );
  }
}
