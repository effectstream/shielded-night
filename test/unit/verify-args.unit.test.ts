/**
 * `--allow-unlocked` (scripts/verify-args.ts).
 *
 * The verifier's exit code is a gate both demo stacks read from a compose
 * one-shot, so the two things pinned here are that the DEFAULT is unchanged
 * (an unlocked contract still fails) and that the flag relaxes ONLY the lock
 * check — a verifier-key mismatch, a missing circuit or an extra circuit must
 * still exit 1 with the flag set.
 */
import { describe, expect, it } from 'vitest';
import {
  ALLOW_UNLOCKED_FLAG,
  lockVerdictLine,
  parseVerifyArgs,
  verifyOutcome,
} from '../../scripts/verify-args.js';

describe('parseVerifyArgs', () => {
  it('defaults to the strict behaviour when no arguments are given', () => {
    expect(parseVerifyArgs([])).toEqual({ allowUnlocked: false });
  });

  it('accepts --allow-unlocked', () => {
    expect(parseVerifyArgs(['--allow-unlocked'])).toEqual({ allowUnlocked: true });
    expect(ALLOW_UNLOCKED_FLAG).toBe('--allow-unlocked');
  });

  it('is idempotent when the flag is repeated', () => {
    expect(parseVerifyArgs(['--allow-unlocked', '--allow-unlocked'])).toEqual({ allowUnlocked: true });
  });

  it('rejects an unknown argument instead of silently ignoring it', () => {
    // A typo must not read as "the flag does not work": it would silently keep
    // the strict behaviour and fail a healthy devnet contract.
    expect(() => parseVerifyArgs(['--allow-unlock'])).toThrow(/Unknown argument "--allow-unlock"/);
    expect(() => parseVerifyArgs(['--allow-unlocked=true'])).toThrow(/Unknown argument/);
    expect(() => parseVerifyArgs(['allow-unlocked'])).toThrow(/Unknown argument/);
  });

  it('names the supported flag in the rejection message', () => {
    expect(() => parseVerifyArgs(['--nope'])).toThrow(/--allow-unlocked/);
  });
});

describe('verifyOutcome — default (strict) behaviour is unchanged', () => {
  it('passes only when the code matches AND the contract is locked', () => {
    const o = verifyOutcome({ codeOk: true, locked: true, allowUnlocked: false });
    expect(o).toMatchObject({ ok: true, exitCode: 0 });
    expect(o.summary).toContain('immutable');
  });

  it('FAILS an unlocked contract even when every key matches', () => {
    const o = verifyOutcome({ codeOk: true, locked: false, allowUnlocked: false });
    expect(o).toMatchObject({ ok: false, exitCode: 1 });
    expect(o.summary).toContain('FAILED');
  });

  it('fails a key mismatch on a locked contract', () => {
    expect(verifyOutcome({ codeOk: false, locked: true, allowUnlocked: false })).toMatchObject({
      ok: false,
      exitCode: 1,
    });
  });

  it('fails when both checks fail', () => {
    expect(verifyOutcome({ codeOk: false, locked: false, allowUnlocked: false })).toMatchObject({
      ok: false,
      exitCode: 1,
    });
  });
});

describe('verifyOutcome — with --allow-unlocked the exit code reflects ONLY the key check', () => {
  it('passes an unlocked contract whose keys all match', () => {
    const o = verifyOutcome({ codeOk: true, locked: false, allowUnlocked: true });
    expect(o).toMatchObject({ ok: true, exitCode: 0 });
    expect(o.summary).toContain('REPORTED ONLY');
    expect(o.summary).toContain('NOT immutable');
  });

  it('still passes a locked contract, with the unchanged success line', () => {
    const o = verifyOutcome({ codeOk: true, locked: true, allowUnlocked: true });
    expect(o).toMatchObject({ ok: true, exitCode: 0 });
    expect(o.summary).toContain('immutable');
    expect(o.summary).not.toContain('REPORTED ONLY');
  });

  it('STILL FAILS a verifier-key mismatch (the flag never weakens the code check)', () => {
    expect(verifyOutcome({ codeOk: false, locked: false, allowUnlocked: true })).toMatchObject({
      ok: false,
      exitCode: 1,
    });
    expect(verifyOutcome({ codeOk: false, locked: true, allowUnlocked: true })).toMatchObject({
      ok: false,
      exitCode: 1,
    });
  });

  it('exit code equals the code check exactly, for every lock state', () => {
    for (const locked of [true, false]) {
      for (const codeOk of [true, false]) {
        const { exitCode } = verifyOutcome({ codeOk, locked, allowUnlocked: true });
        expect(exitCode).toBe(codeOk ? 0 : 1);
      }
    }
  });
});

describe('lockVerdictLine', () => {
  it('marks an unlocked contract as an error by default', () => {
    const line = lockVerdictLine({ locked: false, committee: 1, threshold: 1, allowUnlocked: false });
    expect(line.startsWith('✗')).toBe(true);
    expect(line).toContain('1 committee member(s)');
  });

  it('marks an unlocked contract as informational under the flag', () => {
    const line = lockVerdictLine({ locked: false, committee: 1, threshold: 1, allowUnlocked: true });
    expect(line.startsWith('ℹ')).toBe(true);
    expect(line).toContain('Reported only');
    expect(line).toContain(ALLOW_UNLOCKED_FLAG);
  });

  it('reads the same for a locked contract either way', () => {
    const strict = lockVerdictLine({ locked: true, committee: 0, threshold: 1, allowUnlocked: false });
    const relaxed = lockVerdictLine({ locked: true, committee: 0, threshold: 1, allowUnlocked: true });
    expect(strict).toBe(relaxed);
    expect(strict.startsWith('✓ LOCKED')).toBe(true);
  });

  it('accepts a bigint threshold as the ledger reports it', () => {
    const line = lockVerdictLine({ locked: false, committee: 2, threshold: 2n, allowUnlocked: false });
    expect(line).toContain('threshold 2');
  });
});
