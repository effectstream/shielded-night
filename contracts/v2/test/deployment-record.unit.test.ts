import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { unshieldedToken } from '@midnightntwrk/ledger-v9';
import {
  assertMaintenanceAuthorityKey,
  createWalletLogger,
  deploymentWalletSyncTimeoutMs,
  mergeVerificationRecord,
  preflightRecordOutput,
  prepareMaintenanceSigningKey,
  reportConfirmedDeployment,
  sourceCommit,
  type Verification,
  withDurableMaintenanceKey,
  withSyncedDeploymentWallet,
} from '../scripts/profile.js';

const ADDRESS = 'a'.repeat(64);
const verification: Verification = {
  address: ADDRESS,
  verifierKeys: { circuit: 'b'.repeat(64) },
  metadata: { name: 'Shielded Night', symbol: 'sNight', decimals: 6 },
  authority: {
    locked: false,
    committeeSize: 1,
    committee: [{ tag: 'schnorr', value: 'c'.repeat(64) }],
    threshold: '1',
    counter: '0',
  },
};

const originalDeployOut = process.env.DEPLOY_OUT;
const originalSourceCommit = process.env.SHIELDED_NIGHT_COMMIT;
const originalMaintenanceKeyFile = process.env.MN_MAINTENANCE_KEY_FILE;
const originalWalletSyncTimeout = process.env.MN_WALLET_SYNC_TIMEOUT_MS;
const originalEnv = process.env.MN_ENV;

// Every assertion in this file pins the DEFAULT (stagenet) lane, so the
// `undeployed` lane cannot change it by being exported in the caller's shell.
beforeEach(() => {
  delete process.env.MN_ENV;
});

afterEach(() => {
  if (originalEnv === undefined) delete process.env.MN_ENV;
  else process.env.MN_ENV = originalEnv;
  if (originalDeployOut === undefined) delete process.env.DEPLOY_OUT;
  else process.env.DEPLOY_OUT = originalDeployOut;
  if (originalSourceCommit === undefined) delete process.env.SHIELDED_NIGHT_COMMIT;
  else process.env.SHIELDED_NIGHT_COMMIT = originalSourceCommit;
  if (originalMaintenanceKeyFile === undefined) delete process.env.MN_MAINTENANCE_KEY_FILE;
  else process.env.MN_MAINTENANCE_KEY_FILE = originalMaintenanceKeyFile;
  if (originalWalletSyncTimeout === undefined) delete process.env.MN_WALLET_SYNC_TIMEOUT_MS;
  else process.env.MN_WALLET_SYNC_TIMEOUT_MS = originalWalletSyncTimeout;
});

