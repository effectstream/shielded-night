/**
 * Load the repo-root `.env` (gitignored - SECRETS live there: MN_MNEMONIC /
 * MN_SEED) into process.env. Side-effect import at the top of any script that
 * needs deploy credentials:
 *
 *   import './load-env.js';
 *
 * Values already present in the shell environment take precedence, so
 * `MN_MNEMONIC="..." bun run scripts/deploy.ts` still works and overrides the
 * file. Minimal parser: KEY=VALUE lines, `#` comments, optional single/double
 * quotes around the value. No dependency, no expansion.
 *
 * NOT to be confused with frontend/.env, which is committed and holds only
 * public contract addresses.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT_ENV = path.resolve(new URL(import.meta.url).pathname, '..', '..', '.env');

if (existsSync(ROOT_ENV)) {
  for (const rawLine of readFileSync(ROOT_ENV, 'utf-8').split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined && value !== '') {
      process.env[key] = value;
    }
  }
}
