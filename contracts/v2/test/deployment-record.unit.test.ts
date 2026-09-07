import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, test } from 'vitest';
import {
  createWalletLogger,
  mergeVerificationRecord,
  preflightRecordOutput,
  reportConfirmedDeployment,
  sourceCommit,
  type Verification,
} from '../scripts/profile.js';

const ADDRESS = 'a'.repeat(64);
const verification: Verification = {
  address: ADDRESS,
  verifierKeys: { circuit: 'b'.repeat(64) },
  metadata: { name: 'Shielded Night', symbol: 'sNight', decimals: 6 },
  authority: { locked: false, committeeSize: 1, threshold: '1', counter: '0' },
};

const originalDeployOut = process.env.DEPLOY_OUT;
const originalSourceCommit = process.env.SHIELDED_NIGHT_COMMIT;

afterEach(() => {
  if (originalDeployOut === undefined) delete process.env.DEPLOY_OUT;
  else process.env.DEPLOY_OUT = originalDeployOut;
  if (originalSourceCommit === undefined) delete process.env.SHIELDED_NIGHT_COMMIT;
  else process.env.SHIELDED_NIGHT_COMMIT = originalSourceCommit;
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
