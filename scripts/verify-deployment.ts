/**
 * Verify a deployed ShieldedNight contract against THIS repo, read-only (no
 * wallet, no seed — it only queries the public indexer). Two checks:
 *
 *  1. CODE — every circuit's on-chain verifier key is byte-identical to the
 *     committed build in src/managed/keys/*.verifier, and the operation sets
 *     match exactly (nothing missing, nothing extra). Combined with the
 *     byte-exact recompile documented in README ("Verifying the deployment"),
 *     this proves the deployed rules are compiled from this source tree.
 *
 *  2. LOCK — the contract maintenance authority is an empty committee with a
 *     positive threshold. No signature set can satisfy `committee < threshold`
 *     when the committee is empty, so no rule can ever be changed: the
 *     contract is permanently immutable.
 *
 * Usage:
 *   MN_ENV=preview CV_ADDRESS=<hex-address> bun run scripts/verify-deployment.ts
 *
 * Exit code 0 only if BOTH checks pass.
 */
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { setNetworkId } from '@midnight-ntwrk/midnight-js/network-id';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { isEnvName, networkFor, type EnvName } from '../test/support/network.js';

const KEYS_DIR = path.resolve(new URL(import.meta.url).pathname, '..', '..', 'src', 'managed', 'keys');

const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const short = (h: string): string => `${h.slice(0, 8)}…${h.slice(-8)}`;
const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);

async function main() {
  const rawEnv = process.env.MN_ENV ?? 'preview';
  if (!isEnvName(rawEnv)) throw new Error(`Invalid MN_ENV "${rawEnv}"`);
  const env: EnvName = rawEnv;
  const address = process.env.CV_ADDRESS?.trim();
  if (!address) throw new Error('Set CV_ADDRESS to the deployed contract address (hex).');

  const network = networkFor(env);
  setNetworkId(network.networkId);
  console.log(`[verify] env=${env} indexer=${network.indexer}`);
  console.log(`[verify] contract ${address}\n`);

  const publicData = indexerPublicDataProvider(network.indexer, network.indexerWS);
  const state = await publicData.queryContractState(address);
  if (state == null) throw new Error(`no contract state on chain for ${address}`);

  // --- Check 1: on-chain verifier keys == committed src/managed build -------
  const localOps = readdirSync(KEYS_DIR)
    .filter((f) => f.endsWith('.verifier'))
    .map((f) => f.replace(/\.verifier$/, ''))
    .sort();
  const chainOps = state
    .operations()
    .map((o) => (typeof o === 'string' ? o : Buffer.from(o).toString()))
    .sort();

  let codeOk = true;
  const missing = localOps.filter((o) => !chainOps.includes(o));
  const extra = chainOps.filter((o) => !localOps.includes(o));
  if (missing.length > 0) {
    codeOk = false;
    console.log(`✗ circuits missing on chain: ${missing.join(', ')}`);
  }
  if (extra.length > 0) {
    codeOk = false;
    console.log(`✗ circuits on chain but not in this build: ${extra.join(', ')}`);
  }

  for (const op of localOps.filter((o) => chainOps.includes(o))) {
    const local = new Uint8Array(readFileSync(path.join(KEYS_DIR, `${op}.verifier`)));
    const chainKey = state.operation(op)?.verifierKey;
    if (chainKey == null) {
      codeOk = false;
      console.log(`✗ ${op}: no verifier key readable on chain`);
      continue;
    }
    const match = bytesEqual(local, chainKey);
    if (!match) codeOk = false;
    console.log(
      `${match ? '✓' : '✗'} ${op}: on-chain ${short(sha256(chainKey))} ` +
        `${match ? '==' : '!='} local ${short(sha256(local))}`,
    );
  }

  // --- Check 2: maintenance authority dissolved (immutable) -----------------
  const cma = state.maintenanceAuthority;
  const committee = cma.committee.length;
  const threshold = cma.threshold;
  const locked = committee === 0 && threshold >= 1;
  console.log(`\nmaintenance authority: committee=${committee} threshold=${threshold} counter=${cma.counter}`);
  console.log(
    locked
      ? '✓ LOCKED: empty committee with positive threshold - no maintenance update can ever be authorized.'
      : `✗ NOT locked: ${committee} committee member(s) can still change the contract (threshold ${threshold}).`,
  );

  console.log(
    codeOk && locked
      ? '\n✅ verified: deployed code matches this repo byte-for-byte AND the contract is immutable.'
      : '\n❌ verification FAILED (see above).',
  );
  process.exit(codeOk && locked ? 0 : 1);
}

main().catch((e) => {
  console.error('[verify] failed:', e instanceof Error ? (e.stack ?? e.message) : e);
  process.exit(1);
});
