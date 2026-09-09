/**
 * Supported networks. `networkId` is the string hinted to the wallet's
 * `connect(networkId)` and also fed to midnight-js `setNetworkId`. The contract
 * address is read from one env var per network (`<NETWORK>_ADDRESS`, exposed
 * via vite.config's `envPrefix`), so the same build works across networks, and
 * may be overridden at RUNTIME by `window.SHIELDED_NIGHT.<NETWORK>_ADDRESS`
 * (see runtime-config.ts) for deployments that deploy their own contract after
 * the bundle was built. The wrapper (sNight) token type is always derived from
 * the address.
 *
 * The three public networks are pinned to the ledger generation their chain
 * runs. `undeployed` is not a chain but whichever devnet is on the other end,
 * so its protocol family is a SETTING (`UNDEPLOYED_PROTOCOL`, build-time env or
 * runtime config, default `midnight-1.x`) resolved by `resolveNetwork()`.
 */
/// <reference types="vite/client" />
import {
  DEFAULT_UNDEPLOYED_PROTOCOL,
  resolveContractAddress,
  resolveUndeployedProtocol,
  type ContractAddressVar,
  type ProtocolFamilyName,
} from './runtime-config.js';

export interface NetworkOption {
  key: 'preview' | 'preprod' | 'stagenet' | 'undeployed';
  label: string;
  networkId: string;
  protocolFamily: ProtocolFamilyName;
}

/**
 * The static rows. `undeployed.protocolFamily` here is the BUILD DEFAULT, not
 * the resolved one: read a row through `resolveNetwork()` (or
 * `configuredNetworks()`) wherever the setting must be honoured. This array is
 * never mutated — a resolved row is a fresh object.
 */
export const NETWORKS: NetworkOption[] = [
  { key: 'preview', label: 'Preview', networkId: 'preview', protocolFamily: 'midnight-1.x' },
  { key: 'preprod', label: 'Preprod', networkId: 'preprod', protocolFamily: 'midnight-1.x' },
  { key: 'stagenet', label: 'Stagenet', networkId: 'stagenet', protocolFamily: 'midnight-2.x' },
  { key: 'undeployed', label: 'Local (undeployed)', networkId: 'undeployed', protocolFamily: 'midnight-1.x' },
];

/** The local row's label per resolved generation (the selector shows which one is live). */
const UNDEPLOYED_LABEL: Record<ProtocolFamilyName, string> = {
  'midnight-1.x': 'Local (undeployed)',
  'midnight-2.x': 'Local (undeployed · 2.x)',
};

/**
 * Build-time protocol switch, baked from the env at `vite build` (envPrefix
 * `UNDEPLOYED_`). Read per CALL, like the addresses, so a runtime config that
 * lands after module evaluation still wins.
 */
const buildTimeUndeployedProtocol = (): string | undefined => import.meta.env.UNDEPLOYED_PROTOCOL;

/**
 * The `undeployed` row's ledger generation, or the error explaining a rejected
 * `UNDEPLOYED_PROTOCOL` value. Only `undeployed` has a switch; the public rows
 * always resolve clean.
 */
const undeployedProtocol = () => resolveUndeployedProtocol(buildTimeUndeployedProtocol());

/**
 * A network row with the settings applied: for `undeployed` that is the
 * resolved protocol family and its label, for every other key the static row.
 * On an invalid `UNDEPLOYED_PROTOCOL` the row falls back to the default family
 * for display only — `contractConfigurationError()` reports the bad value and
 * blocks connecting, so no adapter is ever chosen from a guess.
 */
export const resolveNetwork = (key: NetworkOption['key']): NetworkOption => {
  const base = NETWORKS.find((network) => network.key === key)!;
  if (key !== 'undeployed') return base;
  const family = undeployedProtocol().family ?? DEFAULT_UNDEPLOYED_PROTOCOL;
  return { ...base, protocolFamily: family, label: UNDEPLOYED_LABEL[family] };
};

/** The `UNDEPLOYED_PROTOCOL` error for this network, if it has one (only `undeployed` can). */
export const protocolConfigurationError = (key: NetworkOption['key']): string | undefined =>
  key === 'undeployed' ? undeployedProtocol().error : undefined;

