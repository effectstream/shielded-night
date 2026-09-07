/**
 * Supported networks. `networkId` is the string hinted to the wallet's
 * `connect(networkId)` and also fed to midnight-js `setNetworkId`. The contract
 * address is read from one env var per network (`<NETWORK>_ADDRESS`, exposed
 * via vite.config's `envPrefix`), so the same build works across networks, and
 * may be overridden at RUNTIME by `window.SHIELDED_NIGHT.<NETWORK>_ADDRESS`
 * (see runtime-config.ts) for deployments that deploy their own contract after
 * the bundle was built. The wrapper (sNight) token type is always derived from
 * the address.
 */
/// <reference types="vite/client" />
import { resolveContractAddress, type ContractAddressVar } from './runtime-config.js';

export interface NetworkOption {
  key: 'preview' | 'preprod' | 'stagenet' | 'undeployed';
  label: string;
  networkId: string;
  protocolFamily: 'midnight-1.x' | 'midnight-2.x';
}

export const NETWORKS: NetworkOption[] = [
  { key: 'preview', label: 'Preview', networkId: 'preview', protocolFamily: 'midnight-1.x' },
  { key: 'preprod', label: 'Preprod', networkId: 'preprod', protocolFamily: 'midnight-1.x' },
  { key: 'stagenet', label: 'Stagenet', networkId: 'stagenet', protocolFamily: 'midnight-2.x' },
  { key: 'undeployed', label: 'Local (undeployed)', networkId: 'undeployed', protocolFamily: 'midnight-1.x' },
];

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

export const contractConfigurationError = (key: NetworkOption['key']): string | undefined => {
  const raw = rawContractAddressFor(key);
  if (!raw) return `Shielded NIGHT is not deployed on ${NETWORKS.find((item) => item.key === key)?.label ?? key}.`;
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
  const local = NETWORKS.find((network) => network.key === 'undeployed')!;
  return contractAddressFor('undeployed') || import.meta.env.DEV
    ? [...publicNetworks, local]
    : publicNetworks;
};
