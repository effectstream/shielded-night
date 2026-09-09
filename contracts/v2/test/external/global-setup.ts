import { isV2EnvName, profileFor, V2_ENV_NAMES, type V2EnvName, type V2Profile } from '../../scripts/profile.js';

/**
 * Global setup for the 2.x external-stack suite.
 *
 * Unlike the 1.x integration suite, this one NEVER starts a stack: there is no
 * testcontainers path and no compose file in this tree (project 00008, Q2). It
 * only ever joins a chain somebody else is running, so `MN_EXTERNAL_STACK` is
 * mandatory and the setup refuses without it. Nothing is ever torn down.
 *
 *     MN_EXTERNAL_STACK=1 MN_ENV=undeployed \
 *       MN_INDEXER_URL=http://127.0.0.1:8088/api/v4/graphql \
 *       MN_INDEXER_WS_URL=ws://127.0.0.1:8088/api/v4/graphql/ws \
 *       MN_NODE_URL=http://127.0.0.1:9944 \
 *       MN_NODE_WS_URL=ws://127.0.0.1:9944 \
 *       MN_PROOF_SERVER_URL=http://127.0.0.1:6300 \
 *       MN_SEED=<funded devnet seed> \
 *       npm --prefix contracts/v2 run test:external
 *
 * The suite deploys contracts and spends from the seed it is given: point it
 * only at a throwaway devnet.
 */
export const EXTERNAL_STACK_ENV_VAR = 'MN_EXTERNAL_STACK';
const EXTERNAL_STACK_TRUTHY = ['1', 'true', 'yes', 'on'];

/** Env keys the setup hands to the (forked) test workers. */
export const RESOLVED_ENV_VAR = '__MN_V2_ENV__';
export const RESOLVED_PROFILE_VAR = '__MN_V2_CFG__';

const useExternalStack = (): boolean =>
  EXTERNAL_STACK_TRUTHY.includes((process.env[EXTERNAL_STACK_ENV_VAR] ?? '').trim().toLowerCase());

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
  } catch (error) {
    return `${url} (${error instanceof Error ? error.message : String(error)})`;
  }
};

/** Preflight the stack's endpoints; each WS URL is covered by its HTTP sibling. */
const assertStackReachable = async (profile: V2Profile): Promise<void> => {
  const probes: ReadonlyArray<readonly [label: string, url: string]> = [
    ['indexer', profile.indexer],
    ['node', profile.node],
    ['proof server', profile.proofServer],
  ];
  const misses = (
    await Promise.all(probes.map(async ([label, url]) => ({ label, miss: await unreachable(url) })))
  ).filter((probe) => probe.miss !== undefined);
  if (misses.length > 0) {
    throw new Error(
      `${EXTERNAL_STACK_ENV_VAR} is set but ${misses.length} endpoint(s) are unreachable:\n` +
        misses.map((probe) => `  - ${probe.label}: ${probe.miss}`).join('\n') +
        '\nStart the stack, or point the suite at it with ' +
        'MN_INDEXER_URL / MN_INDEXER_WS_URL / MN_NODE_URL / MN_NODE_WS_URL / MN_PROOF_SERVER_URL.',
    );
  }
};

export default async function setup(): Promise<() => Promise<void>> {
  if (!useExternalStack()) {
    throw new Error(
      `The 2.x round-trip suite only runs against a stack you already started. ` +
        `Set ${EXTERNAL_STACK_ENV_VAR}=1 (accepted: ${EXTERNAL_STACK_TRUTHY.join(' | ')}) and point it at that stack ` +
        'with MN_INDEXER_URL / MN_INDEXER_WS_URL / MN_NODE_URL / MN_NODE_WS_URL / MN_PROOF_SERVER_URL. ' +
        'This suite never starts or stops a stack.',
    );
  }

  // The suite is written for a throwaway devnet, so `undeployed` is the default
  // here even though the deploy/verify scripts default to `stagenet`.
  const requested = process.env.MN_ENV?.trim() || 'undeployed';
  if (!isV2EnvName(requested)) {
    throw new Error(`Invalid MN_ENV "${requested}". The v2 commands support ${V2_ENV_NAMES.join(' | ')}.`);
  }
  const env: V2EnvName = requested;
  if (env !== 'undeployed' && !process.env.MN_SEED?.trim()) {
    throw new Error(`MN_SEED is required for MN_ENV=${env}: there is no genesis-funded seed outside a local devnet.`);
  }

  const profile = profileFor(env);
  console.log(
    `[vitest] ${EXTERNAL_STACK_ENV_VAR}: joining the running ${env} stack ` +
      `(node=${profile.node} indexer=${profile.indexer} proof=${profile.proofServer})`,
  );
  await assertStackReachable(profile);

  process.env[RESOLVED_ENV_VAR] = env;
  process.env[RESOLVED_PROFILE_VAR] = JSON.stringify(profile);

  return async () => {
    // Nothing was started here, so nothing is torn down: never stop a stack we
    // do not own.
    console.log('[vitest] external stack: leaving it running');
  };
}
