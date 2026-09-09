import { configDefaults, defineConfig } from 'vitest/config';

/**
 * The v2 unit tier: no chain, no docker, no network. `test/external/**` is the
 * opt-in round-trip suite against a running 2.x stack and is excluded here by
 * both the include pattern and the exclude list, so `npm run test:unit` (and
 * the repo's `bun run test:v2`, and CI's `unit-v2` job) can never collect it.
 * Run that suite with `npm run test:external` / `bun run test:v2:external`.
 */
export default defineConfig({
  test: {
    include: ['test/**/*.unit.test.ts'],
    exclude: [...configDefaults.exclude, 'test/external/**'],
    reporters: [
      'default',
      ...(process.env.GITHUB_ACTIONS === 'true' ? (['github-actions'] as const) : []),
    ],
  },
});
