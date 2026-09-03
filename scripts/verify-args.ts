/**
 * Argument parsing and exit-code policy for `scripts/verify-deployment.ts`.
 *
 * Extracted so the policy is unit-testable without a chain: deciding what the
 * verifier exits with is the whole contract of that script, and both demo
 * stacks (midnight-1-offers, midnight-2-offers) read that exit code from a
 * compose one-shot rather than parsing its stdout.
 *
 * The verifier makes two independent checks:
 *
 *   CODE — every on-chain verifier key is byte-identical to the committed
 *          build, and the operation sets match exactly.
 *   LOCK — the maintenance authority is dissolved, so no rule can ever change.
 *
 * By default BOTH must hold, which is right for a hosted release. It is wrong
 * for a devnet: a demo stack deliberately leaves the contract unlocked
 * (`SHIELDED_NIGHT_LOCK=false`), because locking is a one-way door and a
 * throwaway contract gains nothing from it. `--allow-unlocked` is for exactly
 * that case: the lock state is still measured and printed, but only the CODE
 * check decides the exit code.
 *
 *   bun run verify:deployment -- --allow-unlocked
 *
 * It never weakens the CODE check: a key mismatch, a missing circuit or an
 * extra circuit still exits 1 with or without the flag.
 */

/** The one supported flag. */
export const ALLOW_UNLOCKED_FLAG = '--allow-unlocked';

export interface VerifyOptions {
  /** Report the lock state instead of failing on it. Default false = today's behaviour. */
  readonly allowUnlocked: boolean;
}

/**
 * Parse the verifier's argv tail (`process.argv.slice(2)`).
 *
 * Unknown arguments are rejected rather than ignored: a typo such as
 * `--allow-unlock` would otherwise silently keep the strict behaviour and be
 * read as "the flag does not work".
 */
export const parseVerifyArgs = (argv: readonly string[]): VerifyOptions => {
  let allowUnlocked = false;
  for (const arg of argv) {
    if (arg === ALLOW_UNLOCKED_FLAG) {
      allowUnlocked = true;
      continue;
    }
    throw new Error(
      `Unknown argument "${arg}". The only supported flag is ${ALLOW_UNLOCKED_FLAG} ` +
        `(usage: MN_ENV=<env> CV_ADDRESS=<hex> bun run verify:deployment -- ${ALLOW_UNLOCKED_FLAG}).`,
    );
  }
  return { allowUnlocked };
};

export interface VerifyChecks {
  /** Every on-chain verifier key matched, and the operation sets were equal. */
  readonly codeOk: boolean;
  /** The maintenance authority is dissolved (empty committee, positive threshold). */
  readonly locked: boolean;
  readonly allowUnlocked: boolean;
}

export interface VerifyOutcome {
  readonly ok: boolean;
  readonly exitCode: 0 | 1;
  readonly summary: string;
}

/**
 * The exit-code policy.
 *
 * Default            : exit 0 iff CODE and LOCK both pass.
 * With --allow-unlocked: exit 0 iff CODE passes; LOCK is informational.
 *
 * CODE is never optional under either mode.
 */
export const verifyOutcome = ({ codeOk, locked, allowUnlocked }: VerifyChecks): VerifyOutcome => {
  const ok = allowUnlocked ? codeOk : codeOk && locked;
  let summary: string;
  if (!ok) {
    summary = '\n❌ verification FAILED (see above).';
  } else if (locked) {
    summary = '\n✅ verified: deployed code matches this repo byte-for-byte AND the contract is immutable.';
  } else {
    summary =
      '\n✅ verified: deployed code matches this repo byte-for-byte. ' +
      `Lock state REPORTED ONLY (${ALLOW_UNLOCKED_FLAG}): this contract is NOT immutable.`;
  }
  return { ok, exitCode: ok ? 0 : 1, summary };
};

/**
 * The maintenance-authority verdict line. Unlocked is an error (`✗`) by
 * default and informational (`ℹ`) under the flag; locked reads the same either
 * way, since nothing is being relaxed.
 */
export const lockVerdictLine = ({
  locked,
  committee,
  threshold,
  allowUnlocked,
}: {
  readonly locked: boolean;
  readonly committee: number;
  readonly threshold: number | bigint;
  readonly allowUnlocked: boolean;
}): string => {
  if (locked) {
    return '✓ LOCKED: empty committee with positive threshold - no maintenance update can ever be authorized.';
  }
  const detail = `${committee} committee member(s) can still change the contract (threshold ${threshold}).`;
  return allowUnlocked
    ? `ℹ NOT locked: ${detail} Reported only, not failed: ${ALLOW_UNLOCKED_FLAG} was passed.`
    : `✗ NOT locked: ${detail}`;
};
