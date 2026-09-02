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
import { resolveContractAddress, type ContractAddressVar } from './runtime-config';

export interface NetworkOption {
  key: 'preview' | 'preprod' | 'mainnet' | 'undeployed';
  label: string;
  networkId: string;
}

export const NETWORKS: NetworkOption[] = [
  { key: 'preview', label: 'Preview', networkId: 'preview' },
  { key: 'preprod', label: 'PreProd', networkId: 'preprod' },
  { key: 'mainnet', label: 'Mainnet', networkId: 'mainnet' },
  { key: 'undeployed', label: 'Local (undeployed)', networkId: 'undeployed' },
];

/** The env var (and runtime-config key) holding each network's contract address. */
const ADDRESS_VAR: Record<NetworkOption['key'], ContractAddressVar> = {
  preview: 'PREVIEW_ADDRESS',
  preprod: 'PREPROD_ADDRESS',
  mainnet: 'MAINNET_ADDRESS',
  undeployed: 'UNDEPLOYED_ADDRESS',
};

/** Build-time values, baked from frontend/.env at `vite build` (envPrefix). */
const BUILD_TIME_ADDRESSES: Record<NetworkOption['key'], string | undefined> = {
  preview: import.meta.env.PREVIEW_ADDRESS,
  preprod: import.meta.env.PREPROD_ADDRESS,
  mainnet: import.meta.env.MAINNET_ADDRESS,
  undeployed: import.meta.env.UNDEPLOYED_ADDRESS,
};

/**
 * Contract address for a network: `window.SHIELDED_NIGHT.<NETWORK>_ADDRESS` if a
 * deployment injected one, else the build-time env var. Resolved per CALL (not
 * once at module load) so an injected config is picked up whenever it lands.
 */
export const contractAddressFor = (key: NetworkOption['key']): string | undefined =>
  resolveContractAddress(ADDRESS_VAR[key], BUILD_TIME_ADDRESSES[key]);

/** Midnight explorer base per network (only where known; undeployed has none). */
const EXPLORER_BASE: Record<NetworkOption['key'], string | undefined> = {
  preview: 'https://preview.midnightexplorer.com',
  preprod: undefined,
  mainnet: undefined,
  undeployed: undefined,
};

/** Explorer URL for a contract, or undefined if that network has no explorer. */
export const explorerContractUrl = (key: NetworkOption['key'], address: string): string | undefined => {
  const base = EXPLORER_BASE[key];
  return base ? `${base}/contracts/0x${address.replace(/^0x/, '')}` : undefined;
};

/**
 * Networks that actually have a deployed contract configured. The dropdown
 * shows only these, so unconfigured networks (e.g. preprod, mainnet) appear
 * the moment their <NETWORK>_ADDRESS env var is set - no code change needed.
 * The same holds for a runtime-injected address: a stack that deploys its own
 * contract and injects `window.SHIELDED_NIGHT.UNDEPLOYED_ADDRESS` makes "Local
 * (undeployed)" appear in a bundle built with an empty UNDEPLOYED_ADDRESS.
 */
export const configuredNetworks = (): NetworkOption[] => {
  const live = NETWORKS.filter((n) => contractAddressFor(n.key) !== undefined);
  return live.length > 0 ? live : NETWORKS.filter((n) => n.key === 'preview');
};
