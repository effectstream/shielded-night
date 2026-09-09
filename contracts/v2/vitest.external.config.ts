import { defineConfig } from 'vitest/config';

/**
 * The 2.x round-trip suite. Needs a running `undeployed` (or `stagenet`) stack
 * and refuses to start without `MN_EXTERNAL_STACK` — see
 * `test/external/global-setup.ts`.
 *
 * Retries default to 0, unlike the 1.x integration config: every case here
 * asserts EXACT balances, and a retry of a half-completed round trip would
 * assert against balances the first attempt already moved. Set MN_TEST_RETRY
 * only when chasing a transport flake.
 */
export default defineConfig({
  test: {
    include: ['test/external/**/*.external.test.ts'],
    globalSetup: ['./test/external/global-setup.ts'],
    testTimeout: 10 * 60_000,
    hookTimeout: 20 * 60_000,
    retry: Number(process.env.MN_TEST_RETRY ?? 0),
    // One chain, one wallet: run files serially in forked workers.
    pool: 'forks',
    fileParallelism: false,
    reporters: [
      'default',
      ...(process.env.GITHUB_ACTIONS === 'true' ? (['github-actions'] as const) : []),
    ],
  },
});
