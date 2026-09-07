# Shielded NIGHT

Convert native **unshielded NIGHT** into **shielded sNight** (a contract-minted wrapper token) and back, on Midnight.

Live (Preview / Preprod / Stagenet selector): https://shielded-night.pages.dev

## What this is

Two ways to convert, both backed by the same pool of locked NIGHT.

**Atomic - one transaction, one wallet approval (what the live app uses):**

- **Unshielded NIGHT -> shielded sNight:** `convertToShielded(amount, recipient, nonce)` locks NIGHT and mints sNight to you, in a single transaction.
- **Shielded sNight -> unshielded NIGHT:** `convertToUnshielded(coin, recipient)` burns sNight and releases NIGHT to you, in a single transaction.

No secret and no intermediate credit: both value domains net inside one circuit (one ledger segment), which is the only way to combine a shielded and an unshielded move in one transaction. Merging two separate calls can't do it - their intents land in different segments.

**Two-step pool - credit-bridged**

You hold a credit balance keyed by `hash(secret)`; deposit in one domain, withdraw in the other:

- `depositUnshielded(secret, amount)` locks NIGHT and credits your key,
- `depositShielded(secret, coin)` burns sNight and credits your key.
- `withdrawShielded(secret, amount, ...)` mints sNight and debits it.
- `withdrawUnshielded(secret, amount, to)` releases NIGHT and debits it.

`secret` is always a private circuit input; only `hash(secret)` (the balance key) is public. Splitting a conversion into two half-steps decouples them - useful when deposit and withdrawal happen at different times, or the recipient differs from the depositor.

Locked NIGHT backs the wrapper 1:1 across both models - the invariant `locked NIGHT == credits + outstanding sNight` keeps every holder solvent.

## Layout

```
.
├── src/
│   ├── shielded-night.compact        # the Compact contract
│   ├── witnesses.ts                 # private state (none; empty)
│   ├── index.ts                     # package entry
│   └── managed/                     # compiled output: contract, keys, zkir (generated)
├── test/
│   ├── unit/                        # simulator unit tests (+ security, transient)
│   ├── integration/                 # docker-stack tests + global setup
│   └── support/                     # ported midnight-canary harness + contract factory
├── scripts/
│   ├── deploy.ts                    # deploy from src/managed (mnemonic or seed)
│   ├── deploy-and-lock.ts           # deploy, then lock (one-way, non-upgradeable)
│   ├── lock.ts                      # lock an already-deployed contract (has DRY_RUN)
│   ├── deploy-record.ts             # optional DEPLOY_OUT=<path> JSON record of a deploy
│   └── verify-deployment.ts         # read-only: on-chain keys == this repo, lock status
├── envs/docker-compose-dynamic.yml  # local node + indexer + proof server
├── frontend/                        # Vite + React dApp
│   └── src/
│       ├── App.tsx
│       ├── components/              # WalletBar, SwapCard, BalancePanel, PendingSwaps, ActivityLog
│       ├── hooks/useShieldedNight.ts        # connect, providers, balances, state
│       └── lib/                     # connector, providers, walletAdapter, contract, swap, tokens, networks, runtime-config
├── .github/workflows/
│   ├── ci.yml                       # unit, frontend, byte-exact rebuild, integration
│   └── deploy.yml                   # automatic production + manual preview Pages deploy
├── TESTING.md
└── README.md
```

## How to run

The frontend is a Vite + React app that connects to any `window.midnight` wallet (e.g. Lace), reads your NIGHT/sNight balances, and runs the atomic one-transaction swaps (one wallet approval each way). Proving is delegated to the wallet.

```bash
bun install --frozen-lockfile
bun --cwd frontend install --frozen-lockfile
npm --prefix frontend/protocols/v1 ci
npm --prefix frontend/protocols/v2 ci
bun --cwd frontend run dev   # http://localhost:5173 (uses the committed .env)
```

Needs a Midnight wallet extension, the v1 artifacts in `src/managed/`, and the v2 artifacts in `contracts/v2/managed/`. The two protocol installs remain separate because their ledger/runtime WASM generations cannot share class identities. Deploy details and the wallet-proving model are in [frontend/README.md](frontend/README.md).

Deploy a contract (needs a funded, DUST-registered wallet). Put the deployer
credentials in the repo-root `.env` (gitignored - template in
[.env.example](.env.example); the shell env still takes precedence):

