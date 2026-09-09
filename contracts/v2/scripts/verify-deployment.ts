/** Read-only verifier for a compiler 0.34.0 Shielded NIGHT deployment (MN_ENV=stagenet | undeployed). */
import '../../../scripts/load-env.js';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import {
  artifactSha256,
  mergeVerificationRecord,
  profileFor,
  readRecord,
  requestedEnv,
  sourceCommit,
  verifyAddress,
  writeRecord,
} from './profile.js';

async function main() {
  const env = requestedEnv();
  const address = process.env.CV_ADDRESS?.trim();
  if (!address) throw new Error(`Set CV_ADDRESS to the ${env} Shielded NIGHT contract address.`);
  const profile = profileFor(env);
  setNetworkId(profile.networkId);
  const publicDataProvider = indexerPublicDataProvider({
    queryURL: profile.indexer,
    subscriptionURL: profile.indexerWS,
  });
  try {
    const verified = await verifyAddress(publicDataProvider, address);
    const existing = readRecord(verified.address, env) ?? {};
    const record = mergeVerificationRecord({
      existing,
      network: {
        name: env,
        networkId: profile.networkId,
        node: profile.node,
        indexer: profile.indexer,
      },
      verified,
      verificationSourceCommit: sourceCommit(),
      verificationArtifactSha256: artifactSha256(),
      verifiedAt: new Date().toISOString(),
    });
    const recordPath = writeRecord(record, verified.address, env);
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
