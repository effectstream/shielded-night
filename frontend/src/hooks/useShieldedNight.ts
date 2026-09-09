import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ConnectedAPI, InitialAPI } from '@midnight-ntwrk/dapp-connector-api';
import { connectWallet, findInitialAPIs, isCompatibleApiVersion } from '../lib/connector';
import {
  contractAddressFor,
  contractConfigurationError,
  protocolMismatchHint,
  resolveNetwork,
  type NetworkOption,
} from '../lib/networks';
import type {
  Balances,
  Direction,
  ProtocolFamily,
  ProtocolSession,
  SwapCallbacks,
} from '../../protocols/shared/types';

export interface ShieldedNightState {
  networkKey: NetworkOption['key'];
  setNetworkKey: (key: NetworkOption['key']) => void;
  contractAddress: string | undefined;
  configurationError: string | undefined;
  protocolFamily: ProtocolFamily;

  availableAPIs: InitialAPI[];
  detecting: boolean;
  connecting: boolean;
  connected: boolean;
  operationPending: boolean;
  walletName?: string;
  connectedAPI?: ConnectedAPI;
  session?: ProtocolSession;
  coinPublicKey?: string;
  unshieldedAddress?: string;
  networkIdConnected?: string;

  balances?: Balances;
  refreshBalances: () => Promise<void>;
  convert: (direction: Direction, amount: bigint, callbacks?: SwapCallbacks) => Promise<void>;
  wrapperColorHex?: string;
  tokenName?: string;
  tokenSymbol?: string;

  connect: (api: InitialAPI) => Promise<void>;
  disconnect: () => void;
  logs: string[];
  appendLog: (message: string) => void;
  error?: string;
}

