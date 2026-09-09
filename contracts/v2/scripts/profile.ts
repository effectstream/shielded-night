import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import {
  sampleSigningKey,
  signatureVerifyingKey,
  type SignatureVerifyingKey,
  type SigningKey,
} from '@midnightntwrk/onchain-runtime-v4';
import { unshieldedToken } from '@midnightntwrk/ledger-v9';
import pino from 'pino';
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

/**
 * The environments the v2 (compiler 0.34.0 / ledger-v9) scripts can target.
 * `stagenet` is the default and keeps every rule it had before `undeployed`
 * existed: a durable, absolute, operator-supplied maintenance key.
 * `undeployed` is a throwaway local devnet — same code path, relaxed custody.
 */
export const V2_ENV_NAMES = ['stagenet', 'undeployed'] as const;
export type V2EnvName = (typeof V2_ENV_NAMES)[number];

export const isV2EnvName = (value: string): value is V2EnvName =>
  (V2_ENV_NAMES as readonly string[]).includes(value);

/** `MN_ENV`, defaulting to `stagenet` so nothing changes for today's callers. */
export function requestedEnv(): V2EnvName {
  const requested = process.env.MN_ENV?.trim() || 'stagenet';
  if (!isV2EnvName(requested)) {
    throw new Error(`Invalid MN_ENV "${requested}". The v2 commands support ${V2_ENV_NAMES.join(' | ')}.`);
  }
  return requested;
}

/**
 * The wallet network id per env. These are exactly `NetworkId.NetworkId.StageNet`
 * and `NetworkId.NetworkId.Undeployed` from `@midnightntwrk/wallet-sdk`
 * 2.0.0-beta.2; the literals live here so the unit tier can import this module
 * without loading the WASM-bearing wallet barrel. `deploy.ts` pins the mapping
 * to the SDK's own constants at typecheck time.
 */
export const WALLET_NETWORK_IDS = {
  stagenet: 'stagenet',
  undeployed: 'undeployed',
} as const satisfies Record<V2EnvName, string>;

export const walletNetworkIdFor = (env: V2EnvName): (typeof WALLET_NETWORK_IDS)[V2EnvName] =>
  WALLET_NETWORK_IDS[env];

/**
 * Genesis-block-funded devnet seed — the SAME constant the 1.x lane uses
 * (`test/support/network.ts` GENESIS_MINT_SEED). Only ever valid on
 * `undeployed`: on a local devnet it is the funding faucet and is shared with
 * every other facade on that stack, so callers that matter pass `MN_SEED`.
 */
export const GENESIS_MINT_SEED = '0000000000000000000000000000000000000000000000000000000000000001';

/** Level DB store name for an env's private state (never shared between envs). */
export const privateStateStoreName = (env: V2EnvName, suffix = ''): string =>
  `shielded-night-v2-${env}${suffix}`;
export const DEFAULT_WALLET_SYNC_TIMEOUT_MS = 300_000;
const MIN_WALLET_SYNC_TIMEOUT_MS = 30_000;
const MAX_WALLET_SYNC_TIMEOUT_MS = 900_000;

export interface DeploymentWalletFundingState {
  readonly unshielded: { readonly balances: Readonly<Record<string, bigint>> };
  readonly dust: { balance(at: Date): bigint };
}

export function deploymentWalletSyncTimeoutMs(): number {
  const configured = process.env.MN_WALLET_SYNC_TIMEOUT_MS?.trim();
  if (!configured) return DEFAULT_WALLET_SYNC_TIMEOUT_MS;
  if (!/^\d+$/.test(configured)) {
    throw new Error('MN_WALLET_SYNC_TIMEOUT_MS must be an integer number of milliseconds.');
  }
  const timeout = Number(configured);
  if (!Number.isSafeInteger(timeout) || timeout < MIN_WALLET_SYNC_TIMEOUT_MS || timeout > MAX_WALLET_SYNC_TIMEOUT_MS) {
    throw new Error(
      `MN_WALLET_SYNC_TIMEOUT_MS must be between ${MIN_WALLET_SYNC_TIMEOUT_MS} and ${MAX_WALLET_SYNC_TIMEOUT_MS} milliseconds.`,
    );
  }
  return timeout;
}

