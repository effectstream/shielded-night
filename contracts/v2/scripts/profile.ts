import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ledger } from '../managed/contract/index.js';

export const COMPATIBILITY = {
  compiler: '0.34.0',
  language: '0.26.0',
  compactJs: '2.5.5-rc.8',
  compactRuntime: '0.19.0',
  midnightJs: '5.0.0-beta.7',
  ledger: '1.0.0-rc.3',
  onchainRuntime: '4.0.0-rc.3',
  walletSdk: '2.0.0-beta.2',
} as const;

export const REPOSITORY_ROOT = path.resolve(new URL(import.meta.url).pathname, '..', '..', '..', '..');
export const MANAGED_DIRECTORY = path.resolve(REPOSITORY_ROOT, 'contracts', 'v2', 'managed');

const envUrl = (name: string, fallback: string): string => {
  const value = process.env[name]?.trim();
  return value || fallback;
};

export const stagenet = () => ({
  walletNetworkId: 'stagenet' as const,
  networkId: 'stagenet',
  indexer: envUrl('MN_INDEXER_URL', 'https://indexer.stagenet.shielded.tools/api/v4/graphql'),
  indexerWS: envUrl('MN_INDEXER_WS_URL', 'wss://indexer.stagenet.shielded.tools/api/v4/graphql/ws'),
  node: envUrl('MN_NODE_URL', 'https://rpc.stagenet.shielded.tools'),
  nodeWS: envUrl('MN_NODE_WS_URL', 'wss://rpc.stagenet.shielded.tools'),
  proofServer: envUrl('MN_PROOF_SERVER_URL', 'http://127.0.0.1:6300'),
  faucet: undefined,
});

const bytesEqual = (left: Uint8Array, right: Uint8Array): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

function filesBelow(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const file = path.join(directory, name);
    return statSync(file).isDirectory() ? filesBelow(file) : [file];
  });
}

export function artifactSha256(): string {
  const hash = createHash('sha256');
  for (const file of filesBelow(MANAGED_DIRECTORY).sort()) {
    hash.update(path.relative(MANAGED_DIRECTORY, file));
    hash.update('\0');
    hash.update(readFileSync(file));
    hash.update('\0');
  }
  return hash.digest('hex');
}

export function sourceCommit(): string {
  const configured = process.env.SHIELDED_NIGHT_COMMIT?.trim();
  const commit = configured || execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  if (!/^[0-9a-f]{40}$/i.test(commit)) {
    throw new Error('SHIELDED_NIGHT_COMMIT/source revision must be a full 40-character hexadecimal Git SHA.');
  }
  return commit.toLowerCase();
}

export interface Verification {
  readonly address: string;
  readonly verifierKeys: Record<string, string>;
  readonly metadata: { name: string; symbol: string; decimals: number };
  readonly authority: { locked: boolean; committeeSize: number; threshold: string; counter: string };
}

export async function verifyAddress(
  publicDataProvider: { queryContractState(address: string): Promise<any> },
  address: string,
): Promise<Verification> {
  const normalizedAddress = address.trim().replace(/^0x/i, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalizedAddress)) throw new Error('Contract address must be exactly 32 bytes of hex.');
  const state = await publicDataProvider.queryContractState(normalizedAddress);
  if (!state) throw new Error(`No contract state found at ${normalizedAddress}.`);

  const localOperations = readdirSync(path.join(MANAGED_DIRECTORY, 'keys'))
    .filter((file) => file.endsWith('.verifier'))
    .map((file) => file.slice(0, -'.verifier'.length))
    .sort();
  const chainOperations = state.operations()
    .map((operation: string | Uint8Array) => typeof operation === 'string' ? operation : Buffer.from(operation).toString())
    .sort();
  if (localOperations.join('\0') !== chainOperations.join('\0')) {
    throw new Error('On-chain circuit set differs from the compiler 0.34.0 artifact set.');
  }

  const verifierKeys: Record<string, string> = {};
  for (const operation of localOperations) {
    const local = new Uint8Array(readFileSync(path.join(MANAGED_DIRECTORY, 'keys', `${operation}.verifier`)));
    const chain = state.operation(operation)?.verifierKey as Uint8Array | undefined;
    if (!chain || !bytesEqual(local, chain)) throw new Error(`Verifier key mismatch for ${operation}.`);
    verifierKeys[operation] = createHash('sha256').update(local).digest('hex');
  }

  const data = ledger(state.data);
  if (data._name !== 'Shielded Night' || data._symbol !== 'sNight' || data._decimals !== 6n) {
    throw new Error('On-chain Shielded NIGHT metadata does not match the release metadata.');
  }
  const authority = state.maintenanceAuthority;
  const committeeSize = authority.committee.length;
  const threshold = BigInt(authority.threshold);
  return {
    address: normalizedAddress,
    verifierKeys,
    metadata: { name: data._name, symbol: data._symbol, decimals: Number(data._decimals) },
    authority: {
      locked: committeeSize === 0 && threshold > 0n,
      committeeSize,
      threshold: threshold.toString(),
      counter: BigInt(authority.counter).toString(),
    },
  };
}

export function recordPath(address: string): string {
  const configured = process.env.DEPLOY_OUT?.trim();
  return configured
    ? path.resolve(configured)
    : path.resolve(REPOSITORY_ROOT, '.local', 'deployments', `v2-stagenet-${address}.json`);
}

export function readRecord(address: string): Record<string, unknown> | undefined {
  const destination = recordPath(address);
  if (!existsSync(destination)) return undefined;
  const value: unknown = JSON.parse(readFileSync(destination, 'utf8'));
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function writeRecord(record: Record<string, unknown>, address: string): string {
  const destination = recordPath(address);
  mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp.${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, destination);
  return destination;
}
