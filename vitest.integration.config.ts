import { configDefaults, defineConfig } from 'vitest/config';

const env = process.env.MN_ENV ?? 'undeployed';
const isHosted = env !== 'undeployed';
// Up to 3 attempts by default: transient wallet-sync / DUST-funding races are
// a known flaky tail on a freshly booted local stack.
const retry = Number(process.env.MN_TEST_RETRY ?? 2);

export default defineConfig({
  test: {
    include: ['test/integration/**/*.test.ts'],
    exclude: [...configDefaults.exclude, '**/*.unit.test.ts'],
    globalSetup: ['./test/integration/global-setup.ts'],
    testTimeout: isHosted ? 10 * 60_000 : 5 * 60_000,
    hookTimeout: isHosted ? 20 * 60_000 : 10 * 60_000,
    retry,
    // The docker stack is single-client: run files serially in forked workers.
    pool: 'forks',
    fileParallelism: false,
    reporters: [
      'default',
      ['json', { outputFile: 'reports/vitest-results.json' }],
      ...(process.env.GITHUB_ACTIONS === 'true' ? (['github-actions'] as const) : []),
    ],
    server: {
      deps: {
        // graphql@17's package.json `exports` map lists Bun's own "bun"
        // condition before "require" in every branch, both pointing at an
        // ESM-only .mjs. Bun always activates its "bun" condition, so any
        // resolution of the bare specifier `graphql` — including
        // graphql-tag's plain CJS `require('graphql')` — lands on the async
        // ESM file, and Bun refuses to require() an async ES module.
        //
        // The chain is test/support/provider-wiring.ts ->
        // @midnight-ntwrk/midnight-js-indexer-public-data-provider@5.0.0-beta.7
        // -> graphql-tag -> graphql. Only reachable via MN_EXTERNAL_STACK=1
        // (the normal testcontainers path never imports provider-wiring.ts
        // through this loader in a way that triggers it — see below); plain
        // `bun run` of the same chain (e.g. scripts/verify-deployment.ts) is
        // unaffected because it never goes through vitest's SSR module
        // runner at all.
        //
        // `graphql`/`graphql-tag`/`@apollo/client` alone are NOT enough:
        // vitest's `pool: 'forks'` loads an externalized (non-inlined)
        // module wholesale via a plain runtime `import()`/`require()`, and
        // from that point on ALL of that module's own internal requires are
        // native Bun requires with zero further Vite involvement — so
        // inlining only the leaf graphql packages does nothing while
        // `midnight-js-indexer-public-data-provider` itself stays
        // externalized (its own `require('graphql-tag')` still resolves
        // natively). Inlining the indexer provider TOO routes its module
        // graph through Vite's SSR transform, which resolves the nested
        // `graphql`/`graphql-tag` specifiers itself (SSR resolution defaults
        // to node-oriented conditions, not Bun's) instead of leaving a raw
        // externalized require() for Bun to resolve on its own. Measured:
        // with only the three leaf packages inlined, all 6 integration
        // files still crash at import under MN_EXTERNAL_STACK=1; adding the
        // indexer provider makes all 6 collect cleanly (17 tests).
        inline: [
          'graphql',
          'graphql-tag',
          '@apollo/client',
          '@midnight-ntwrk/midnight-js-indexer-public-data-provider',
        ],
      },
    },
  },
});