export function assertDeploymentWalletFunded(state: DeploymentWalletFundingState): void {
  const night = state.unshielded.balances[unshieldedToken().raw] ?? 0n;
  if (night <= 0n) throw new Error('Deployment wallet has no available NIGHT after synchronization.');
  if (state.dust.balance(new Date()) <= 0n) {
    throw new Error('Deployment wallet has no available DUST after synchronization.');
  }
}

export async function withSyncedDeploymentWallet<TWallet, TResult>(
  provider: {
    readonly wallet: TWallet;
    start(waitForFundsInWallet?: boolean): Promise<void>;
    stop(): Promise<void>;
  },
  sync: (wallet: TWallet, throttleTime?: number, timeout?: number) => Promise<DeploymentWalletFundingState>,
  action: () => Promise<TResult>,
): Promise<TResult> {
  const timeout = deploymentWalletSyncTimeoutMs();
  try {
    await provider.start(false);
    const state = await sync(provider.wallet, 2_000, timeout);
    assertDeploymentWalletFunded(state);
    return await action();
  } finally {
    await provider.stop().catch(() => undefined);
  }
}

interface MaintenanceKeyRecord {
  readonly schemaVersion: 1;
  readonly recordKind: 'shielded-night-maintenance-signing-key';
  readonly network: V2EnvName;
  readonly signingKey: SigningKey;
  readonly verifyingKey: SignatureVerifyingKey;
  readonly createdAt: string;
  readonly createdFor: {
    readonly sourceCommit: string;
    readonly artifactSha256: string;
  };
}

export interface PreparedMaintenanceKey {
  readonly path: string;
  readonly signingKey: SigningKey;
  readonly verifyingKey: SignatureVerifyingKey;
  readonly created: boolean;
}

const isSignatureKind = (value: unknown): value is SigningKey['tag'] =>
  value === 'schnorr' || value === 'ecdsa';

function normalizeSigningKey(value: unknown): SigningKey {
  if (!value || typeof value !== 'object') throw new Error('Maintenance key file has no signing key.');
  const candidate = value as { tag?: unknown; value?: unknown };
  if (!isSignatureKind(candidate.tag) || typeof candidate.value !== 'string' || !/^[0-9a-f]{64}$/i.test(candidate.value)) {
    throw new Error('Maintenance key file contains an invalid signing key.');
  }
  return { tag: candidate.tag, value: candidate.value.toLowerCase() };
}

function normalizeVerifyingKey(value: unknown): SignatureVerifyingKey {
  if (!value || typeof value !== 'object') throw new Error('Maintenance key file has no verifying key.');
  const candidate = value as { tag?: unknown; value?: unknown };
  if (!isSignatureKind(candidate.tag) || typeof candidate.value !== 'string' || !/^[0-9a-f]{64}$/i.test(candidate.value)) {
    throw new Error('Maintenance key file contains an invalid verifying key.');
  }
  return { tag: candidate.tag, value: candidate.value.toLowerCase() };
}

const sameVerifyingKey = (left: SignatureVerifyingKey, right: SignatureVerifyingKey): boolean =>
  left.tag === right.tag && left.value.toLowerCase() === right.value.toLowerCase();

/** Default `undeployed` key location: the repo's gitignored private-state area. */
export const UNDEPLOYED_MAINTENANCE_KEY_PATH = path.resolve(
  REPOSITORY_ROOT,
  '.local',
  'private-state',
  'v2-undeployed',
  'maintenance-key.json',
);

/**
 * Where the maintenance signing key lives.
 *
 * `stagenet` is unchanged: an operator must name an absolute path on durable
 * storage, because losing that key locks the funded deployment out of every
 * future maintenance transaction.
 *
 * `undeployed` is a throwaway devnet, so the file is optional and defaults into
 * the repository's gitignored private-state directory; a relative
 * `MN_MAINTENANCE_KEY_FILE` is accepted there and resolved against the cwd.
 * Mode 0600 and the write/read-back check still apply on both — that is
 * secret hygiene, not durability.
 */
