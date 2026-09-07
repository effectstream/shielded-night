import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Load one explicitly selected wallet environment file without printing it.
 * Existing shell/repo-root MN_MNEMONIC or MN_SEED values keep precedence.
 * Wallet CLI files use WALLET_SEED; deployment scripts use MN_SEED.
 */
export function loadWalletEnvFile(): void {
  const configured = process.env.MN_WALLET_ENV_FILE?.trim();
  if (!configured) return;
  const entries = new Map<string, string>();
  for (const rawLine of readFileSync(path.resolve(configured), 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (value) entries.set(key, value);
  }
  if (!process.env.MN_MNEMONIC && entries.has('MN_MNEMONIC')) {
    process.env.MN_MNEMONIC = entries.get('MN_MNEMONIC');
  }
  if (!process.env.MN_SEED) {
    process.env.MN_SEED = entries.get('MN_SEED') ?? entries.get('WALLET_SEED');
  }
}
