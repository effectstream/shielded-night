/**
 * Endpoint overrides for the network configs (test/support/network.ts).
 *
 * `networkFor()` is what every script and the integration global-setup resolve
 * their URLs through, so these assertions pin the contract a compose
 * deployment depends on: on `undeployed` all four endpoints are overridable
 * (nothing can reach 127.0.0.1 from inside another container), on the hosted
 * envs only the proof server is (repointing `preview` at a stray local indexer
 * because a variable was left exported would be a silent, expensive bug).
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  NETWORK_URL_ENV_VARS,
  networkFor,
  PreviewNetwork,
  UndeployedNetwork,
} from '../support/network.js';

const VARS = Object.values(NETWORK_URL_ENV_VARS);

afterEach(() => {
  for (const v of VARS) delete process.env[v];
});

describe('networkFor endpoint overrides', () => {
  it('defaults to the loopback devnet on undeployed', () => {
    expect(networkFor('undeployed')).toEqual(UndeployedNetwork);
  });

  it('defaults to the hosted endpoints on preview', () => {
    expect(networkFor('preview')).toEqual(PreviewNetwork);
  });

  it('overrides all four endpoints on undeployed (compose service hostnames)', () => {
    process.env.MN_INDEXER_URL = 'http://indexer:8088/api/v4/graphql';
    process.env.MN_INDEXER_WS_URL = 'ws://indexer:8088/api/v4/graphql/ws';
    process.env.MN_NODE_URL = 'http://node:9944';
    process.env.MN_PROOF_SERVER_URL = 'http://proof-server:6300';

    expect(networkFor('undeployed')).toEqual({
      indexer: 'http://indexer:8088/api/v4/graphql',
      indexerWS: 'ws://indexer:8088/api/v4/graphql/ws',
      node: 'http://node:9944',
      proofServer: 'http://proof-server:6300',
      networkId: 'undeployed',
    });
  });

  it('overrides one endpoint at a time, leaving the rest at their defaults', () => {
    process.env.MN_NODE_URL = 'http://127.0.0.1:31944';
    expect(networkFor('undeployed')).toEqual({ ...UndeployedNetwork, node: 'http://127.0.0.1:31944' });
  });

  it('treats a blank override as unset', () => {
    process.env.MN_INDEXER_URL = '   ';
    process.env.MN_NODE_URL = '';
    expect(networkFor('undeployed')).toEqual(UndeployedNetwork);
  });

  it('trims an override (a value read from a file with a trailing newline)', () => {
    process.env.MN_NODE_URL = ' http://node:9944\n';
    expect(networkFor('undeployed').node).toBe('http://node:9944');
  });

  it('honours only MN_PROOF_SERVER_URL on the hosted envs', () => {
    process.env.MN_INDEXER_URL = 'http://indexer:8088/api/v4/graphql';
    process.env.MN_INDEXER_WS_URL = 'ws://indexer:8088/api/v4/graphql/ws';
    process.env.MN_NODE_URL = 'http://node:9944';
    process.env.MN_PROOF_SERVER_URL = 'http://proof-server:6300';

    for (const env of ['preview', 'preprod', 'qanet'] as const) {
      const cfg = networkFor(env);
      expect(cfg.proofServer).toBe('http://proof-server:6300');
      expect(cfg.indexer).toBe(networkFor(env).indexer);
      expect(cfg.indexer).toContain(`indexer.${env}.midnight.network`);
      expect(cfg.node).toContain(`rpc.${env}.midnight.network`);
      expect(cfg.indexerWS).toContain(`indexer.${env}.midnight.network`);
    }
  });

  it('does not mutate the exported defaults', () => {
    process.env.MN_NODE_URL = 'http://node:9944';
    networkFor('undeployed');
    networkFor('preview');
    expect(UndeployedNetwork.node).toBe('http://127.0.0.1:9944');
    expect(PreviewNetwork.proofServer).toBe('http://127.0.0.1:6300');
  });
});
