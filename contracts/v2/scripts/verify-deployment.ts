/** Read-only stagenet verifier for a compiler 0.34.0 Shielded NIGHT deployment. */
import '../../../scripts/load-env.js';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import {
  artifactSha256,
  COMPATIBILITY,
  readRecord,
  sourceCommit,
  stagenet,
  verifyAddress,
  writeRecord,
} from './profile.js';

async function main() {
  const requested = process.env.MN_ENV?.trim() || 'stagenet';
  if (requested !== 'stagenet') throw new Error('The v2 verifier only supports MN_ENV=stagenet.');
  const address = process.env.CV_ADDRESS?.trim();
  if (!address) throw new Error('Set CV_ADDRESS to the stagenet Shielded NIGHT contract address.');
  const profile = stagenet();
  setNetworkId(profile.networkId);
  const publicDataProvider = indexerPublicDataProvider({
    queryURL: profile.indexer,
    subscriptionURL: profile.indexerWS,
  });
  try {
    const verified = await verifyAddress(publicDataProvider, address);
    const existing = readRecord(verified.address) ?? {};
    const record = {
      ...existing,
      schemaVersion: 1,
      network: {
        name: 'stagenet',
        networkId: profile.networkId,
        node: profile.node,
        indexer: profile.indexer,
      },
      contractAddress: verified.address,
      sourceCommit: sourceCommit(),
      compatibility: COMPATIBILITY,
      artifactSha256: artifactSha256(),
      verificationStatus: 'verified',
      metadata: verified.metadata,
      verifierKeys: verified.verifierKeys,
      maintenanceAuthority: verified.authority,
      verifiedAt: new Date().toISOString(),
    };
    const recordPath = writeRecord(record, verified.address);
    console.log(`[verify:v2] code and metadata match ${verified.address}`);
    console.log(`[verify:v2] maintenance authority locked=${verified.authority.locked}`);
    console.log(`[verify:v2] record ${recordPath}`);
  } finally {
    await publicDataProvider.dispose();
  }
}

main().catch((error) => {
  console.error('[verify:v2] failed:', error instanceof Error ? (error.stack ?? error.message) : error);
  process.exitCode = 1;
});
