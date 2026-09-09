/** Local-host deployment for the compiler 0.34.0 profiles (MN_ENV=stagenet | undeployed). */
import '../../../scripts/load-env.js';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import { deployContract } from '@midnight-ntwrk/midnight-js-contracts';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { MidnightWalletProvider, initializeMidnightProviders, syncWallet } from '@midnight-ntwrk/testkit-js';
import { NetworkId, validateMnemonic } from '@midnightntwrk/wallet-sdk';
import { mnemonicToSeedSync } from '@scure/bip39';
import { Contract } from '../managed/contract/index.js';
import {
  artifactSha256,
  assertMaintenanceAuthorityKey,
  COMPATIBILITY,
  createWalletLogger,
  GENESIS_MINT_SEED,
  MANAGED_DIRECTORY,
  mergeVerificationRecord,
  preflightRecordOutput,
  privateStateStoreName,
  profileFor,
  reportConfirmedDeployment,
  requestedEnv,
  sourceCommit,
  verifyAddress,
  WALLET_NETWORK_IDS,
  walletNetworkIdFor,
  withDurableMaintenanceKey,
  withSyncedDeploymentWallet,
  writeRecord,
  type V2EnvName,
} from './profile.js';
import { loadWalletEnvFile } from './load-wallet-env.js';

loadWalletEnvFile();

/**
 * `WALLET_NETWORK_IDS` is written as plain literals in profile.ts so the unit
 * tier can import that module without the WASM-bearing wallet barrel. This
 * declaration is the compile-time pin that keeps those literals equal to the
 * SDK's own constants: it stops type-checking if either name or value moves.
 */
const _walletNetworkIdsMatchSdk: {
  readonly stagenet: typeof NetworkId.NetworkId.StageNet;
  readonly undeployed: typeof NetworkId.NetworkId.Undeployed;
} = WALLET_NETWORK_IDS;
void _walletNetworkIdsMatchSdk;

function deploymentSeed(env: V2EnvName): string {
  const mnemonic = process.env.MN_MNEMONIC?.trim().replace(/\s+/g, ' ');
  if (mnemonic) {
    if (!validateMnemonic(mnemonic)) throw new Error('MN_MNEMONIC is not a valid BIP-39 phrase.');
    return Buffer.from(mnemonicToSeedSync(mnemonic)).toString('hex');
  }
  const seed = process.env.MN_SEED?.trim();
  if (!seed && env === 'undeployed') {
    // Only ever on a throwaway devnet, and never silently: genesis-1 is the
    // funding faucet on a local stack and is shared with every other facade
    // deployed there.
    console.warn(
      '[deploy] WARNING: no MN_MNEMONIC/MN_SEED set; falling back to the shared genesis-1 devnet seed. ' +
        'It funds every other facade on a local stack — set MN_SEED to a dedicated seed for anything you keep.',
    );
    return GENESIS_MINT_SEED;
  }
  if (!seed || !/^[0-9a-f]+$/i.test(seed) || seed.length % 2 !== 0) {
    throw new Error('Set MN_MNEMONIC or an even-length hexadecimal MN_SEED in the repo-root .env or shell.');
  }
  return seed;
}

async function main() {
  const env = requestedEnv();
  const profile = profileFor(env);
  const environment = { ...profile, walletNetworkId: walletNetworkIdFor(env) };
  // All provenance and output checks happen before wallet startup or a funded
  // transaction. After deployContract resolves, the address is printed before
  // any record or indexer operation that can fail.
  const deploymentSourceCommit = sourceCommit();
  const deploymentArtifactSha256 = artifactSha256();
  preflightRecordOutput(env);
  await withDurableMaintenanceKey({
    sourceCommit: deploymentSourceCommit,
    artifactSha256: deploymentArtifactSha256,
  }, async (maintenanceKey) => {
    setNetworkId(profile.networkId);

    // testkit-js logs the seed at info level; deployment logging must remain
    // silent because structured redaction cannot remove an interpolated secret.
    const wallet = await MidnightWalletProvider.build(createWalletLogger(), environment, deploymentSeed(env));
    await withSyncedDeploymentWallet(wallet, syncWallet, async () => {
      const providers = initializeMidnightProviders(wallet, environment, {
        privateStateStoreName: privateStateStoreName(env),
        zkConfigPath: MANAGED_DIRECTORY,
      });
      const compiled = CompiledContract.make('shielded-night-v2', Contract).pipe(
        CompiledContract.withVacantWitnesses,
        CompiledContract.withCompiledFileAssets(MANAGED_DIRECTORY),
      );
      // The generated contract declaration is deliberately kept inside this
      // isolated profile. Cast at the SDK seam so its nominal types cannot pull
      // a second Compact runtime identity into another package.
      const deployed = await deployContract(providers as never, {
        compiledContract: compiled,
        args: ['Shielded Night', 'sNight', 6n],
        signingKey: maintenanceKey.signingKey,
      } as never);
      const transaction = deployed.deployTxData.public;
      const address = reportConfirmedDeployment(transaction, console.log, env);
      const provenance = {
        schemaVersion: 2,
        recordKind: 'deployment',
        network: {
          name: env,
          networkId: profile.networkId,
          node: profile.node,
          indexer: profile.indexer,
        },
        contractAddress: address,
        sourceCommit: deploymentSourceCommit,
        compatibility: COMPATIBILITY,
        artifactSha256: deploymentArtifactSha256,
        deploymentTransaction: {
          id: transaction.txId,
          blockHeight: String(transaction.blockHeight),
          blockHash: transaction.blockHash,
          blockTimestamp: String(transaction.blockTimestamp),
        },
      };
      const pendingRecord = {
        ...provenance,
        verificationStatus: 'pending',
        maintenanceAuthority: {
          status: 'key-prepersisted-not-yet-read',
          verifyingKey: maintenanceKey.verifyingKey,
        },
        recordedAt: new Date().toISOString(),
      };
      const pendingPath = writeRecord(pendingRecord, address, env);
      console.log(`[deploy] confirmation record ${pendingPath}`);

      const verified = await verifyAddress(providers.publicDataProvider, address);
      assertMaintenanceAuthorityKey(verified, maintenanceKey.verifyingKey);
      const verifiedAt = new Date().toISOString();
      const record = mergeVerificationRecord({
        existing: pendingRecord,
        network: provenance.network,
        verified,
        verificationSourceCommit: deploymentSourceCommit,
        verificationArtifactSha256: deploymentArtifactSha256,
        verifiedAt,
      });
      const recordPath = writeRecord(record, verified.address, env);
      console.log(`[deploy] verified ${env} contract ${verified.address}`);
      console.log(`[deploy] maintenance authority locked=${verified.authority.locked}`);
      console.log(`[deploy] record ${recordPath}`);
    });
  });
}

main().catch((error) => {
  console.error('[deploy:v2] failed:', error instanceof Error ? (error.stack ?? error.message) : error);
  process.exitCode = 1;
});