export function maintenanceKeyPath(env: V2EnvName = requestedEnv()): string {
  const configured = process.env.MN_MAINTENANCE_KEY_FILE?.trim();
  if (env === 'undeployed') {
    return configured ? path.resolve(configured) : UNDEPLOYED_MAINTENANCE_KEY_PATH;
  }
  if (!configured) {
    throw new Error('Set MN_MAINTENANCE_KEY_FILE to an explicit durable, private maintenance-key file path.');
  }
  if (!path.isAbsolute(configured)) {
    throw new Error('MN_MAINTENANCE_KEY_FILE must be an absolute path on durable storage.');
  }
  return configured;
}

function readMaintenanceKeyRecord(destination: string, expectedNetwork: V2EnvName): MaintenanceKeyRecord {
  let file: number | undefined;
  try {
    file = openSync(destination, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(file);
    if (!stat.isFile()) throw new Error(`Maintenance key path is not a regular file: ${destination}`);
    if ((stat.mode & 0o777) !== 0o600) {
      throw new Error(`Maintenance key file must have mode 0600: ${destination}`);
    }
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Maintenance key file must contain a JSON object.');
    }
    const record = parsed as Partial<MaintenanceKeyRecord>;
    if (
      record.schemaVersion !== 1 ||
      record.recordKind !== 'shielded-night-maintenance-signing-key' ||
      typeof record.network !== 'string' ||
      !isV2EnvName(record.network)
    ) {
      throw new Error('Maintenance key file has an unsupported schema or network.');
    }
    // A key belongs to exactly one network: reusing a stagenet key on a
    // throwaway devnet (or the reverse) would put the funded deployment's
    // maintenance identity on a chain nobody controls.
    if (record.network !== expectedNetwork) {
      throw new Error(
        `Maintenance key file was created for network "${record.network}" but MN_ENV is "${expectedNetwork}".`,
      );
    }
    if (typeof record.createdAt !== 'string' || !record.createdFor ||
      !/^[0-9a-f]{40}$/i.test(record.createdFor.sourceCommit ?? '') ||
      !/^[0-9a-f]{64}$/i.test(record.createdFor.artifactSha256 ?? '')) {
      throw new Error('Maintenance key file has invalid creation provenance.');
    }
    const signingKey = normalizeSigningKey(record.signingKey);
    const verifyingKey = normalizeVerifyingKey(record.verifyingKey);
    let derived: SignatureVerifyingKey;
    try {
      derived = signatureVerifyingKey(signingKey);
    } catch {
      throw new Error('Maintenance key file contains a signing key rejected by the pinned runtime.');
    }
    if (!sameVerifyingKey(derived, verifyingKey)) {
      throw new Error('Maintenance key file verifying key does not match its signing key.');
    }
    return {
      schemaVersion: 1,
      recordKind: 'shielded-night-maintenance-signing-key',
      network: record.network,
      signingKey,
      verifyingKey,
      createdAt: record.createdAt,
      createdFor: {
        sourceCommit: record.createdFor.sourceCommit.toLowerCase(),
        artifactSha256: record.createdFor.artifactSha256.toLowerCase(),
      },
    };
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('Maintenance key file contains malformed JSON.');
    throw error;
  } finally {
    if (file !== undefined) closeSync(file);
  }
}

