import type { BlockedWrapperCoin, ProtocolFamily, ShieldedCoinInfo } from './types.js';

export interface CoinStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface StoredCoin {
  nonceHex: string;
  colorHex: string;
  value: string;
  status: 'pending' | 'available' | 'uncertain';
  transactionId?: string;
  networkId?: string;
}

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');

const hexToBytes = (hex: string): Uint8Array =>
  Uint8Array.from(hex.match(/.{2}/g) ?? [], (part) => Number.parseInt(part, 16));

function validStoredCoin(value: unknown): value is StoredCoin {
  if (!value || typeof value !== 'object') return false;
  const coin = value as Partial<StoredCoin>;
  return typeof coin.nonceHex === 'string'
    && /^[0-9a-f]{64}$/i.test(coin.nonceHex)
    && typeof coin.colorHex === 'string'
    && /^[0-9a-f]{64}$/i.test(coin.colorHex)
    && typeof coin.value === 'string'
    && /^[1-9][0-9]*$/.test(coin.value)
    && (coin.status === 'pending' || coin.status === 'available' || coin.status === 'uncertain');
}

function stored(coin: ShieldedCoinInfo, status: StoredCoin['status'] = 'available'): StoredCoin {
  if (coin.nonce.length !== 32 || coin.color.length !== 32 || coin.value <= 0n) {
    throw new Error('The contract returned malformed shielded coin data.');
  }
  return {
    nonceHex: bytesToHex(coin.nonce),
    colorHex: bytesToHex(coin.color),
    value: coin.value.toString(),
    status,
  };
}

const identity = (coin: Pick<StoredCoin, 'nonceHex' | 'colorHex' | 'value'>): string =>
  `${coin.nonceHex}:${coin.colorHex}:${coin.value}`;

function defaultStorage(): CoinStorage {
  try {
    if (typeof localStorage !== 'undefined') return localStorage;
  } catch {
    // Fall through to the actionable error below.
  }
  throw new Error('Browser storage is required to retain sNight coin details for reverse conversion.');
}

export function createWrapperCoinStore(input: {
  protocolFamily: ProtocolFamily;
  networkId: string;
  contractAddress: string;
  storage?: CoinStorage;
}) {
  const storage = input.storage ?? defaultStorage();
  const key = `shielded-night:coins:${input.protocolFamily}:${input.networkId}:${input.contractAddress}`;
  const legacyKey = `cv:coins:${input.contractAddress}`;

  const parse = (raw: string | null): StoredCoin[] => {
    if (!raw) return [];
    try {
      const value: unknown = JSON.parse(raw);
      if (!Array.isArray(value)) return [];
      return value.flatMap((entry) => {
        if (entry && typeof entry === 'object' && !('status' in entry)) {
          entry = { ...entry, status: 'available' };
        }
        return validStoredCoin(entry) ? [{ ...entry }] : [];
      });
    } catch {
      return [];
    }
  };
  const save = (coins: StoredCoin[]) => storage.setItem(key, JSON.stringify(coins));

  let initial = storage.getItem(key);
  if (initial == null && input.protocolFamily === 'midnight-1.x') {
    const migrated = parse(storage.getItem(legacyKey));
    if (migrated.length > 0) save(migrated);
    initial = storage.getItem(key);
  }
  // Fail during connection, before a transaction can mint a coin whose nonce
  // the connector cannot later recover.
  save(parse(initial));

  const all = () => parse(storage.getItem(key));
  return {
    key,
    available(): ShieldedCoinInfo[] {
      return all().filter((coin) => coin.status === 'available').map((coin) => ({
        nonce: hexToBytes(coin.nonceHex),
        color: hexToBytes(coin.colorHex),
        value: BigInt(coin.value),
      }));
    },
    blocked(): BlockedWrapperCoin[] {
      return all().filter((coin) => coin.status !== 'available').map((coin) => ({
        status: coin.status as 'pending' | 'uncertain',
        value: BigInt(coin.value),
        ...(coin.transactionId ? { transactionId: coin.transactionId } : {}),
        ...(coin.networkId ? { networkId: coin.networkId } : {}),
      }));
    },
    add(coin: ShieldedCoinInfo): void {
      const next = stored(coin);
      const coins = all().filter((candidate) => identity(candidate) !== identity(next));
      save([...coins, next]);
    },
    stage(coin: ShieldedCoinInfo): void {
      const next = stored(coin, 'pending');
      const coins = all().filter((candidate) => identity(candidate) !== identity(next));
      save([...coins, next]);
    },
    remove(coin: ShieldedCoinInfo): void {
      const selected = stored(coin);
      save(all().filter((candidate) => identity(candidate) !== identity(selected)));
    },
    markUncertain(coin: ShieldedCoinInfo, transactionId: string, networkId: string): void {
      const selected = stored(coin);
      save(all().map((candidate) => identity(candidate) === identity(selected)
        ? { ...candidate, status: 'uncertain', transactionId, networkId }
        : candidate));
    },
  };
}
