import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  GENESIS_MINT_SEED,
  isV2EnvName,
  maintenanceKeyPath,
  prepareMaintenanceSigningKey,
  privateStateStoreName,
  profileFor,
  recordPath,
  reportConfirmedDeployment,
  REPOSITORY_ROOT,
  requestedEnv,
  stagenet,
  undeployed,
  UNDEPLOYED_MAINTENANCE_KEY_PATH,
  V2_ENV_NAMES,
  WALLET_NETWORK_IDS,
  walletNetworkIdFor,
} from '../scripts/profile.js';

const ADDRESS = 'a'.repeat(64);
const URL_VARS = [
  'MN_INDEXER_URL',
  'MN_INDEXER_WS_URL',
  'MN_NODE_URL',
  'MN_NODE_WS_URL',
  'MN_PROOF_SERVER_URL',
] as const;
const MANAGED_VARS = ['MN_ENV', 'MN_MAINTENANCE_KEY_FILE', 'DEPLOY_OUT', ...URL_VARS] as const;

const original = new Map(MANAGED_VARS.map((name) => [name, process.env[name]]));

afterEach(() => {
  for (const [name, value] of original) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const clearUrlOverrides = (): void => {
  for (const name of URL_VARS) delete process.env[name];
};

describe('v2 environment selection', () => {
  test('MN_ENV defaults to stagenet, accepts undeployed, and names both on anything else', () => {
    expect(V2_ENV_NAMES).toEqual(['stagenet', 'undeployed']);

    delete process.env.MN_ENV;
    expect(requestedEnv()).toBe('stagenet');

    process.env.MN_ENV = '   ';
    expect(requestedEnv()).toBe('stagenet');

    process.env.MN_ENV = ' undeployed ';
    expect(requestedEnv()).toBe('undeployed');

    process.env.MN_ENV = 'stagenet';
    expect(requestedEnv()).toBe('stagenet');

    for (const rejected of ['preview', 'preprod', 'Undeployed', 'ledger9']) {
      process.env.MN_ENV = rejected;
      expect(() => requestedEnv()).toThrow(`Invalid MN_ENV "${rejected}"`);
      expect(() => requestedEnv()).toThrow('stagenet | undeployed');
    }

    expect(isV2EnvName('undeployed')).toBe(true);
    expect(isV2EnvName('preview')).toBe(false);
  });

  test('wallet network ids match the SDK constants and the store name carries the env', () => {
    // Pinned to NetworkId.NetworkId.StageNet / .Undeployed by the compile-time
    // declaration in scripts/deploy.ts; asserted here as values.
    expect(WALLET_NETWORK_IDS).toEqual({ stagenet: 'stagenet', undeployed: 'undeployed' });
    expect(walletNetworkIdFor('stagenet')).toBe('stagenet');
    expect(walletNetworkIdFor('undeployed')).toBe('undeployed');

    expect(privateStateStoreName('stagenet')).toBe('shielded-night-v2-stagenet');
    expect(privateStateStoreName('undeployed')).toBe('shielded-night-v2-undeployed');
    expect(privateStateStoreName('undeployed', '-test')).toBe('shielded-night-v2-undeployed-test');
  });
});

describe('undeployed profile', () => {
  test('defaults to the 1.x lane loopback endpoints', () => {
    clearUrlOverrides();
    expect(undeployed()).toEqual({
      walletNetworkId: 'undeployed',
      networkId: 'undeployed',
      indexer: 'http://127.0.0.1:8088/api/v4/graphql',
      indexerWS: 'ws://127.0.0.1:8088/api/v4/graphql/ws',
      node: 'http://127.0.0.1:9944',
      nodeWS: 'ws://127.0.0.1:9944',
      proofServer: 'http://127.0.0.1:6300',
      faucet: undefined,
    });
    expect(GENESIS_MINT_SEED).toBe(`${'0'.repeat(63)}1`);
  });

  test('every endpoint is overridable, per call, and a blank override is ignored', () => {
    clearUrlOverrides();
    process.env.MN_INDEXER_URL = 'http://indexer:8088/api/v4/graphql';
    process.env.MN_INDEXER_WS_URL = 'ws://indexer:8088/api/v4/graphql/ws';
    process.env.MN_NODE_URL = 'http://node:9944';
    process.env.MN_NODE_WS_URL = 'ws://node:9944';
    process.env.MN_PROOF_SERVER_URL = 'http://proof-server:6300';

    expect(undeployed()).toMatchObject({
      indexer: 'http://indexer:8088/api/v4/graphql',
      indexerWS: 'ws://indexer:8088/api/v4/graphql/ws',
      node: 'http://node:9944',
      nodeWS: 'ws://node:9944',
      proofServer: 'http://proof-server:6300',
    });

    process.env.MN_NODE_URL = '   ';
    expect(undeployed().node).toBe('http://127.0.0.1:9944');
  });

  test('profileFor picks the profile without disturbing stagenet defaults', () => {
    clearUrlOverrides();
    expect(profileFor('undeployed')).toEqual(undeployed());
    expect(profileFor('stagenet')).toEqual(stagenet());
    expect(profileFor('stagenet')).toEqual({
      walletNetworkId: 'stagenet',
      networkId: 'stagenet',
      indexer: 'https://indexer.stagenet.shielded.tools/api/v4/graphql',
      indexerWS: 'wss://indexer.stagenet.shielded.tools/api/v4/graphql/ws',
      node: 'https://rpc.stagenet.shielded.tools',
      nodeWS: 'wss://rpc.stagenet.shielded.tools',
      proofServer: 'http://127.0.0.1:6300',
      faucet: undefined,
    });
  });
});

describe('maintenance key custody per env', () => {
  test('stagenet still demands an explicit absolute durable path', () => {
    delete process.env.MN_MAINTENANCE_KEY_FILE;
    expect(() => maintenanceKeyPath('stagenet')).toThrow('Set MN_MAINTENANCE_KEY_FILE');
    process.env.MN_MAINTENANCE_KEY_FILE = 'relative-key.json';
    expect(() => maintenanceKeyPath('stagenet')).toThrow('must be an absolute path');

    // The default env is stagenet, so an unparameterized call is unchanged.
    delete process.env.MN_ENV;
    delete process.env.MN_MAINTENANCE_KEY_FILE;
    expect(() => maintenanceKeyPath()).toThrow('Set MN_MAINTENANCE_KEY_FILE');
  });

  test('undeployed makes the key file optional and accepts a relative override', () => {
    delete process.env.MN_MAINTENANCE_KEY_FILE;
    expect(maintenanceKeyPath('undeployed')).toBe(UNDEPLOYED_MAINTENANCE_KEY_PATH);
    expect(UNDEPLOYED_MAINTENANCE_KEY_PATH).toBe(
      path.join(REPOSITORY_ROOT, '.local', 'private-state', 'v2-undeployed', 'maintenance-key.json'),
    );

    process.env.MN_ENV = 'undeployed';
    expect(maintenanceKeyPath()).toBe(UNDEPLOYED_MAINTENANCE_KEY_PATH);

    process.env.MN_MAINTENANCE_KEY_FILE = 'relative-key.json';
    expect(maintenanceKeyPath('undeployed')).toBe(path.resolve(process.cwd(), 'relative-key.json'));

    const absolute = path.join(tmpdir(), 'explicit-undeployed-key.json');
    process.env.MN_MAINTENANCE_KEY_FILE = absolute;
    expect(maintenanceKeyPath('undeployed')).toBe(absolute);
  });

  test('an undeployed key is written 0600 and records network "undeployed"', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'shielded-night-v2-undeployed-key-'));
    const destination = path.join(directory, 'nested', 'maintenance-key.json');
    process.env.MN_MAINTENANCE_KEY_FILE = destination;
    try {
      const created = prepareMaintenanceSigningKey(
        { sourceCommit: '1'.repeat(40), artifactSha256: '2'.repeat(64) },
        'undeployed',
      );
      expect(created.created).toBe(true);
      expect(created.path).toBe(destination);
      expect(statSync(destination).mode & 0o777).toBe(0o600);

      const record = JSON.parse(readFileSync(destination, 'utf8'));
      expect(record.network).toBe('undeployed');
      expect(record.recordKind).toBe('shielded-night-maintenance-signing-key');

      const reused = prepareMaintenanceSigningKey(
        { sourceCommit: '3'.repeat(40), artifactSha256: '4'.repeat(64) },
        'undeployed',
      );
      expect(reused.created).toBe(false);
      expect(reused.verifyingKey).toEqual(created.verifyingKey);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('a key file belonging to the other network is refused in both directions', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'shielded-night-v2-key-network-'));
    const destination = path.join(directory, 'maintenance-key.json');
    process.env.MN_MAINTENANCE_KEY_FILE = destination;
    try {
      prepareMaintenanceSigningKey(
        { sourceCommit: '1'.repeat(40), artifactSha256: '2'.repeat(64) },
        'stagenet',
      );
      expect(() => prepareMaintenanceSigningKey(
        { sourceCommit: '1'.repeat(40), artifactSha256: '2'.repeat(64) },
        'undeployed',
      )).toThrow('created for network "stagenet" but MN_ENV is "undeployed"');

      const stagenetRecord = JSON.parse(readFileSync(destination, 'utf8'));
      writeFileSync(destination, `${JSON.stringify({ ...stagenetRecord, network: 'undeployed' }, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      expect(() => prepareMaintenanceSigningKey(
        { sourceCommit: '1'.repeat(40), artifactSha256: '2'.repeat(64) },
        'stagenet',
      )).toThrow('created for network "undeployed" but MN_ENV is "stagenet"');
      expect(prepareMaintenanceSigningKey(
        { sourceCommit: '1'.repeat(40), artifactSha256: '2'.repeat(64) },
        'undeployed',
      ).created).toBe(false);

      writeFileSync(destination, `${JSON.stringify({ ...stagenetRecord, network: 'preview' }, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      expect(() => prepareMaintenanceSigningKey(
        { sourceCommit: '1'.repeat(40), artifactSha256: '2'.repeat(64) },
        'undeployed',
      )).toThrow('unsupported schema or network');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('records and printed identity per env', () => {
  test('the record file name carries the env, and DEPLOY_OUT still wins', () => {
    delete process.env.DEPLOY_OUT;
    expect(recordPath(ADDRESS, 'stagenet')).toBe(
      path.join(REPOSITORY_ROOT, '.local', 'deployments', `v2-stagenet-${ADDRESS}.json`),
    );
    expect(recordPath(ADDRESS, 'undeployed')).toBe(
      path.join(REPOSITORY_ROOT, '.local', 'deployments', `v2-undeployed-${ADDRESS}.json`),
    );

    delete process.env.MN_ENV;
    expect(recordPath(ADDRESS)).toBe(recordPath(ADDRESS, 'stagenet'));
    process.env.MN_ENV = 'undeployed';
    expect(recordPath(ADDRESS)).toBe(recordPath(ADDRESS, 'undeployed'));

    process.env.DEPLOY_OUT = path.join(tmpdir(), 'explicit-record.json');
    expect(recordPath(ADDRESS, 'undeployed')).toBe(process.env.DEPLOY_OUT);
  });

  test('stagenet keeps its exact three lines; undeployed prints UNDEPLOYED_ADDRESS=', () => {
    const stagenetMessages: string[] = [];
    delete process.env.MN_ENV;
    expect(reportConfirmedDeployment(
      { contractAddress: ADDRESS, txId: 'synthetic-confirmed-tx' },
      (message) => stagenetMessages.push(message),
    )).toBe(ADDRESS);
    expect(stagenetMessages).toEqual([
      `[deploy] confirmed stagenet contract ${ADDRESS}`,
      '[deploy] confirmed transaction synthetic-confirmed-tx',
      `STAGENET_ADDRESS=${ADDRESS}`,
    ]);

    const undeployedMessages: string[] = [];
    expect(reportConfirmedDeployment(
      { contractAddress: ADDRESS, txId: 'synthetic-confirmed-tx' },
      (message) => undeployedMessages.push(message),
      'undeployed',
    )).toBe(ADDRESS);
    expect(undeployedMessages).toEqual([
      `[deploy] confirmed undeployed contract ${ADDRESS}`,
      '[deploy] confirmed transaction synthetic-confirmed-tx',
      `UNDEPLOYED_ADDRESS=${ADDRESS}`,
    ]);
  });
});