export function prepareMaintenanceSigningKey(input: {
  sourceCommit: string;
  artifactSha256: string;
}, env: V2EnvName = requestedEnv()): PreparedMaintenanceKey {
  const destination = maintenanceKeyPath(env);
  if (existsSync(destination)) {
    const existing = readMaintenanceKeyRecord(destination, env);
    return { path: destination, signingKey: existing.signingKey, verifyingKey: existing.verifyingKey, created: false };
  }

  mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  const signingKey = sampleSigningKey('schnorr');
  const verifyingKey = signatureVerifyingKey(signingKey);
  const record: MaintenanceKeyRecord = {
    schemaVersion: 1,
    recordKind: 'shielded-night-maintenance-signing-key',
    network: env,
    signingKey,
    verifyingKey,
    createdAt: new Date().toISOString(),
    createdFor: {
      sourceCommit: input.sourceCommit,
      artifactSha256: input.artifactSha256,
    },
  };
  let file: number | undefined;
  try {
    file = openSync(
      destination,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    fchmodSync(file, 0o600);
    writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    fsyncSync(file);
  } finally {
    if (file !== undefined) closeSync(file);
  }

  let directory: number | undefined;
  try {
    directory = openSync(path.dirname(destination), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    fsyncSync(directory);
  } finally {
    if (directory !== undefined) closeSync(directory);
  }

  // The deployer never trusts its own write. Close and reopen the durable file,
  // enforce its permissions, and derive the public identity again before any
  // wallet is started or transaction can be submitted.
  const persisted = readMaintenanceKeyRecord(destination, env);
  if (!sameVerifyingKey(persisted.verifyingKey, verifyingKey) ||
    persisted.signingKey.tag !== signingKey.tag || persisted.signingKey.value !== signingKey.value) {
    throw new Error('Maintenance signing key did not survive durable write/read-back validation.');
  }
  return { path: destination, signingKey: persisted.signingKey, verifyingKey: persisted.verifyingKey, created: true };
}

/** Run wallet startup/submission only after key creation and read-back. */
export async function withDurableMaintenanceKey<T>(
  input: { sourceCommit: string; artifactSha256: string },
  action: (key: PreparedMaintenanceKey) => Promise<T>,
  env: V2EnvName = requestedEnv(),
): Promise<T> {
  const key = prepareMaintenanceSigningKey(input, env);
  return await action(key);
}

/**
 * testkit-js interpolates the wallet seed into an info message while building
 * a wallet. Keep every log level disabled; field redaction cannot protect an
 * already-formatted message.
 */
export function createWalletLogger(destination?: pino.DestinationStream): pino.Logger {
  return pino({ level: 'silent' }, destination);
}

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

/**
 * A local ledger-v9 devnet. The loopback defaults are the 1.x lane's
 * (`test/support/network.ts` UndeployedNetwork): indexer 8088, node 9944,
 * proof server 6300. Every endpoint is overridable because a caller inside the
 * stack's docker network must dial service hostnames instead.
 */
export const undeployed = () => ({
  walletNetworkId: 'undeployed' as const,
  networkId: 'undeployed',
  indexer: envUrl('MN_INDEXER_URL', 'http://127.0.0.1:8088/api/v4/graphql'),
  indexerWS: envUrl('MN_INDEXER_WS_URL', 'ws://127.0.0.1:8088/api/v4/graphql/ws'),
  node: envUrl('MN_NODE_URL', 'http://127.0.0.1:9944'),
  nodeWS: envUrl('MN_NODE_WS_URL', 'ws://127.0.0.1:9944'),
  proofServer: envUrl('MN_PROOF_SERVER_URL', 'http://127.0.0.1:6300'),
  faucet: undefined,
});

export type V2Profile = ReturnType<typeof stagenet> | ReturnType<typeof undeployed>;

/** Resolved per CALL, so endpoint overrides set after import still apply. */
export function profileFor(env: V2EnvName): V2Profile {
  return env === 'undeployed' ? undeployed() : stagenet();
}

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
  readonly authority: {
    locked: boolean;
    committeeSize: number;
    committee: SignatureVerifyingKey[];
    threshold: string;
    counter: string;
  };
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
  const committee = authority.committee.map((key: unknown) => normalizeVerifyingKey(key));
  const threshold = BigInt(authority.threshold);
  return {
    address: normalizedAddress,
    verifierKeys,
    metadata: { name: data._name, symbol: data._symbol, decimals: Number(data._decimals) },
    authority: {
      locked: committeeSize === 0 && threshold > 0n,
      committeeSize,
      committee,
      threshold: threshold.toString(),
      counter: BigInt(authority.counter).toString(),
    },
  };
}

export function assertMaintenanceAuthorityKey(
  verification: Verification,
  expected: SignatureVerifyingKey,
): void {
  const { committee, threshold } = verification.authority;
  if (committee.length !== 1 || threshold !== '1' || !sameVerifyingKey(committee[0], expected)) {
    throw new Error('On-chain maintenance authority does not match the durably persisted signing key.');
  }
}

export function recordPath(address: string, env: V2EnvName = requestedEnv()): string {
  const configured = process.env.DEPLOY_OUT?.trim();
  return configured
    ? path.resolve(configured)
    : path.resolve(REPOSITORY_ROOT, '.local', 'deployments', `v2-${env}-${address}.json`);
}

/** Prove the record directory is writable before a deployment can spend funds. */
export function preflightRecordOutput(env: V2EnvName = requestedEnv()): void {
  const destination = recordPath('preflight', env);
  if (existsSync(destination) && statSync(destination).isDirectory()) {
    throw new Error(`Deployment record output is a directory: ${destination}`);
  }
  mkdirSync(path.dirname(destination), { recursive: true });
  const probe = `${destination}.write-test.${process.pid}`;
  const renamedProbe = `${probe}.renamed`;
  try {
    writeFileSync(probe, '', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    renameSync(probe, renamedProbe);
  } finally {
    if (existsSync(probe)) unlinkSync(probe);
    if (existsSync(renamedProbe)) unlinkSync(renamedProbe);
  }
}

export interface ConfirmedDeploymentTransaction {
  readonly contractAddress: string;
  readonly txId: string;
}

/** Emit recovery identity before record/indexer work can fail. */
export function reportConfirmedDeployment(
  transaction: ConfirmedDeploymentTransaction,
  log: (message: string) => void = console.log,
  env: V2EnvName = requestedEnv(),
): string {
  const address = transaction.contractAddress;
  log(`[deploy] confirmed ${env} contract ${address}`);
  log(`[deploy] confirmed transaction ${transaction.txId}`);
  log(`${env.toUpperCase()}_ADDRESS=${address}`);
  return address;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function priorVerificationHistory(existing: Record<string, unknown>): Record<string, unknown>[] {
  if (Array.isArray(existing.verificationHistory)) {
    return existing.verificationHistory.filter(isRecord);
  }
  if (isRecord(existing.verification)) return [existing.verification];
  if (
    existing.recordKind === 'verification-only' &&
    typeof existing.sourceCommit === 'string' &&
    typeof existing.artifactSha256 === 'string' &&
    typeof existing.verifiedAt === 'string'
  ) {
    return [{
      sourceCommit: existing.sourceCommit,
      artifactSha256: existing.artifactSha256,
      compatibility: existing.compatibility,
      network: existing.network,
      verifiedAt: existing.verifiedAt,
    }];
  }
  return [];
}

export function mergeVerificationRecord(input: {
  existing?: Record<string, unknown>;
  network: Record<string, unknown>;
  verified: Verification;
  verificationSourceCommit: string;
  verificationArtifactSha256: string;
  verifiedAt: string;
}): Record<string, unknown> {
  const { existing = {}, network, verified, verificationSourceCommit, verificationArtifactSha256, verifiedAt } = input;
  const existingAddress = typeof existing.contractAddress === 'string'
    ? existing.contractAddress.replace(/^0x/i, '').toLowerCase()
    : undefined;
  if (existingAddress && existingAddress !== verified.address) {
    throw new Error(`Existing deployment record address ${existingAddress} does not match verified address ${verified.address}.`);
  }

  const verification = {
    sourceCommit: verificationSourceCommit,
    artifactSha256: verificationArtifactSha256,
    compatibility: COMPATIBILITY,
    network,
    verifiedAt,
  };
  const common = {
    schemaVersion: 2,
    contractAddress: verified.address,
    verificationStatus: 'verified',
    metadata: verified.metadata,
    verifierKeys: verified.verifierKeys,
    maintenanceAuthority: verified.authority,
    verifiedAt,
    verification,
    verificationHistory: [...priorVerificationHistory(existing), verification],
  };

  const hasDeploymentProvenance = existing.recordKind === 'deployment' ||
    Object.prototype.hasOwnProperty.call(existing, 'deploymentTransaction');
  if (hasDeploymentProvenance) {
    return {
      ...existing,
      ...common,
      recordKind: 'deployment',
    };
  }

  return {
    ...common,
    recordKind: 'verification-only',
  };
}

export function readRecord(address: string, env: V2EnvName = requestedEnv()): Record<string, unknown> | undefined {
  const destination = recordPath(address, env);
  if (!existsSync(destination)) return undefined;
  const value: unknown = JSON.parse(readFileSync(destination, 'utf8'));
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function writeRecord(record: Record<string, unknown>, address: string, env: V2EnvName = requestedEnv()): string {
  const destination = recordPath(address, env);
  mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp.${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, destination);
  return destination;
}
