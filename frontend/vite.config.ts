import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import wasm from 'vite-plugin-wasm';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const dir = path.dirname(fileURLToPath(import.meta.url));

// The compiled contract artifacts (prover/verifier keys, zkir) live in two
// isolated trees. Serve them at versioned URLs and retain the legacy v1 URL
// for already-open clients during rollout.
const managedV1Src = path.resolve(dir, '..', 'src', 'managed');
const managedV2Src = path.resolve(dir, '..', 'contracts', 'v2', 'managed');
const protocolDirectories = {
  v1: path.resolve(dir, 'protocols', 'v1'),
  v2: path.resolve(dir, 'protocols', 'v2'),
} as const;

/** Keep generated v1/v2 contracts on their own Compact runtime/WASM identity. */
function profileRuntimeResolution() {
  return {
    name: 'shielded-night-profile-runtime-resolution',
    enforce: 'pre' as const,
    resolveId(source: string, importer?: string) {
      if (source !== '@midnight-ntwrk/compact-runtime' || !importer) return null;
      const profile = importer.includes(`${path.sep}contracts${path.sep}v2${path.sep}managed${path.sep}`)
        ? 'v2'
        : importer.includes(`${path.sep}src${path.sep}managed${path.sep}`)
          ? 'v1'
          : null;
      return profile
        ? path.resolve(protocolDirectories[profile], 'node_modules', '@midnight-ntwrk', 'compact-runtime', 'dist', 'index.js')
        : null;
    },
  };
}

export default defineConfig({
  // Expose the per-network contract-address vars (PREVIEW_ADDRESS etc.) to the
  // client alongside the standard VITE_ prefix.
  envPrefix: ['VITE_', 'PREVIEW_', 'PREPROD_', 'STAGENET_', 'UNDEPLOYED_'],
  define: {
    global: 'globalThis',
  },
  resolve: {
    alias: {
      process: 'process/browser',
      buffer: 'buffer',
      util: 'util',
      crypto: path.resolve(dir, 'src/lib/crypto-shim.ts'),
      stream: 'stream-browserify',
      events: 'events',
      assert: path.resolve(dir, 'src/lib/assert-shim.ts'),
      // isomorphic-ws' browser build lacks a named WebSocket export the
      // indexer provider imports; map it to a shim exposing both forms.
      'isomorphic-ws': path.resolve(dir, 'src/lib/ws-shim.ts'),
    },
  },
  plugins: [
    profileRuntimeResolution(),
    react(),
    wasm(),
    viteStaticCopy({
      targets: [
        { src: managedV1Src, dest: 'contract/v1', rename: 'shielded-night' },
        { src: managedV2Src, dest: 'contract/v2', rename: 'shielded-night' },
        // Keep already-open v1 clients working while the release changes the
        // newly built adapter to the versioned path.
        { src: managedV1Src, dest: 'contract/compiled', rename: 'shielded-night' },
      ],
    }),
    {
      // Dev-only diagnostic sink: the dApp POSTs the exact balanced tx hex here
      // on a submission failure so it can be replayed against the node directly
      // (the wallet connector swallows the node's rejection reason).
      name: 'debug-tx-sink',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url === '/debug/last-tx' && req.method === 'POST') {
            const chunks: Buffer[] = [];
            req.on('data', (c) => chunks.push(c));
            req.on('end', () => {
              fs.writeFileSync(path.resolve(dir, '.debug-tx.hex'), Buffer.concat(chunks).toString('utf8'));
              res.statusCode = 204;
              res.end();
            });
            return;
          }
          next();
        });
      },
    },
    {
      // Dev server: return 404 for missing /contract/compiled/* assets instead
      // of the SPA fallback, so FetchZkConfigProvider sees a clean miss.
      name: 'contract-assets-404',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          const match = /^\/contract\/(v1|v2|compiled)\/shielded-night(\/.*)?$/.exec(req.url?.split('?')[0] ?? '');
          if (match) {
            const root = match[1] === 'v2' ? managedV2Src : managedV1Src;
            const filePath = path.join(root, match[2] ?? '');
            if (!fs.existsSync(filePath)) {
              res.statusCode = 404;
              res.end('404 Not Found');
              return;
            }
          }
          next();
        });
      },
    },
  ],
  optimizeDeps: {
    exclude: [
      '@midnight-ntwrk/compact-js',
      '@midnight-ntwrk/compact-runtime',
      '@midnight-ntwrk/ledger-v8',
      '@midnightntwrk/ledger-v9',
      '@midnight-ntwrk/midnight-js-contracts',
      '@midnight-ntwrk/midnight-js-types',
    ],
    esbuildOptions: { target: 'esnext' },
  },
  build: { target: 'esnext' },
  worker: { format: 'es' },
  assetsInclude: ['**/*.wasm'],
  server: {
    fs: { allow: ['..'] },
  },
});