```bash
cp .env.example .env     # fill in MN_MNEMONIC (or MN_SEED) - never committed

MN_ENV=preview bun run scripts/deploy.ts

# or deploy and immediately lock it (dissolve the maintenance committee -
# permanently non-upgradeable, one-way):
MN_ENV=preview bun run scripts/deploy-and-lock.ts
```

Two `.env` files, opposite policies: the root `.env` holds **secrets** and is
gitignored; [frontend/.env](frontend/.env) holds only **public contract
addresses** and is committed (the deployed address lives in git history).

### Deploying the 2.x contract to Stagenet

Contract deployment is a local-host operation; the GitHub workflow only builds and uploads the static website. Install the isolated v2 dependency tree, reproduce the compiler 0.34.0 artifacts, and run the deployer with a funded, DUST-registered Stagenet wallet and a compatible proof server (the default proof-server URL is `http://127.0.0.1:6300`):

```bash
npm --prefix contracts/v2 ci
bun run compact:v2

# Read WALLET_SEED from an existing private file without copying it into this repo.
MN_WALLET_ENV_FILE=/private/path/to/wallet.env MN_ENV=stagenet bun run deploy:v2

# Or use MN_MNEMONIC / MN_SEED from the gitignored root .env shown above.
MN_ENV=stagenet bun run deploy:v2
```

The deployer confirms the transaction, compares the on-chain circuit set and verifier keys with `contracts/v2/managed`, reports the maintenance-authority state, and writes a private record to `.local/deployments/v2-stagenet-<address>.json` by default. It does not lock the maintenance authority. Preserve the printed `STAGENET_ADDRESS` as public data in `frontend/.env`, then independently repeat the read-only verification:

```bash
MN_ENV=stagenet CV_ADDRESS=<deployed-address> bun run verify:deployment:v2
```

That committed public address becomes part of the frontend build; after the change reaches `main` and same-SHA CI succeeds, the Pages workflow below publishes it automatically. Never commit the wallet file, seed, mnemonic, or `.local` deployment record.

### Deploying into a stack you already have

Everything above assumes the local devnet is on this host's loopback and that a
human pastes the new address into `frontend/.env`. A deployment that brings up
its OWN chain — a compose stack that deploys this contract once per bring-up and
serves the dApp from an image built long before — needs neither assumption, and
four opt-in knobs cover it. All default to today's behaviour, so nothing changes
for an existing deploy, build or CI run.

