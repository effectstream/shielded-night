import type {
  Direction,
  ProtocolSession,
  SwapCallbacks,
  SwapStep,
} from '../../protocols/shared/types.js';

export type { Direction, SwapStep } from '../../protocols/shared/types.js';

export interface StoredCoin {
  nonceHex: string;
  colorHex: string;
  value: string;
}

export interface PendingSwap {
  id: string;
  direction: Direction;
  secretHex: string;
  amount: string;
  step: SwapStep;
  createdAt: number;
  coin?: StoredCoin;
}

const PENDING_KEY = (address: string) => `cv:pending:${address}`;

function hexToBytes(value: string): Uint8Array {
  const hex = value.trim().replace(/^0x/i, '');
  if (!hex || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) {
    throw new Error('Stored swap contains malformed hexadecimal data.');
  }
  return Uint8Array.from(hex.match(/.{2}/g) ?? [], (part) => Number.parseInt(part, 16));
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) as T : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  localStorage.setItem(key, JSON.stringify(value));
}

export function loadPending(address: string): PendingSwap[] {
  return readJson<PendingSwap[]>(PENDING_KEY(address), []);
}

export function removePending(address: string, id: string): void {
  writeJson(PENDING_KEY(address), loadPending(address).filter((swap) => swap.id !== id));
}

/** Resume an old two-transaction swap through the selected profile adapter. */
export async function resumeSwap(
  session: ProtocolSession,
  contractAddress: string,
  swap: PendingSwap,
  callbacks: SwapCallbacks = {},
): Promise<void> {
  if (session.contractAddress !== contractAddress) {
    throw new Error('The pending swap belongs to another contract or network.');
  }
  if (swap.step !== 'deposited') throw new Error('Only a confirmed deposit can be resumed safely.');
  const secret = hexToBytes(swap.secretHex);
  const amount = BigInt(swap.amount);
  if (swap.direction === 'toShielded') {
    callbacks.onStep?.('deposited', 'Resuming: minting sNight…');
    await session.resumeShieldedWithdrawal(secret, amount);
  } else {
    callbacks.onStep?.('deposited', 'Resuming: releasing NIGHT…');
    await session.callCircuit('withdrawUnshielded', [
      secret,
      amount,
      {
        is_left: false,
        left: { bytes: new Uint8Array(32) },
        right: { bytes: session.addressToBytes(session.unshieldedAddress) },
      },
    ]);
  }
  removePending(contractAddress, swap.id);
  callbacks.onStep?.('done', 'Resume complete');
}
