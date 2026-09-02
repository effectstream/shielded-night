/**
 * Optional machine-readable deploy record: `DEPLOY_OUT=<path>`.
 *
 * The deploy scripts print the new contract address for a human to paste into
 * `frontend/.env`. An automated deployment (a compose one-shot that deploys the
 * contract once per stack and hands the address to the web container) needs it
 * as DATA, and scraping stdout is fragile — the address line moves, the wallet
 * SDK logs to stdout, a retry duplicates it. With `DEPLOY_OUT` set, the same
 * run also writes:
 *
 *     {
 *       "address":    "0123…",            // hex contract address
 *       "networkId":  "undeployed",
 *       "name":       "Shielded Night",
 *       "symbol":     "sNight",
 *       "decimals":   6,
 *       "deployedAt": "2026-09-02T12:34:56.789Z",
 *       "commit":     "1502200…" | null,  // source revision that produced it
 *       "locked":     false               // true only from deploy-and-lock.ts
 *     }
 *
 * Unset (the default), nothing is written and the scripts behave exactly as
 * before.
 *
 * The file is published ATOMICALLY (write a sibling temp file, then rename), so
 * a reader polling for it never sees a half-written record.
 *
 * `commit` comes from `SHIELDED_NIGHT_COMMIT` when set — an image built from a
 * pinned SHA knows its revision but usually ships no `.git` — else from `git
 * rev-parse HEAD`, else null. It is provenance, never trusted as an identity:
 * verify the deployment with `scripts/verify-deployment.ts`.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(new URL(import.meta.url).pathname, '..', '..');

export interface DeployRecord {
  readonly address: string;
  readonly networkId: string;
  readonly name: string;
  readonly symbol: string;
  readonly decimals: number;
  readonly deployedAt: string;
  readonly commit: string | null;
  readonly locked: boolean;
}

/** The source revision this deploy came from: env first (images have no .git), then git, else null. */
export const resolveCommit = (): string | null => {
  const fromEnv = process.env.SHIELDED_NIGHT_COMMIT?.trim();
  if (fromEnv) return fromEnv;
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return sha.length > 0 ? sha : null;
  } catch {
    return null;
  }
};

export interface DeployRecordInput {
  readonly address: string;
  readonly networkId: string;
  readonly name: string;
  readonly symbol: string;
  readonly decimals: bigint | number;
  readonly locked?: boolean;
}

/**
 * Write the deploy record if `DEPLOY_OUT` is set; return the path written, or
 * undefined when the knob is unset. Never throws away the deploy: a write
 * failure is reported by throwing AFTER the contract exists on chain, so the
 * caller's address line is already on stdout.
 */
export const writeDeployRecord = (input: DeployRecordInput): string | undefined => {
  const target = process.env.DEPLOY_OUT?.trim();
  if (!target || target.length === 0) return undefined;

  const record: DeployRecord = {
    address: input.address,
    networkId: input.networkId,
    name: input.name,
    symbol: input.symbol,
    decimals: Number(input.decimals),
    deployedAt: new Date().toISOString(),
    commit: resolveCommit(),
    locked: input.locked ?? false,
  };

  const outPath = path.resolve(target);
  mkdirSync(path.dirname(outPath), { recursive: true });
  const tmpPath = `${outPath}.tmp.${process.pid}`;
  try {
    writeFileSync(tmpPath, `${JSON.stringify(record, null, 2)}\n`, 'utf-8');
    renameSync(tmpPath, outPath);
  } catch (e) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // best effort: the temp file may never have been created
    }
    throw e;
  }
  return outPath;
};
