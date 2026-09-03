import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { startProofServerOnly, startUndeployedStack } from '../support/local-stack.js';
import {
  ENV_NAMES,
  isEnvName,
  NETWORK_URL_ENV_VARS,
  networkFor,
  type EnvName,
  type NetworkConfig,
} from '../support/network.js';

/**
 * `MN_EXTERNAL_STACK=1` — run against an ALREADY-RUNNING stack instead of
 * booting one with testcontainers.
 *
 * The default (unset) behaviour is unchanged and stays what CI runs: the suite
 * owns its stack, so a green run proves the contract against a known-clean
 * devnet. External mode exists for the other direction — proving the SAME suite
 * against a stack somebody else brought up (a compose deployment of this dApp,
 * a devnet on non-default ports, a stack this process cannot start because it
 * has no docker socket). Point it at that stack with the endpoint overrides:
 *
 *     MN_EXTERNAL_STACK=1 MN_ENV=undeployed \
 *       MN_INDEXER_URL=http://indexer:8088/api/v4/graphql \
 *       MN_INDEXER_WS_URL=ws://indexer:8088/api/v4/graphql/ws \
 *       MN_NODE_URL=http://node:9944 \
 *       MN_PROOF_SERVER_URL=http://proof-server:6300 \
 *       bun run test:integration
 *
 * `MN_SEED` stays optional on `undeployed` (the genesis seed is the default), so
 * a stack whose genesis funds the usual seeds needs nothing else; set `MN_SEED`
 * when that seed belongs to another facade on the target stack.
 *
 * NOTE the suite is written for a devnet it may treat as its own: it deploys
 * contracts and spends from the genesis-funded seeds. Point it only at a
 * throwaway stack.
 */
const EXTERNAL_STACK_TRUTHY = ['1', 'true', 'yes', 'on'];
const useExternalStack = (): boolean =>
  EXTERNAL_STACK_TRUTHY.includes((process.env.MN_EXTERNAL_STACK ?? '').trim().toLowerCase());

/**
 * Any HTTP answer — including 400/404/405 — proves the endpoint is listening;
 * only a transport error (nothing there, DNS miss, refused) is a miss. Fails
 * fast with the URL that is wrong instead of a wallet sync that times out ten
 * minutes later inside a test.
 */
const unreachable = async (url: string): Promise<string | undefined> => {
  try {
    await fetch(url, { signal: AbortSignal.timeout(10_000) });
    return undefined;
  } catch (e) {
    return `${url} (${e instanceof Error ? e.message : String(e)})`;
  }
};

/** Preflight the external stack's endpoints; the WS URL is covered by its HTTP sibling. */
const assertExternalStackReachable = async (network: NetworkConfig): Promise<void> => {
  const probes: ReadonlyArray<readonly [label: string, url: string]> = [
    ['indexer', network.indexer],
    ['node', network.node],
    ['proof server', network.proofServer],
  ];
  const misses = (
    await Promise.all(probes.map(async ([label, url]) => ({ label, miss: await unreachable(url) })))
  ).filter((r) => r.miss !== undefined);
  if (misses.length > 0) {
    throw new Error(
      `MN_EXTERNAL_STACK=1 but ${misses.length} endpoint(s) are unreachable:\n` +
        misses.map((m) => `  - ${m.label}: ${m.miss}`).join('\n') +
        `\nStart the stack, or point the suite at it with ` +
        `${Object.values(NETWORK_URL_ENV_VARS).join(' / ')}.`,
    );
  }
};

export default async function setup(): Promise<() => Promise<void>> {
  const raw = process.env.MN_ENV ?? 'undeployed';
  if (!isEnvName(raw)) throw new Error(`Invalid MN_ENV "${raw}". Use ${ENV_NAMES.join(' | ')}.`);
  const env: EnvName = raw;

  // Load .env.<env> like the CLI does (cli/src/index.ts) so `yarn smoke` against
  // a hosted env picks up MN_SEED without it being exported. loadEnvFile does NOT
  // override vars already in the environment, so an inline/exported MN_SEED wins.
  const envFile = resolve(process.cwd(), `.env.${env}`);
  if (env !== 'undeployed' && existsSync(envFile)) process.loadEnvFile(envFile);

  if (env !== 'undeployed' && !process.env.MN_SEED) {
    throw new Error(`MN_SEED is required for MN_ENV=${env}.`);
  }

  // Endpoint overrides (MN_INDEXER_URL etc.) are applied here, so the external
  // stack's URLs — and a hosted run's own proof server — come from one place.
  const base = networkFor(env);
  const external = useExternalStack();
  let stop: () => Promise<void>;
  let network: NetworkConfig;

  if (external) {
    console.log(`[vitest] MN_EXTERNAL_STACK=1: using the running ${env} stack (no testcontainers)`);
    network = base;
    await assertExternalStackReachable(network);
    // Nothing was started here, so nothing is torn down: never stop a stack we
    // do not own.
    stop = async () => undefined;
  } else if (env === 'undeployed') {
    console.log('[vitest] starting undeployed stack (proof + indexer + node)…');
    const stack = await startUndeployedStack();
    network = {
      ...base,
      proofServer: stack.proofServer,
      node: stack.node,
      indexer: stack.indexer,
      indexerWS: stack.indexerWS,
    };
    stop = stack.stop;
  } else {
    console.log(`[vitest] starting local proof-server for ${env}…`);
    const ps = await startProofServerOnly();
    network = { ...base, proofServer: ps.proofServer };
    stop = ps.stop;
  }

  console.log(`[vitest] network ready: proof=${network.proofServer} indexer=${network.indexer}`);

  process.env.__MN_ENV__ = env;
  process.env.__MN_CFG__ = JSON.stringify(network);

  return async () => {
    if (external) {
      console.log('[vitest] external stack: leaving it running');
      return;
    }
    console.log('[vitest] tearing down stack…');
    await stop().catch((e) => console.warn('[vitest] stop failed:', e));
  };
}