export function errMsg(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  for (let depth = 0; current != null && depth < 10 && !seen.has(current); depth += 1) {
    seen.add(current);
    if (typeof current === 'object') {
      const value = current as { message?: unknown; code?: unknown; reason?: unknown; cause?: unknown };
      const details: string[] = [];
      if (typeof value.message === 'string' && value.message && value.message !== 'Error') details.push(value.message);
      if (typeof value.code === 'string') details.push(`code=${value.code}`);
      if (typeof value.reason === 'string' && value.reason) details.push(`reason=${value.reason}`);
      if (details.length > 0) parts.push(details.join(' '));
      current = value.cause;
    } else {
      parts.push(String(current));
      break;
    }
  }
  if (parts.length === 0) {
    try {
      return error instanceof Error ? error.message : JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return parts.join(' ← ');
}

export function useShieldedNight(): ShieldedNightState {
  const [networkKey, setNetworkKeyState] = useState<NetworkOption['key']>('preview');
  const [availableAPIs, setAvailableAPIs] = useState<InitialAPI[]>([]);
  const [detecting, setDetecting] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [operationPending, setOperationPending] = useState(false);
  const [connectedAPI, setConnectedAPI] = useState<ConnectedAPI>();
  const [session, setSession] = useState<ProtocolSession>();
  const [walletName, setWalletName] = useState<string>();
  const [balances, setBalances] = useState<Balances>();
  const [tokenName, setTokenName] = useState<string>();
  const [tokenSymbol, setTokenSymbol] = useState<string>();
  const [logs, setLogs] = useState<string[]>([]);
  const [error, setError] = useState<string>();
  const sessionRef = useRef<ProtocolSession>();
  const generation = useRef(0);

  // Resolved (not static) so `undeployed` carries the protocol the
  // UNDEPLOYED_PROTOCOL setting selects; memoised to keep a stable identity for
  // the callbacks that depend on it.
  const network = useMemo(() => resolveNetwork(networkKey), [networkKey]);
  const contractAddress = contractAddressFor(networkKey);
  const configurationError = contractConfigurationError(networkKey);

  const appendLog = useCallback((message: string) => {
    const line = `${new Date().toLocaleTimeString()}  ${message}`;
    setLogs((previous) => [line, ...previous].slice(0, 200));
  }, []);

  const resetConnection = useCallback(() => {
    generation.current += 1;
    sessionRef.current?.dispose();
    sessionRef.current = undefined;
    setConnectedAPI(undefined);
    setSession(undefined);
    setWalletName(undefined);
    setBalances(undefined);
    setTokenName(undefined);
    setTokenSymbol(undefined);
    setConnecting(false);
    setOperationPending(false);
  }, []);

  useEffect(() => () => sessionRef.current?.dispose(), []);

  useEffect(() => {
    const discover = () => {
      const found = findInitialAPIs();
      setAvailableAPIs(found);
      setDetecting(false);
      if (found.length === 0) setError('No Midnight wallet extension detected.');
      else setError((value) => value === 'No Midnight wallet extension detected.' ? undefined : value);
    };
    discover();
    const timer = window.setInterval(discover, 1_500);
    return () => window.clearInterval(timer);
  }, []);

  const setNetworkKey = useCallback((key: NetworkOption['key']) => {
    if (key === networkKey) return;
    resetConnection();
    setError(undefined);
    setNetworkKeyState(key);
    appendLog(`Selected ${resolveNetwork(key).label}; reconnect required.`);
  }, [appendLog, networkKey, resetConnection]);

  const connect = useCallback(async (api: InitialAPI) => {
    if (configurationError || !contractAddress) {
      setError(configurationError ?? 'The selected network has no valid contract address.');
      return;
    }
    if (!isCompatibleApiVersion(api.apiVersion)) {
      setError(`Wallet connector ${api.apiVersion} is unsupported; install a wallet exposing connector API 4.x.`);
      return;
    }

    resetConnection();
    const requestGeneration = generation.current;
    let created: ProtocolSession | undefined;
    // Set once the wallet is accepted and the ledger-generation-specific code
    // starts: a failure from here on is the one a protocol mismatch produces.
    let adapterReached = false;
    setConnecting(true);
    setError(undefined);
    appendLog(`Connecting ${api.name} to ${network.label} (${network.protocolFamily})…`);
    try {
      const apiConnection = await connectWallet(api, network.networkId);
      if (generation.current !== requestGeneration) return;
      const configuration = await apiConnection.getConfiguration();
      if (generation.current !== requestGeneration) return;
      if (configuration.networkId !== network.networkId) {
        throw new Error(`Wallet connected to ${configuration.networkId}; select ${network.networkId} in the wallet.`);
      }

      adapterReached = true;
      created = network.protocolFamily === 'midnight-1.x'
        ? await import('../../protocols/v1/src/adapter').then((module) =>
          module.createV1Adapter(apiConnection, network.networkId, contractAddress))
        : await import('../../protocols/v2/src/adapter').then((module) =>
          module.createV2Adapter(apiConnection, network.networkId, contractAddress));
      if (!created) throw new Error('The selected protocol adapter did not create a session.');
      if (generation.current !== requestGeneration) {
        created.dispose();
        return;
      }

      sessionRef.current = created;
      setConnectedAPI(apiConnection);
      setSession(created);
      setWalletName(api.name);
      const [freshBalances, metadata] = await Promise.all([
        created.refreshBalances(),
        created.readMetadata(),
      ]);
      if (generation.current !== requestGeneration || sessionRef.current !== created) return;
      setBalances(freshBalances);
      setTokenName(metadata.name);
      setTokenSymbol(metadata.symbol);
      appendLog(`Connected to ${network.label}; loaded ${metadata.symbol}.`);
    } catch (caught) {
      created?.dispose();
      if (generation.current === requestGeneration) {
        sessionRef.current = undefined;
        setSession(undefined);
        setConnectedAPI(undefined);
        setWalletName(undefined);
        setError(errMsg(caught));
        appendLog(`Connection failed: ${errMsg(caught)}`);
        // The wallet never announces its ledger generation, so a 1.x wallet on
        // a midnight-2.x local network (or the reverse) can only surface here.
        const hint = adapterReached ? protocolMismatchHint(network.key) : undefined;
        if (hint) appendLog(hint);
      }
    } finally {
      if (generation.current === requestGeneration) setConnecting(false);
    }
  }, [appendLog, configurationError, contractAddress, network, resetConnection]);

  const disconnect = useCallback(() => {
    resetConnection();
    setError(undefined);
    appendLog('Disconnected.');
  }, [appendLog, resetConnection]);

  const refreshBalances = useCallback(async () => {
    const activeSession = sessionRef.current;
    if (!activeSession) return;
    const requestGeneration = generation.current;
    try {
      const fresh = await activeSession.refreshBalances();
      if (generation.current === requestGeneration && sessionRef.current === activeSession) {
        setBalances(fresh);
      }
    } catch (caught) {
      if (generation.current === requestGeneration && sessionRef.current === activeSession) {
        setError(errMsg(caught));
        throw caught;
      }
    }
  }, []);

  const convert = useCallback(async (
    direction: Direction,
    amount: bigint,
    callbacks: SwapCallbacks = {},
  ) => {
    const activeSession = sessionRef.current;
    if (!activeSession) throw new Error('Connect a wallet before converting.');
    const requestGeneration = generation.current;
    setOperationPending(true);
    setError(undefined);
    const isCurrent = () => generation.current === requestGeneration && sessionRef.current === activeSession;
    const syncCoinState = () => {
      if (!isCurrent()) return;
      const coinState = activeSession.wrapperCoinState();
      setBalances((current) => current ? {
        ...current,
        trackedWrapperCoins: coinState.available,
        blockedWrapperCoins: coinState.blocked,
      } : current);
    };
    try {
      await activeSession.convert(direction, amount, {
        onLog: (message) => {
          if (isCurrent()) callbacks.onLog?.(message);
        },
        onStep: (step, label) => {
          if (isCurrent()) callbacks.onStep?.(step, label);
        },
      });
      syncCoinState();
      if (isCurrent()) await refreshBalances();
    } catch (caught) {
      if (isCurrent()) {
        syncCoinState();
        setError(errMsg(caught));
        throw caught;
      }
      // A selected-network change invalidates the old session. If its wallet
      // submission already completed, leave that outcome associated with the
      // original session and suppress stale UI callbacks on the new network.
    } finally {
      if (isCurrent()) setOperationPending(false);
    }
  }, [refreshBalances]);

  return {
    networkKey,
    setNetworkKey,
    contractAddress,
    configurationError,
    protocolFamily: network.protocolFamily,
    availableAPIs,
    detecting,
    connecting,
    connected: session !== undefined,
    operationPending,
    walletName,
    connectedAPI,
    session,
    coinPublicKey: session?.coinPublicKey,
    unshieldedAddress: session?.unshieldedAddress,
    networkIdConnected: session?.networkId,
    balances,
    refreshBalances,
    convert,
    wrapperColorHex: session?.wrapperColorHex,
    tokenName,
    tokenSymbol,
    connect,
    disconnect,
    logs,
    appendLog,
    error,
  };
}