/**
 * A hint for the failure the protocol switch causes: the wallet's ledger
 * generation is not observable before connecting, so a 1.x wallet on a
 * `midnight-2.x` local network (or the reverse) only fails when the adapter
 * runs. The caller logs this next to that failure — it is a message, never a
 * gate.
 */
export const protocolMismatchHint = (key: NetworkOption['key']): string | undefined => {
  if (key !== 'undeployed') return undefined;
  const network = resolveNetwork(key);
  return network.protocolFamily === 'midnight-2.x'
    ? `${network.label} is configured for midnight-2.x (UNDEPLOYED_PROTOCOL); a Midnight 1.x wallet or a ledger-v8 devnet cannot serve it — connect a 2.x wallet, or drop UNDEPLOYED_PROTOCOL to go back to midnight-1.x.`
    : `${network.label} is running midnight-1.x (the default); if this devnet is a Midnight 2.x chain, set UNDEPLOYED_PROTOCOL=midnight-2.x (build env or window.SHIELDED_NIGHT) and reload.`;
};

/** The env var (and runtime-config key) holding each network's contract address. */
const ADDRESS_VAR: Record<NetworkOption['key'], ContractAddressVar> = {
  preview: 'PREVIEW_ADDRESS',
  preprod: 'PREPROD_ADDRESS',
  stagenet: 'STAGENET_ADDRESS',
  undeployed: 'UNDEPLOYED_ADDRESS',
};

/** Build-time values, baked from frontend/.env at `vite build` (envPrefix). */
const BUILD_TIME_ADDRESSES: Record<NetworkOption['key'], string | undefined> = {
  preview: import.meta.env.PREVIEW_ADDRESS,
  preprod: import.meta.env.PREPROD_ADDRESS,
  stagenet: import.meta.env.STAGENET_ADDRESS,
  undeployed: import.meta.env.UNDEPLOYED_ADDRESS,
};

/**
 * Contract address for a network: `window.SHIELDED_NIGHT.<NETWORK>_ADDRESS` if a
 * deployment injected one, else the build-time env var. Resolved per CALL (not
 * once at module load) so an injected config is picked up whenever it lands.
 */
export const rawContractAddressFor = (key: NetworkOption['key']): string | undefined =>
  resolveContractAddress(ADDRESS_VAR[key], BUILD_TIME_ADDRESSES[key]);

export const contractAddressFor = (key: NetworkOption['key']): string | undefined => {
  const address = rawContractAddressFor(key)?.replace(/^0x/i, '').toLowerCase();
  return address && /^[0-9a-f]{64}$/.test(address) ? address : undefined;
};

/**
 * Why the selected network cannot be used, if it cannot. The protocol switch is
 * checked FIRST: an unusable `UNDEPLOYED_PROTOCOL` is a configuration error in
 * its own right, and reporting a missing address instead would hide it.
 */
export const contractConfigurationError = (key: NetworkOption['key']): string | undefined => {
  const protocolError = protocolConfigurationError(key);
  if (protocolError) return protocolError;
  const raw = rawContractAddressFor(key);
  if (!raw) return `Shielded NIGHT is not deployed on ${resolveNetwork(key).label}.`;
  if (!contractAddressFor(key)) return `${ADDRESS_VAR[key]} must be exactly 32 bytes of hexadecimal.`;
  return undefined;
};

/** Midnight explorer base per network (only where known; undeployed has none). */
const EXPLORER_BASE: Record<NetworkOption['key'], string | undefined> = {
  preview: 'https://preview.midnightexplorer.com',
  preprod: undefined,
  stagenet: undefined,
  undeployed: undefined,
};

/** Explorer URL for a contract, or undefined if that network has no explorer. */
export const explorerContractUrl = (key: NetworkOption['key'], address: string): string | undefined => {
  const base = EXPLORER_BASE[key];
  return base ? `${base}/contracts/0x${address.replace(/^0x/, '')}` : undefined;
};

/**
 * The three public choices stay visible even when a deployment address is
 * missing, so the UI can explain that state. Local remains development-only
 * unless runtime configuration supplies its contract address.
 */
export const configuredNetworks = (): NetworkOption[] => {
  const publicNetworks = NETWORKS.filter((network) => network.key !== 'undeployed');
  const local = resolveNetwork('undeployed');
  return contractAddressFor('undeployed') || import.meta.env.DEV
    ? [...publicNetworks, local]
    : publicNetworks;
};
