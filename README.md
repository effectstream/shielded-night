# Shielded NIGHT

> **You are on the `ledger-v9` branch — the Midnight 2.x line.**
>
> | Branch | Midnight line | Toolchain | Stack | Status |
> |---|---|---|---|---|
> | `main` | **1.x** (preview / preprod / mainnet) | compactc 0.31.1, language 0.23, compact-runtime 0.16.0, `@midnight-ntwrk/ledger-v8` 8.1.0, midnight-js 4.1.1 | node 1.0.0 / indexer-standalone 4.3.3 / proof-server 8.1.0 | what https://shielded-night.pages.dev runs |
> | **`ledger-v9`** (here) | **2.x** | compactc **0.34.0**, language **0.26.0**, compact-runtime **0.19.0**, `@midnightntwrk/ledger-v9` 1.0.0-rc.3, midnight-js 5.0.0-beta.7 | node **2.0.0-rc.4** / indexer-standalone **4.4.0-rc.1** / proof-server **9.0.0-rc.5** | long-lived branch; **merged into `main` when the Midnight network moves to 2.x** |
>
> The two lines are kept separate on purpose: one dependency tree cannot hold both ledger
> wasm modules (two copies give two class identities and every cross-copy `instanceof`
> fails — the reason both `package.json`s carry an `overrides` block). Nothing in this
> branch is deployed to a public network; it targets a local `undeployed` devnet and the
> `midnight-2-offers` demo stack.
>
> **The contract source is unchanged apart from its `pragma language_version`, and all 33
> ZK artifacts (11 circuits × prover/verifier/bzkir) are byte-identical to the `main`
> build** — so the deployed preview contract's verifier keys remain valid; only the
> generated TypeScript bindings differ.

Convert native **unshielded NIGHT** into **shielded sNight** (a contract-minted wrapper token) and back, on Midnight.

Live (preview): https://shielded-night.pages.dev

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
│   └── deploy.yml                   # manual-only frontend deploy to Cloudflare Pages
├── TESTING.md
└── README.md
```

## How to run

The frontend is a Vite + React app that connects to any `window.midnight` wallet (e.g. Lace), reads your NIGHT/sNight balances, and runs the atomic one-transaction swaps (one wallet approval each way). Proving is delegated to the wallet.

```bash
cd frontend
bun install
bun run dev              # http://localhost:5173  (uses the committed .env)
```

Needs a Midnight wallet extension and the compiled artifacts in `src/managed/` (run `bun run compact` at the repo root if missing). Deploy details and the wallet-proving model are in [frontend/README.md](frontend/README.md).

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

## Locking the contract

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

The live preview contract is locked. To iterate, deploy a fresh instance and repoint the frontend.

## Verifying the deployment

Anyone can check, without trusting us, that (1) the deployed contract is exactly the code in this repo and (2) it can never be changed. Both checks are read-only - no wallet or seed needed.

### 1. Reproduce the compiled artifacts byte-for-byte

The compiler output is deterministic and the contract pins its language version (`pragma language_version 0.26` on this branch; `0.23` on `main`), so compiling [src/shielded-night.compact](src/shielded-night.compact) with the pinned toolchain reproduces [src/managed/](src/managed/) exactly:

```bash
# Install the Compact toolchain (once): https://docs.midnight.network/relnotes/compact-tools
compact update 0.34.0      # toolchain 0.34.0 = compactc 0.34.0, language 0.26.0, runtime 0.19.0, ledger 9

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
| **Unit tests** | Every circuit against the in-memory simulator, plus a repo-wide typecheck. Seconds. |
| **Frontend** | `tsc --noEmit` and a real `vite build`. Installs **both** the root and frontend dependency trees on purpose — the compiled contract is imported from outside the frontend package root, so that is the only way the `resolve.dedupe` protection against duplicate WASM instances is actually exercised rather than bypassed. |
| **Byte-exact rebuild** | Deletes `src/managed/`, recompiles `src/shielded-night.compact` into the empty tree, and asserts the result is identical to what was committed. Deliberately uncached, and deliberately deleting first — either shortcut would let the job compare the artifacts against themselves and pass without verifying anything. This is what backs the verifiability claim above. ~15s. |
| **Integration tests** | Full docker stack: node + indexer + proof server. |

[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) builds the frontend and ships it to Cloudflare Pages. It is **`workflow_dispatch` only** — nothing deploys on a merge. The `branch` input picks the target: `main` is the production URL, anything else (default `preview`) gets a throwaway preview URL. The run summary records the contract addresses baked into the bundle.

It needs two repository secrets:

| Secret | Where to get it |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Cloudflare dashboard → My Profile → API Tokens, using the **Edit Cloudflare Workers** template (Pages deploys use the same permission). |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare dashboard → Workers & Pages, in the right-hand sidebar. |

Each `branch` value maps to a GitHub environment (`production` / `preview`), so production deploys can be put behind required reviewers in the repo's environment settings.
