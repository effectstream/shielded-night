export const DECIMALS = 6;
const SCALE = 10n ** BigInt(DECIMALS);

/** Format a base-unit bigint (Stars) as a decimal NIGHT string. */
export function formatAmount(v: bigint, decimals = DECIMALS): string {
  const scale = 10n ** BigInt(decimals);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const whole = abs / scale;
  const frac = (abs % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole.toString()}${frac ? '.' + frac : ''}`;
}

/** Parse a decimal NIGHT string into base units (Stars). Throws on malformed input. */
export function parseAmount(input: string, decimals = DECIMALS): bigint {
  const s = input.trim();
  if (!/^\d*(\.\d*)?$/.test(s) || s === '' || s === '.') {
    throw new Error(`Invalid amount: "${input}"`);
  }
  const [whole, frac = ''] = s.split('.');
  if (frac.length > decimals) throw new Error(`At most ${decimals} decimal places`);
  const scale = 10n ** BigInt(decimals);
  return BigInt(whole || '0') * scale + BigInt((frac + '0'.repeat(decimals)).slice(0, decimals) || '0');
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export { SCALE };
