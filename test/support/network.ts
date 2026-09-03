export interface NetworkConfig {
  readonly indexer: string;
  readonly indexerWS: string;
  readonly node: string;
  readonly proofServer: string;
  readonly networkId: string;
}

/**
 * Environment variables that override the endpoint URLs, applied by {@link networkFor}.
 *
 * The `undeployed` defaults below assume the devnet is reachable on this host's
 * loopback (what `bun run test:integration` gets from testcontainers, and what a
 * hand-started `envs/docker-compose-dynamic.yml` gives on the default ports).
 * That is wrong for two real cases: a stack on non-default ports, and a caller
 * running INSIDE the same docker network, which must dial service hostnames
 * (`http://indexer:8088/api/v4/graphql`) and cannot reach 127.0.0.1 at all.
 * Setting these makes `deploy.ts` / `deploy-and-lock.ts` / `lock.ts` /
 * `verify-deployment.ts` — and the integration suite in external-stack mode
 * (`MN_EXTERNAL_STACK=1`, see test/integration/global-setup.ts) — talk to that
 * stack instead. Unset means "use the default", so nothing changes for existing
 * callers.
 *
 * On the HOSTED envs only `MN_PROOF_SERVER_URL` applies: the indexer/node URLs
 * identify the network itself, and silently repointing `preview` at some other
 * indexer because a local-stack variable was left exported would be a footgun.
 * The proof server is the operator's own (the hosted configs hard-coded a local
 * one), so it is the one endpoint worth overriding there.
 */
export const NETWORK_URL_ENV_VARS = {
  indexer: 'MN_INDEXER_URL',
  indexerWS: 'MN_INDEXER_WS_URL',
  node: 'MN_NODE_URL',
  proofServer: 'MN_PROOF_SERVER_URL',
} as const;

/** Read an override; blank/whitespace counts as unset so `MN_NODE_URL=` in an .env file is harmless. */
const fromEnv = (name: string, fallback: string): string => {
  const value = process.env[name]?.trim();
  return value !== undefined && value.length > 0 ? value : fallback;
};

/** Local devnet defaults (loopback, default ports) — overridable, see {@link NETWORK_URL_ENV_VARS}. */
export const UndeployedNetwork: NetworkConfig = {
  indexer: 'http://127.0.0.1:8088/api/v4/graphql',
  indexerWS: 'ws://127.0.0.1:8088/api/v4/graphql/ws',
  node: 'http://127.0.0.1:9944',
  proofServer: 'http://127.0.0.1:6300',
  networkId: 'undeployed',
};

/** Hosted preprod defaults; only `proofServer` is overridable (see {@link NETWORK_URL_ENV_VARS}). */
export const PreprodNetwork: NetworkConfig = {
  indexer: 'https://indexer.preprod.midnight.network/api/v4/graphql',
  indexerWS: 'wss://indexer.preprod.midnight.network/api/v4/graphql/ws',
  node: 'https://rpc.preprod.midnight.network',
  proofServer: 'http://127.0.0.1:6300',
  networkId: 'preprod',
};

/** Hosted preview defaults; only `proofServer` is overridable (see {@link NETWORK_URL_ENV_VARS}). */
export const PreviewNetwork: NetworkConfig = {
  indexer: 'https://indexer.preview.midnight.network/api/v4/graphql',
  indexerWS: 'wss://indexer.preview.midnight.network/api/v4/graphql/ws',
  node: 'https://rpc.preview.midnight.network',
  proofServer: 'http://127.0.0.1:6300',
  networkId: 'preview',
};

/** Hosted qanet defaults; only `proofServer` is overridable (see {@link NETWORK_URL_ENV_VARS}). */
export const QanetNetwork: NetworkConfig = {
  indexer: 'https://indexer.qanet.midnight.network/api/v4/graphql',
  indexerWS: 'wss://indexer.qanet.midnight.network/api/v4/graphql/ws',
  node: 'https://rpc.qanet.midnight.network',
  proofServer: 'http://127.0.0.1:6300',
  networkId: 'qanet',
};

/**
 * Every valid environment name — the SINGLE SOURCE OF TRUTH. `EnvName`, `isEnvName`, and all MN_ENV / `--env`
 * validation derive from this, so adding an env is a one-line change here. (Previously each call site had its own
 * hardcoded list; a missed one broke `qanet` hosted-smoke at vitest global setup.)
 */
export const ENV_NAMES = ['undeployed', 'preprod', 'preview', 'qanet'] as const;
export type EnvName = (typeof ENV_NAMES)[number];

/** Type guard for {@link EnvName}. */
export const isEnvName = (s: string): s is EnvName => (ENV_NAMES as readonly string[]).includes(s);

/** The unmodified defaults for an env, before {@link NETWORK_URL_ENV_VARS} are applied. */
const defaultsFor = (env: EnvName): NetworkConfig => {
  switch (env) {
    case 'undeployed':
      return UndeployedNetwork;
    case 'preprod':
      return PreprodNetwork;
    case 'preview':
      return PreviewNetwork;
    case 'qanet':
      return QanetNetwork;
  }
};

/**
 * The network config for an env, with {@link NETWORK_URL_ENV_VARS} applied:
 * all four endpoints on `undeployed`, the proof server only on hosted envs.
 * Resolved per CALL, so a caller that loads a `.env.<env>` file before calling
 * (global-setup does) still gets its overrides.
 */
export const networkFor = (env: EnvName): NetworkConfig => {
  const base = defaultsFor(env);
  const proofServer = fromEnv(NETWORK_URL_ENV_VARS.proofServer, base.proofServer);
  if (env !== 'undeployed') return { ...base, proofServer };
  return {
    ...base,
    proofServer,
    indexer: fromEnv(NETWORK_URL_ENV_VARS.indexer, base.indexer),
    indexerWS: fromEnv(NETWORK_URL_ENV_VARS.indexerWS, base.indexerWS),
    node: fromEnv(NETWORK_URL_ENV_VARS.node, base.node),
  };
};

// Genesis-block-funded seed; only valid on undeployed (dev) networks.
export const GENESIS_MINT_SEED = '0000000000000000000000000000000000000000000000000000000000000001';

/**
 * Pre-funded seeds on the local `undeployed` devnet: the genesis block mints NIGHT to the first three accounts derived
 * from these seeds, so any test that needs >1 funded wallet on undeployed can use them without an extra fund-transfer
 * step. NOT valid on hosted networks (preprod/preview).
 */
export const GENESIS_FUNDED_SEEDS = {
  alice: '0000000000000000000000000000000000000000000000000000000000000001',
  bob: '0000000000000000000000000000000000000000000000000000000000000002',
  claire: '0000000000000000000000000000000000000000000000000000000000000003',
} as const;

export type GenesisFundedSeedName = keyof typeof GENESIS_FUNDED_SEEDS;