| Knob | Where | What it does |
| --- | --- | --- |
| `MN_INDEXER_URL`, `MN_INDEXER_WS_URL`, `MN_NODE_URL`, `MN_PROOF_SERVER_URL` | deploy / lock / verify scripts and the integration suite | dial a stack that is not on `127.0.0.1` — e.g. compose service hostnames from inside the same docker network. `undeployed` honours all four; hosted envs honour `MN_PROOF_SERVER_URL` only ([TESTING.md](TESTING.md)) |
| `DEPLOY_OUT=<path>` | `scripts/deploy.ts`, `scripts/deploy-and-lock.ts` | also write the deploy as JSON — `{address, networkId, name, symbol, decimals, deployedAt, commit, locked}` — published atomically, so an automated deployment reads DATA instead of scraping stdout ([scripts/deploy-record.ts](scripts/deploy-record.ts)) |
| `window.SHIELDED_NIGHT = { UNDEPLOYED_ADDRESS: "…" }` | the SPA — overwrite the built `dist/config.js`, which `index.html` already loads before the bundle | override the built-in contract address at RUNTIME, so one image serves any stack; nothing else in the build is touched ([frontend/README.md](frontend/README.md#runtime-address-override-windowshielded_night)) |
| `MN_EXTERNAL_STACK=1` | the integration suite | run the suite against that already-running stack instead of booting one with testcontainers — the strongest e2e gate a packaging of this dApp can have ([TESTING.md](TESTING.md)) |

```bash
# deploy into a compose stack, from a container on its network
MN_ENV=undeployed MN_SEED=<dedicated-deployer-seed> \
  MN_INDEXER_URL=http://indexer:8088/api/v4/graphql \
  MN_INDEXER_WS_URL=ws://indexer:8088/api/v4/graphql/ws \
  MN_NODE_URL=http://node:9944 \
  MN_PROOF_SERVER_URL=http://proof-server:6300 \
  DEPLOY_OUT=/srv/shielded-night/contract.json \
  bun run scripts/deploy.ts
```

On `undeployed` the deployer seed defaults to the genesis seed
(`…0001`). Set `MN_SEED` to a dedicated one whenever anything else on that
stack uses genesis — two facades on one wallet knock each other offline.

## Locking a 1.x contract

Every Midnight contract has a **maintenance authority** - a committee of keys allowed to change its rules (e.g. swap out a circuit's verifier key). On a fresh deploy that committee is just the deployer (1-of-1), so the deployer can still alter the contract after the fact. For a trustless release you remove that power.

Locking installs an **empty committee at threshold 1**. No signature set can ever satisfy an empty committee, so no future maintenance update can be authorized - the contract is permanently frozen. Both scripts re-read the on-chain authority and verify `committee=0` before reporting success.

- `scripts/deploy-and-lock.ts` - deploy and lock in one shot.
- `scripts/lock.ts` - lock a contract that's already deployed (e.g. one you deployed and tested live first). Run it with `DRY_RUN=1` first to confirm the maintenance signing key is present and the contract is lockable without submitting anything:

  ```bash
  DRY_RUN=1 MN_ENV=preview CV_ADDRESS=<hex> bun run scripts/lock.ts
  MN_ENV=preview CV_ADDRESS=<hex> bun run scripts/lock.ts
  ```

  (Credentials come from the root `.env`, as with the deploy scripts.)

  Locking needs the maintenance signing key generated at deploy time, so run it with the **same wallet you deployed with** (the key lives in this machine's `midnight-level-db`).

- **Locked = un-upgradeable, not disabled.** All circuits keep working; only the rules can never change. Users can rely on the code (and the solvency invariant) never shifting under them.
- **It is a one-way door.** A locked contract can't be unlocked. To change anything, deploy a fresh instance and point `frontend/.env` at the new address.

The existing live Preview 1.x contract is locked. The new Stagenet 2.x deployer deliberately reports and preserves its maintenance authority instead of locking it; its deployment record must not claim immutability. To iterate on a locked v1 contract, deploy a fresh instance and repoint the frontend.

## Verifying the deployment

The steps below verify the existing 1.x deployments against `src/managed` and, where locked, prove their maintenance authority cannot change them. Both checks are read-only - no wallet or seed needed. The Stagenet 2.x verifier is the separate `verify:deployment:v2` command above and reports its intentionally unlocked authority.

### 1. Reproduce the compiled artifacts byte-for-byte

The compiler output is deterministic and the contract pins its language version (`pragma language_version 0.23`), so compiling [src/shielded-night.compact](src/shielded-night.compact) with the pinned toolchain reproduces [src/managed/](src/managed/) exactly:

```bash
# Install the Compact toolchain (once): https://docs.midnight.network/relnotes/compact-tools
compact update 0.31.1      # toolchain 0.31.1 = compactc 0.31.101, language 0.23.101

bun install
bun run compact            # recompiles src/shielded-night.compact -> src/managed/
git diff --exit-code src/managed/   # empty diff = byte-exact reproduction
```

If `git diff` prints nothing, the committed artifacts (zkir, prover/verifier keys, JS bindings) are exactly what this source compiles to - there is nothing hidden in the build.

### 2. Verify the on-chain contract matches, and is immutable

```bash
MN_ENV=preview CV_ADDRESS=<deployed-address> bun run verify:deployment
```

The script queries the public indexer and checks:

- **Code**: every circuit's on-chain verifier key is byte-identical to `src/managed/keys/*.verifier`, and the circuit sets match exactly (nothing missing, nothing extra). Together with step 1, this proves the deployed rules were compiled from this exact source.
- **Lock**: the on-chain maintenance authority is an **empty committee with threshold >= 1**. A maintenance update needs `threshold` committee signatures, and an empty committee can never produce even one - so `committee(0) < threshold(1)` means no rule, verifier key, or behavior can ever be changed. The deployed version is immutable.

Expected output ends with:

```
maintenance authority: committee=0 threshold=1 counter=1
✓ LOCKED: empty committee with positive threshold - no maintenance update can ever be authorized.

✅ verified: deployed code matches this repo byte-for-byte AND the contract is immutable.
```

The script exits non-zero if either check fails (e.g. it correctly flags contracts deployed from older builds).

### Verifying a contract that is deliberately not locked: `--allow-unlocked`

Locking is a one-way door, so it is only right for a hosted release. Every
devnet/demo deploy leaves the contract **unlocked** on purpose
(`SHIELDED_NIGHT_LOCK=false`) - and the strict run above then exits 1 even when
all 11 verifier keys match, because the LOCK check failed. That makes the
strongest check in the profile unreadable from the exit code.

`--allow-unlocked` measures and prints the lock state exactly as before, but
lets **only the code check decide the exit code**:

```bash
MN_ENV=undeployed CV_ADDRESS=<deployed-address> bun run verify:deployment -- --allow-unlocked
```

(The `--` is what makes `bun run` forward the flag to the script; calling
`bun run scripts/verify-deployment.ts --allow-unlocked` directly works too.)

Output on an unlocked contract whose code matches:

```
maintenance authority: committee=1 threshold=1 counter=0
ℹ NOT locked: 1 committee member(s) can still change the contract (threshold 1). Reported only, not failed: --allow-unlocked was passed.

✅ verified: deployed code matches this repo byte-for-byte. Lock state REPORTED ONLY (--allow-unlocked): this contract is NOT immutable.
```

The flag **never weakens the code check**: a verifier-key mismatch, a missing
circuit or an extra circuit still exits 1 with the flag set. It only ever
changes what an *unlocked* contract does to the exit code. Use it for a demo
stack's verify step; never for a hosted release, where being immutable is part
of the claim.

Unknown arguments are rejected rather than ignored, so a typo
(`--allow-unlock`) fails loudly instead of silently reverting to the strict
behaviour.

## How to run tests

Two tiers (details and env vars in [TESTING.md](TESTING.md)):

```bash
bun run compact:fast && bun run test:unit     # simulator unit tests, no infra, seconds
bun run compact && bun run test:integration   # docker stack: node + indexer + proof server, minutes
```

Unit tests run every circuit against an in-memory context, including security and border cases for both the atomic and two-step paths. Integration tests deploy to a local stack and cover the full round trip both directions (atomic and two-step), negative paths, on-chain attack vectors (forged, inflated, and double-spent coins; nonce-replay minting; the solvency invariant), multi-party circulation, and the maintenance-authority lock.

## CI / CD

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on every push to `main`, every PR, and on demand:

| Job | What it guards |
| --- | --- |
| **Unit tests** | Runs the v1 simulator and repo typecheck with Compact 0.31.1, plus the isolated v2 simulator and typecheck after a Compact 0.34.0 fast compile. |
| **Frontend** | Installs the root, frontend, v1 browser protocol, and v2 browser protocol lockfiles before `tsc --noEmit` and a real `vite build`. This reproduces the physical package layout used to keep the two WASM/runtime generations isolated. |
| **Byte-exact rebuilds** | Independent jobs delete and rebuild `src/managed/` with Compact 0.31.1 and `contracts/v2/managed/` with Compact 0.34.0, then assert each tree is byte-identical to the committed artifacts. Compiling into empty trees prevents either check from passing against untouched outputs. |
| **Integration tests** | Full docker stack: node + indexer + proof server. |

[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) builds the frontend and uploads `frontend/dist` to the existing Cloudflare Pages project. A successful push-triggered CI run for the repository's current `main` commit automatically publishes that exact commit to `shielded-night.pages.dev`. Failed CI, pull-request CI, fork-originated runs, and CI for a commit that is no longer current `main` cannot publish. Production runs share a serialized concurrency lane and recheck `main` after waiting, so a late older CI completion cannot cancel or overwrite a newer release.

The workflow also retains manual dispatch. Select the source ref in GitHub's **Run workflow** control, then set `branch`:

- `preview` (the default), or another valid branch name, builds that selected ref and creates a Cloudflare preview deployment.
- `main` publishes production only when the selected source is the current `main` commit and that exact SHA already has successful push-triggered CI. This validation prevents a manual run from bypassing CI.

The run summary records the source SHA, Pages branch, and public contract addresses baked into the bundle. GitHub documents why privileged [`workflow_run` jobs must not run untrusted source](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run); the workflow therefore checks the triggering repository, event, branch, conclusion and SHA before checkout. Cloudflare documents this prebuilt-asset flow as [Pages Direct Upload with continuous integration](https://developers.cloudflare.com/pages/how-to/use-direct-upload-with-continuous-integration/).

It needs two repository secrets:

| Secret | Where to get it |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Cloudflare dashboard → My Profile → API Tokens, scoped to the correct account with **Cloudflare Pages: Edit**. Store only the token value, without the `Bearer` prefix. |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare dashboard → Workers & Pages, in the right-hand sidebar. |

Store both as GitHub Actions secrets available to this public repository. Each target maps to a GitHub environment (`production` / `preview`); environment protection rules can add approval gates independently of the source and CI checks above.
