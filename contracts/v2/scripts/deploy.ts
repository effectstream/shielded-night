/** Local-host deployment for the compiler 0.34.0 stagenet profile. */
import '../../../scripts/load-env.js';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import { deployContract } from '@midnight-ntwrk/midnight-js-contracts';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { MidnightWalletProvider, initializeMidnightProviders } from '@midnight-ntwrk/testkit-js';
import { NetworkId, validateMnemonic } from '@midnightntwrk/wallet-sdk';
import { mnemonicToSeedSync } from '@scure/bip39';
import { Contract } from '../managed/contract/index.js';
import {
  artifactSha256,
  assertMaintenanceAuthorityKey,
  COMPATIBILITY,
  createWalletLogger,
  MANAGED_DIRECTORY,
  mergeVerificationRecord,
  preflightRecordOutput,
  reportConfirmedDeployment,
  sourceCommit,
  stagenet,
  verifyAddress,
  withDurableMaintenanceKey,
  writeRecord,
} from './profile.js';
import { loadWalletEnvFile } from './load-wallet-env.js';

loadWalletEnvFile();

function deploymentSeed(): string {
  const mnemonic = process.env.MN_MNEMONIC?.trim().replace(/\s+/g, ' ');
  if (mnemonic) {
    if (!validateMnemonic(mnemonic)) throw new Error('MN_MNEMONIC is not a valid BIP-39 phrase.');
    return Buffer.from(mnemonicToSeedSync(mnemonic)).toString('hex');
  }
  const seed = process.env.MN_SEED?.trim();
  if (!seed || !/^[0-9a-f]+$/i.test(seed) || seed.length % 2 !== 0) {
    throw new Error('Set MN_MNEMONIC or an even-length hexadecimal MN_SEED in the repo-root .env or shell.');
  }
  return seed;
}

async function main() {
  const requested = process.env.MN_ENV?.trim() || 'stagenet';
  if (requested !== 'stagenet') throw new Error('The v2 deployment command only supports MN_ENV=stagenet.');
  const profile = stagenet();
  const environment = { ...profile, walletNetworkId: NetworkId.NetworkId.StageNet };
  // All provenance and output checks happen before wallet startup or a funded
  // transaction. After deployContract resolves, the address is printed before
  // any record or indexer operation that can fail.
  const deploymentSourceCommit = sourceCommit();
  const deploymentArtifactSha256 = artifactSha256();
  preflightRecordOutput();
  await withDurableMaintenanceKey({
    sourceCommit: deploymentSourceCommit,
    artifactSha256: deploymentArtifactSha256,
  }, async (maintenanceKey) => {
    setNetworkId(profile.networkId);

    // testkit-js logs the seed at info level; deployment logging must remain
    // silent because structured redaction cannot remove an interpolated secret.
    const wallet = await MidnightWalletProvider.build(createWalletLogger(), environment, deploymentSeed());
    await wallet.start(true);
    try {
      const providers = initializeMidnightProviders(wallet, environment, {
        privateStateStoreName: 'shielded-night-v2-stagenet',
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
      const address = reportConfirmedDeployment(transaction);
      const provenance = {
        schemaVersion: 2,
        recordKind: 'deployment',
        network: {
          name: 'stagenet',
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
      const pendingPath = writeRecord(pendingRecord, address);
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
      const recordPath = writeRecord(record, verified.address);
      console.log(`[deploy] verified stagenet contract ${verified.address}`);
      console.log(`[deploy] maintenance authority locked=${verified.authority.locked}`);
      console.log(`[deploy] record ${recordPath}`);
    } finally {
      await wallet.stop().catch(() => undefined);
    }
  });
}

main().catch((error) => {
  console.error('[deploy:v2] failed:', error instanceof Error ? (error.stack ?? error.message) : error);
  process.exitCode = 1;
});