describe('deployment safety', () => {
  test('silent wallet logger cannot emit an interpolated seed', () => {
    const chunks: Buffer[] = [];
    const sink = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    });
    const fixtureSeed = 'synthetic-fixture-seed-that-must-never-appear';
    const logger = createWalletLogger(sink);
    logger.info(`Your wallet seed is: ${fixtureSeed}`);
    logger.error(`A second interpolated seed is: ${fixtureSeed}`);
    logger.flush();
    expect(Buffer.concat(chunks).toString('utf8')).not.toContain(fixtureSeed);
    expect(Buffer.concat(chunks)).toHaveLength(0);
  });

  test('prints confirmed address and transaction before later record work can fail', () => {
    const messages: string[] = [];
    const address = reportConfirmedDeployment(
      { contractAddress: ADDRESS, txId: 'synthetic-confirmed-tx' },
      (message) => messages.push(message),
    );

    expect(address).toBe(ADDRESS);
    expect(messages).toEqual([
      `[deploy] confirmed stagenet contract ${ADDRESS}`,
      '[deploy] confirmed transaction synthetic-confirmed-tx',
      `STAGENET_ADDRESS=${ADDRESS}`,
    ]);
    expect(() => { throw new Error('synthetic record failure'); }).toThrow('synthetic record failure');
    expect(messages).toHaveLength(3);
  });

  test('preflights record creation and rejects an unusable output path', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'shielded-night-record-'));
    try {
      process.env.DEPLOY_OUT = path.join(directory, 'deployment.json');
      preflightRecordOutput();
      expect(existsSync(process.env.DEPLOY_OUT)).toBe(false);
      expect(readdirSync(directory)).toEqual([]);

      const parentFile = path.join(directory, 'not-a-directory');
      writeFileSync(parentFile, 'synthetic fixture');
      process.env.DEPLOY_OUT = path.join(parentFile, 'deployment.json');
      expect(() => preflightRecordOutput()).toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('requires an explicit absolute durable maintenance-key path before deployment', () => {
    delete process.env.MN_MAINTENANCE_KEY_FILE;
    expect(() => prepareMaintenanceSigningKey({
      sourceCommit: '1'.repeat(40),
      artifactSha256: '2'.repeat(64),
    })).toThrow('Set MN_MAINTENANCE_KEY_FILE');

    process.env.MN_MAINTENANCE_KEY_FILE = 'relative-key.json';
    expect(() => prepareMaintenanceSigningKey({
      sourceCommit: '1'.repeat(40),
      artifactSha256: '2'.repeat(64),
    })).toThrow('must be an absolute path');
  });

  test('does not enter wallet startup or submission when durable key preflight fails', async () => {
    delete process.env.MN_MAINTENANCE_KEY_FILE;
    const walletAndSubmission = vi.fn(async () => undefined);
    await expect(withDurableMaintenanceKey({
      sourceCommit: '1'.repeat(40),
      artifactSha256: '2'.repeat(64),
    }, walletAndSubmission)).rejects.toThrow('Set MN_MAINTENANCE_KEY_FILE');
    expect(walletAndSubmission).not.toHaveBeenCalled();
  });

  test('uses a bounded wallet sync, requires NIGHT and DUST, and always stops', async () => {
    const wallet = { fixture: 'wallet' };
    const provider = {
      wallet,
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    };
    const fundedState = (night: bigint, dust: bigint) => ({
      unshielded: { balances: { [unshieldedToken().raw]: night } },
      dust: { balance: () => dust },
    });
    const action = vi.fn(async () => 'deployed');
    const sync = vi.fn(async () => fundedState(1n, 1n));

    delete process.env.MN_WALLET_SYNC_TIMEOUT_MS;
    await expect(withSyncedDeploymentWallet(provider, sync, action)).resolves.toBe('deployed');
    expect(provider.start).toHaveBeenCalledWith(false);
    expect(sync).toHaveBeenCalledWith(wallet, 2_000, 300_000);
    expect(action).toHaveBeenCalledOnce();
    expect(provider.stop).toHaveBeenCalledOnce();

    process.env.MN_WALLET_SYNC_TIMEOUT_MS = '180000';
    expect(deploymentWalletSyncTimeoutMs()).toBe(180_000);
    process.env.MN_WALLET_SYNC_TIMEOUT_MS = '29999';
    expect(() => deploymentWalletSyncTimeoutMs()).toThrow('between 30000 and 900000');
    process.env.MN_WALLET_SYNC_TIMEOUT_MS = 'not-a-timeout';
    expect(() => deploymentWalletSyncTimeoutMs()).toThrow('integer number of milliseconds');

    process.env.MN_WALLET_SYNC_TIMEOUT_MS = '180000';
    const noNightAction = vi.fn(async () => undefined);
    const noNightProvider = {
      wallet,
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    };
    await expect(withSyncedDeploymentWallet(
      noNightProvider,
      async () => fundedState(0n, 1n),
      noNightAction,
    )).rejects.toThrow('no available NIGHT');
    expect(noNightAction).not.toHaveBeenCalled();
    expect(noNightProvider.stop).toHaveBeenCalledOnce();

    const noDustAction = vi.fn(async () => undefined);
    const noDustProvider = {
      wallet,
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    };
    await expect(withSyncedDeploymentWallet(
      noDustProvider,
      async () => fundedState(1n, 0n),
      noDustAction,
    )).rejects.toThrow('no available DUST');
    expect(noDustAction).not.toHaveBeenCalled();
    expect(noDustProvider.stop).toHaveBeenCalledOnce();

    const timedOutAction = vi.fn(async () => undefined);
    const timedOutProvider = {
      wallet,
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    };
    await expect(withSyncedDeploymentWallet(
      timedOutProvider,
      async () => { throw new Error('synthetic sync timeout'); },
      timedOutAction,
    )).rejects.toThrow('synthetic sync timeout');
    expect(timedOutAction).not.toHaveBeenCalled();
    expect(timedOutProvider.stop).toHaveBeenCalledOnce();
  });

  test('persists mode-0600 signing-key custody before use and restores it in a fresh process', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'shielded-night-key-'));
    const destination = path.join(directory, 'maintenance-key.json');
    process.env.MN_MAINTENANCE_KEY_FILE = destination;
    try {
      const created = prepareMaintenanceSigningKey({
        sourceCommit: '1'.repeat(40),
        artifactSha256: '2'.repeat(64),
      });
      expect(created.created).toBe(true);
      expect(statSync(destination).mode & 0o777).toBe(0o600);

      const reopened = prepareMaintenanceSigningKey({
        sourceCommit: '3'.repeat(40),
        artifactSha256: '4'.repeat(64),
      });
      expect(reopened.created).toBe(false);
      expect(reopened.signingKey).toEqual(created.signingKey);
      expect(reopened.verifyingKey).toEqual(created.verifyingKey);

      const profileUrl = pathToFileURL(path.resolve(import.meta.dirname, '../scripts/profile.ts')).href;
      const childScript = [
        `const { prepareMaintenanceSigningKey } = await import(${JSON.stringify(profileUrl)});`,
        `const key = prepareMaintenanceSigningKey({ sourceCommit: '${'5'.repeat(40)}', artifactSha256: '${'6'.repeat(64)}' });`,
        'process.stdout.write(JSON.stringify(key.verifyingKey));',
      ].join('\n');
      const freshProcessPublicKey = JSON.parse(execFileSync(process.execPath, [
        '--import', 'tsx', '--input-type=module', '-e', childScript,
      ], {
        cwd: path.resolve(import.meta.dirname, '..'),
        env: { ...process.env, MN_MAINTENANCE_KEY_FILE: destination },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }));
      expect(freshProcessPublicKey).toEqual(created.verifyingKey);

      const matchingVerification: Verification = {
        ...verification,
        authority: { ...verification.authority, committee: [created.verifyingKey] },
      };
      expect(() => assertMaintenanceAuthorityKey(matchingVerification, created.verifyingKey)).not.toThrow();
      expect(() => assertMaintenanceAuthorityKey(verification, created.verifyingKey)).toThrow(
        'does not match the durably persisted signing key',
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('rejects permissive, malformed, or mismatched existing maintenance-key files', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'shielded-night-key-invalid-'));
    const destination = path.join(directory, 'maintenance-key.json');
    process.env.MN_MAINTENANCE_KEY_FILE = destination;
    try {
      prepareMaintenanceSigningKey({
        sourceCommit: '1'.repeat(40),
        artifactSha256: '2'.repeat(64),
      });
      chmodSync(destination, 0o644);
      expect(() => prepareMaintenanceSigningKey({
        sourceCommit: '1'.repeat(40),
        artifactSha256: '2'.repeat(64),
      })).toThrow('must have mode 0600');

      chmodSync(destination, 0o600);
      const validRecord = JSON.parse(readFileSync(destination, 'utf8'));
      const fixturePrivateValue = 'feed'.repeat(16);
      writeFileSync(destination, `${JSON.stringify({
        ...validRecord,
        signingKey: { ...validRecord.signingKey, value: fixturePrivateValue },
      })}\n`, 'utf8');
      const invalidKeyError = (() => {
        try {
          prepareMaintenanceSigningKey({
            sourceCommit: '1'.repeat(40),
            artifactSha256: '2'.repeat(64),
          });
        } catch (caught) {
          return caught;
        }
      })();
      expect(invalidKeyError).toBeInstanceOf(Error);
      expect(String((invalidKeyError as Error).stack ?? (invalidKeyError as Error).message)).not.toContain(
        fixturePrivateValue,
      );

      writeFileSync(destination, `${JSON.stringify({
        ...validRecord,
        verifyingKey: { ...validRecord.verifyingKey, value: '0'.repeat(64) },
      })}\n`, 'utf8');
      expect(() => prepareMaintenanceSigningKey({
        sourceCommit: '1'.repeat(40),
        artifactSha256: '2'.repeat(64),
      })).toThrow('does not match its signing key');

      const fixtureSecret = 'synthetic-secret-that-must-not-appear';
      writeFileSync(destination, `{not-json-${fixtureSecret}}\n`, 'utf8');
      const error = (() => {
        try {
          prepareMaintenanceSigningKey({
            sourceCommit: '1'.repeat(40),
            artifactSha256: '2'.repeat(64),
          });
        } catch (caught) {
          return caught;
        }
      })();
      expect(error).toBeInstanceOf(Error);
      expect(String((error as Error).stack ?? (error as Error).message)).toContain('malformed JSON');
      expect(String((error as Error).stack ?? (error as Error).message)).not.toContain(fixtureSecret);
      expect(() => prepareMaintenanceSigningKey({
        sourceCommit: '1'.repeat(40),
        artifactSha256: '2'.repeat(64),
      })).toThrow('malformed JSON');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('rejects malformed configured source provenance', () => {
    process.env.SHIELDED_NIGHT_COMMIT = 'not-a-full-git-sha';
    expect(() => sourceCommit()).toThrow('full 40-character hexadecimal Git SHA');
  });

  test('later verification preserves immutable deployment provenance and appends history', () => {
    const original = {
      schemaVersion: 1,
      contractAddress: ADDRESS,
      sourceCommit: '1'.repeat(40),
      artifactSha256: '2'.repeat(64),
      compatibility: { compiler: 'deployment-compiler' },
      deploymentTransaction: { id: 'original-tx' },
      network: { name: 'stagenet', node: 'original-node' },
    };
    const firstVerification = mergeVerificationRecord({
      existing: original,
      network: { name: 'stagenet', node: 'verification-node' },
      verified: verification,
      verificationSourceCommit: '3'.repeat(40),
      verificationArtifactSha256: '4'.repeat(64),
      verifiedAt: '2026-09-07T00:00:00.000Z',
    });
    const record = mergeVerificationRecord({
      existing: firstVerification,
      network: { name: 'stagenet', node: 'later-verification-node' },
      verified: verification,
      verificationSourceCommit: '5'.repeat(40),
      verificationArtifactSha256: '6'.repeat(64),
      verifiedAt: '2026-09-08T00:00:00.000Z',
    });

    expect(record.recordKind).toBe('deployment');
    expect(record.schemaVersion).toBe(2);
    expect(record.sourceCommit).toBe(original.sourceCommit);
    expect(record.artifactSha256).toBe(original.artifactSha256);
    expect(record.compatibility).toEqual(original.compatibility);
    expect(record.deploymentTransaction).toEqual(original.deploymentTransaction);
    expect(record.network).toEqual(original.network);
    expect(record.verification).toMatchObject({
      sourceCommit: '5'.repeat(40),
      artifactSha256: '6'.repeat(64),
      network: { node: 'later-verification-node' },
    });
    expect(record.verificationHistory).toHaveLength(2);
  });

  test('a verifier-created record is explicit and never invents deployment provenance', () => {
    const first = mergeVerificationRecord({
      network: { name: 'stagenet', node: 'verification-node' },
      verified: verification,
      verificationSourceCommit: '7'.repeat(40),
      verificationArtifactSha256: '8'.repeat(64),
      verifiedAt: '2026-09-07T00:00:00.000Z',
    });
    const second = mergeVerificationRecord({
      existing: first,
      network: { name: 'stagenet', node: 'newer-verification-node' },
      verified: verification,
      verificationSourceCommit: '9'.repeat(40),
      verificationArtifactSha256: '0'.repeat(64),
      verifiedAt: '2026-09-08T00:00:00.000Z',
    });

    expect(second.recordKind).toBe('verification-only');
    expect(second).not.toHaveProperty('deploymentTransaction');
    expect(second).not.toHaveProperty('sourceCommit');
    expect(second).not.toHaveProperty('artifactSha256');
    expect(second.verificationHistory).toHaveLength(2);
    expect(second.verification).toMatchObject({
      sourceCommit: '9'.repeat(40),
      network: { node: 'newer-verification-node' },
    });
  });

  test('refuses to merge a record for another contract address', () => {
    expect(() => mergeVerificationRecord({
      existing: { contractAddress: 'c'.repeat(64), deploymentTransaction: { id: 'tx' } },
      network: { name: 'stagenet' },
      verified: verification,
      verificationSourceCommit: 'd'.repeat(40),
      verificationArtifactSha256: 'e'.repeat(64),
      verifiedAt: '2026-09-07T00:00:00.000Z',
    })).toThrow('does not match verified address');
  });
});
