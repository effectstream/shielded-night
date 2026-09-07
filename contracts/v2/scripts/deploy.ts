/** Local-host deployment for the compiler 0.34.0 stagenet profile. */
import '../../../scripts/load-env.js';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import { deployContract } from '@midnight-ntwrk/midnight-js-contracts';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { MidnightWalletProvider, initializeMidnightProviders } from '@midnight-ntwrk/testkit-js';
import { NetworkId, validateMnemonic } from '@midnightntwrk/wallet-sdk';
import { mnemonicToSeedSync } from '@scure/bip39';
import pino from 'pino';
import { Contract } from '../managed/contract/index.js';
import {
  artifactSha256,
  COMPATIBILITY,
  MANAGED_DIRECTORY,
  sourceCommit,
  stagenet,
  verifyAddress,
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
  setNetworkId(profile.networkId);

  const wallet = await MidnightWalletProvider.build(pino({ level: 'info' }), environment, deploymentSeed());
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
    } as never);
    const transaction = deployed.deployTxData.public;
    const address = transaction.contractAddress;
    const provenance = {
      schemaVersion: 1,
      network: {
        name: 'stagenet',
        networkId: profile.networkId,
        node: profile.node,
        indexer: profile.indexer,
      },
      contractAddress: address,
      sourceCommit: sourceCommit(),
      compatibility: COMPATIBILITY,
      artifactSha256: artifactSha256(),
      deploymentTransaction: {
        id: transaction.txId,
        blockHeight: String(transaction.blockHeight),
        blockHash: transaction.blockHash,
        blockTimestamp: String(transaction.blockTimestamp),
      },
    };
    const pendingPath = writeRecord({
      ...provenance,
      verificationStatus: 'pending',
      maintenanceAuthority: { status: 'not-yet-read' },
      recordedAt: new Date().toISOString(),
    }, address);
    console.log(`[deploy] confirmed stagenet contract ${address}`);
    console.log(`[deploy] confirmation record ${pendingPath}`);
    console.log(`STAGENET_ADDRESS=${address}`);

    const verified = await verifyAddress(providers.publicDataProvider, address);
    const record = {
      ...provenance,
      verificationStatus: 'verified',
      metadata: verified.metadata,
      verifierKeys: verified.verifierKeys,
      maintenanceAuthority: verified.authority,
      verifiedAt: new Date().toISOString(),
    };
    const recordPath = writeRecord(record, verified.address);
    console.log(`[deploy] verified stagenet contract ${verified.address}`);
    console.log(`[deploy] maintenance authority locked=${verified.authority.locked}`);
    console.log(`[deploy] record ${recordPath}`);
  } finally {
    await wallet.stop().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error('[deploy:v2] failed:', error instanceof Error ? (error.stack ?? error.message) : error);
  process.exitCode = 1;
});
