/**
 * The optional deploy record (`DEPLOY_OUT`, scripts/deploy-record.ts).
 *
 * An automated deployment reads the contract address out of this file instead
 * of scraping stdout, and may poll for it while the deploy runs — so the two
 * things pinned here are that the knob is OFF by default (nothing written, no
 * behaviour change for existing callers) and that the file appears atomically
 * with the fields the reader expects.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeDeployRecord } from '../../scripts/deploy-record.js';

const ADDRESS = '80b89b9a4213c61da84f54b2ea02e2809f9c4dedbdafacd04b38d4667bee1396';
const INPUT = {
  address: ADDRESS,
  networkId: 'undeployed',
  name: 'Shielded Night',
  symbol: 'sNight',
  decimals: 6n,
} as const;

let dir: string;
const savedOut = process.env.DEPLOY_OUT;
const savedCommit = process.env.SHIELDED_NIGHT_COMMIT;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'sn-deploy-record-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (savedOut === undefined) delete process.env.DEPLOY_OUT;
  else process.env.DEPLOY_OUT = savedOut;
  if (savedCommit === undefined) delete process.env.SHIELDED_NIGHT_COMMIT;
  else process.env.SHIELDED_NIGHT_COMMIT = savedCommit;
});

describe('writeDeployRecord', () => {
  it('writes nothing when DEPLOY_OUT is unset', () => {
    delete process.env.DEPLOY_OUT;
    expect(writeDeployRecord(INPUT)).toBeUndefined();
    expect(readdirSync(dir)).toEqual([]);
  });

  it('writes nothing when DEPLOY_OUT is blank', () => {
    process.env.DEPLOY_OUT = '  ';
    expect(writeDeployRecord(INPUT)).toBeUndefined();
    expect(readdirSync(dir)).toEqual([]);
  });

  it('writes the record, creating missing parent directories', () => {
    const target = path.join(dir, 'srv', 'shielded-night', 'contract.json');
    process.env.DEPLOY_OUT = target;
    process.env.SHIELDED_NIGHT_COMMIT = '1502200513'.padEnd(40, '0');

    expect(writeDeployRecord(INPUT)).toBe(target);

    const record = JSON.parse(readFileSync(target, 'utf-8')) as Record<string, unknown>;
    expect(record.address).toBe(ADDRESS);
    expect(record.networkId).toBe('undeployed');
    expect(record.name).toBe('Shielded Night');
    expect(record.symbol).toBe('sNight');
    expect(record.decimals).toBe(6); // bigint in, JSON number out
    expect(record.commit).toBe(process.env.SHIELDED_NIGHT_COMMIT);
    expect(record.locked).toBe(false);
    expect(typeof record.deployedAt).toBe('string');
    expect(new Date(record.deployedAt as string).toISOString()).toBe(record.deployedAt);
  });

  it('records locked:true when the caller locked the contract', () => {
    const target = path.join(dir, 'contract.json');
    process.env.DEPLOY_OUT = target;
    writeDeployRecord({ ...INPUT, locked: true });
    expect(JSON.parse(readFileSync(target, 'utf-8')).locked).toBe(true);
  });

  it('leaves no temp file behind (a reader must never see a partial record)', () => {
    const target = path.join(dir, 'contract.json');
    process.env.DEPLOY_OUT = target;
    writeDeployRecord(INPUT);
    expect(readdirSync(dir)).toEqual(['contract.json']);
  });

  it('overwrites a previous record in place', () => {
    const target = path.join(dir, 'contract.json');
    process.env.DEPLOY_OUT = target;
    writeDeployRecord(INPUT);
    writeDeployRecord({ ...INPUT, address: 'f'.repeat(64) });
    expect(JSON.parse(readFileSync(target, 'utf-8')).address).toBe('f'.repeat(64));
    expect(readdirSync(dir)).toEqual(['contract.json']);
  });
});
