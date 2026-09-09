# Testing

Two tiers, modeled on the OpenZeppelin compact-contracts and midnight-canary
reference suites:

| Tier | What runs | Infrastructure | Wall clock |
| --- | --- | --- | --- |
| Unit (simulator) | Every circuit against an in-memory `CircuitContext` | none | seconds |
| Integration (docker) | Real deploys + balanced transactions via a genesis wallet | docker: node, indexer, proof server | minutes |

The compiler-0.34.0 / ledger-v9 tree in `contracts/v2` mirrors both, one tier at
a time: `bun run test:v2` is its chain-free unit tier (what CI runs) and
`bun run test:v2:external` is its round-trip suite against a Midnight 2.x stack
you already started — see [the 2.x lane's external-stack suite](#the-2x-lanes-external-stack-suite-contractsv2) below.

## Prerequisites

- Node 22+ (vitest runs under Node; bun is the package manager)
- bun 1.4 or newer — the committed `bun.lock` files are lockfile v2 and older
  bun cannot read them, and `--cwd` needs its `=` form (`bun --cwd=frontend …`)
  or bun 1.4 prints usage and exits 0 without running the command
- `bun install`
- The `compact` CLI (the root scripts pin compiler `0.31.1`; the `contracts/v2`
  tree pins `0.34.0`)
- Docker running (integration tier only)

## Unit tests

```bash
bun run compact:fast   # compile contract JS only (--skip-zk, no prover keys)
bun run test:unit
```

Besides the contract simulator suites, this tier also covers the chain-free
script policies: the runtime address override, the network env-var overrides,
the deploy record, and the verifier's `--allow-unlocked` exit-code policy
([test/unit/verify-args.unit.test.ts](test/unit/verify-args.unit.test.ts)).

The simulator ([test/unit/simulators/ShieldedNightSimulator.ts](test/unit/simulators/ShieldedNightSimulator.ts))
executes the compiled circuits directly: state assertions are exact and failed
calls throw the contract's `assert` messages. Token movements are recorded as
transaction effects, not balanced against a real ledger — that's the
integration tier's job.

## Integration tests

```bash
bun run compact        # full compile including prover/verifier keys
bun run test:integration
```

`test/integration/global-setup.ts` boots the docker stack
(`envs/docker-compose-dynamic.yml`: midnight-node 1.0.0, indexer-standalone
4.3.3, proof-server 8.1.0) via testcontainers, then the suite deploys the
contract with the genesis wallet and runs the full README round trip
(depositUnshielded → withdrawShielded → depositShielded → withdrawUnshielded),
the negative paths, and a two-wallet independence test.

The first run pulls the images (the proof server is multi-GB). Tests run
serially (`fileParallelism: false`) with `retry: 2` — transient wallet-sync /
DUST-funding races on a freshly booted stack are a known flaky tail.

Only the `[smoke]`-tagged subset:

```bash
bun run smoke
```

### Environment variables

| Var | Default | Meaning |
| --- | --- | --- |
| `MN_ENV` | `undeployed` | `undeployed` boots the local stack; `preprod`/`preview`/`qanet` run against hosted networks (requires `MN_SEED`, boots only a local proof server) |
| `MN_SEED` | genesis seed on `undeployed` | wallet seed for hosted envs; stays optional on `undeployed`, including in external-stack mode |
| `MN_TEST_RETRY` | `2` | vitest retry count |
| `MN_EXTERNAL_STACK` | unset | `1` = run against an already-running stack instead of booting one (see below) |
| `MN_INDEXER_URL` | `http://127.0.0.1:8088/api/v4/graphql` | indexer endpoint (`undeployed` only) |
| `MN_INDEXER_WS_URL` | `ws://127.0.0.1:8088/api/v4/graphql/ws` | indexer subscription endpoint (`undeployed` only) |
| `MN_NODE_URL` | `http://127.0.0.1:9944` | node RPC endpoint (`undeployed` only) |
| `MN_PROOF_SERVER_URL` | `http://127.0.0.1:6300` | proof server endpoint — the one override that also applies to the hosted envs, whose proof server is your own |

The four URL vars are resolved by `networkFor()` in
[test/support/network.ts](test/support/network.ts), so they steer the deploy /
lock / verify scripts too:

```bash
MN_ENV=undeployed MN_NODE_URL=http://127.0.0.1:31944 \
  MN_INDEXER_URL=http://127.0.0.1:31088/api/v4/graphql \
  MN_INDEXER_WS_URL=ws://127.0.0.1:31088/api/v4/graphql/ws \
  MN_PROOF_SERVER_URL=http://127.0.0.1:31300 \
  bun run scripts/deploy.ts
```

On the hosted envs only `MN_PROOF_SERVER_URL` is honoured: the indexer and node
URLs identify the network itself, and silently repointing `preview` at a local
indexer because a variable was left exported would be an expensive, invisible
bug.

### Verifying a deployment as a gate: `--allow-unlocked`

`scripts/verify-deployment.ts` is the strongest check a stack can run — it
proves the ZK artifacts the page serves are the rules the chain enforces — and
it is meant to be read as an **exit code** from a compose one-shot, not parsed
from stdout.

By default it asserts two things and exits 0 only if both hold: the verifier
keys match, **and** the contract is locked. A devnet contract is deliberately
never locked (`SHIELDED_NIGHT_LOCK=false`), so the default run exits 1 on a
perfectly healthy stack. Pass `--allow-unlocked` there:

```bash
# strict (hosted release): unlocked => exit 1
MN_ENV=preprod CV_ADDRESS=<addr> bun run verify:deployment

# devnet gate: lock state reported, exit code = the verifier-key check only
MN_ENV=undeployed CV_ADDRESS=<addr> bun run verify:deployment -- --allow-unlocked
```

| | keys match | key mismatch / missing / extra circuit |
| --- | --- | --- |
| **locked**, no flag | exit 0 | exit 1 |
| **unlocked**, no flag | exit 1 | exit 1 |
| **locked**, `--allow-unlocked` | exit 0 | exit 1 |
| **unlocked**, `--allow-unlocked` | exit 0 | **exit 1** |

The flag only ever changes what an *unlocked* contract does to the exit code;
it never relaxes the key check. The policy itself is unit-tested in
[test/unit/verify-args.unit.test.ts](test/unit/verify-args.unit.test.ts)
against [scripts/verify-args.ts](scripts/verify-args.ts), so no chain is needed
to prove the table above. Unknown arguments are rejected, so a typo fails
loudly instead of silently reverting to strict.

### Running against a stack you already have (`MN_EXTERNAL_STACK=1`)

The default is unchanged and is what CI runs: the suite owns its stack, so a
green run proves the contract against a known-clean devnet. External mode is for
the other direction — running the SAME suite against a stack somebody else
brought up (a compose deployment of this dApp, a devnet on non-default ports, a
container with no docker socket of its own). testcontainers is skipped, the URLs
above are used as-is, and **the stack is never torn down** (we do not stop what
we did not start):

```bash
MN_EXTERNAL_STACK=1 MN_ENV=undeployed \
  MN_INDEXER_URL=http://indexer:8088/api/v4/graphql \
  MN_INDEXER_WS_URL=ws://indexer:8088/api/v4/graphql/ws \
  MN_NODE_URL=http://node:9944 \
  MN_PROOF_SERVER_URL=http://proof-server:6300 \
  bun run test:integration       # or: bun run smoke
```

Global setup preflights the three HTTP endpoints and fails immediately, naming
the URL that is wrong, rather than letting a misconfiguration surface ten
minutes later as a wallet-sync timeout. `MN_SEED` stays optional on
`undeployed` (the genesis seed is the default) — set it when that seed belongs
to another facade on the target stack.

The suite deploys contracts and spends from the genesis-funded seeds, so point
it only at a throwaway devnet.

### Provider wiring note

`test/support/provider-wiring.ts` balances transactions with
`balanceUnboundTransaction → signRecipe → finalizeRecipe` (canary's pattern).
This is required: binding first (`tx.bind()` + `balanceFinalizedTransaction`)
locks the transaction structure so the wallet can't attach the unshielded UTXO
input that `receiveUnshielded` needs — deposits would fail with
`BalanceCheckOverspend` (see README, "The balancing fix").

### The 2.x lane's external-stack suite (`contracts/v2`)

The compiler-0.34.0 / ledger-v9 tree has its own round-trip suite. It is the
2.x counterpart of `MN_EXTERNAL_STACK=1` above, with one difference: there is no
self-booting mode. This tree carries no 2.x compose file, so the suite **only**
ever joins a stack you already started, and its global setup refuses to run
without `MN_EXTERNAL_STACK`, naming the variable. Nothing is ever torn down.

```bash
MN_EXTERNAL_STACK=1 MN_ENV=undeployed \
  MN_SEED=<funded devnet seed> \
  MN_INDEXER_URL=http://127.0.0.1:8088/api/v4/graphql \
  MN_INDEXER_WS_URL=ws://127.0.0.1:8088/api/v4/graphql/ws \
  MN_NODE_URL=http://127.0.0.1:9944 \
  MN_NODE_WS_URL=ws://127.0.0.1:9944 \
  MN_PROOF_SERVER_URL=http://127.0.0.1:6300 \
  bun run test:v2:external      # = npm --prefix contracts/v2 run test:external
```

- `MN_ENV` defaults to `undeployed` **here** (the deploy/verify scripts default
  to `stagenet`); `stagenet` is accepted but then `MN_SEED` is mandatory.
- `MN_SEED` is optional on `undeployed` only: without it the suite uses the
  shared genesis-1 devnet seed and says so loudly. Pass a dedicated seed for
  anything you keep.
- `CV_ADDRESS` is optional. Set, the suite joins that deployment; unset, it
  deploys a fresh contract with a maintenance key sampled for the run.
- Global setup preflights the indexer/node/proof-server with a 10-second fetch
  and fails immediately naming the URL that is wrong.
- The same five `MN_*_URL` variables steer `bun run deploy:v2` and
  `bun run verify:deployment:v2` when `MN_ENV=undeployed`, so the suite and the
  deployment it drives share one env block — the README's
  [local 2.x recipe](README.md#when-that-local-devnet-is-a-midnight-2x-chain)
  runs all three commands in order.

What it asserts, against the chain:

1. the deployed (or joined) contract serves the 11-circuit set with verifier
   keys byte-equal to `contracts/v2/managed/keys/`, the release metadata
   (`Shielded Night` / `sNight` / 6), and — for a contract it deployed itself —
   the run's sampled key as the sole maintenance authority;
2. the two-step round trip `depositUnshielded → withdrawShielded →
   depositShielded → withdrawUnshielded`, with EXACT NIGHT and wrapper balances
   after every step;
3. the atomic pair `convertToShielded` / `convertToUnshielded` (the circuits the
   SPA drives), again with exact balances;
4. a wrong-secret withdrawal is refused with `no balance for this secret`, and
   the rightful secret still redeems the credit.

The suite deploys contracts and spends from the seed it is given: **point it
only at a throwaway devnet.**

The unit tier is unaffected. `bun run test:v2` runs
`vitest --config contracts/v2/vitest.config.ts`, whose include pattern and
exclude list both keep `test/external/**` out, so CI's `unit-v2` job never
collects a test that needs a chain. There is no CI job for the 2.x external
suite, exactly as there is none for the 1.x external mode.

## CI

`.github/workflows/ci.yml`:

- **unit** — every push/PR: compile (`--skip-zk`), typecheck, unit tests.
- **integration** — every push/PR (40-min cap): full compile (cached on
  contract hash + compiler version), docker stack, full suite. If this proves
  slow or flaky on shared runners, demote PRs to `bun run smoke` and keep the
  full suite on main + a nightly schedule.

## Security suite

Both tiers carry a dedicated security/border-case suite for the
token-loss and token-theft vectors:

- **Unit** ([test/unit/shielded-night.security.unit.test.ts](test/unit/shielded-night.security.unit.test.ts)):
  value-range boundaries (max single deposit, encode-level range rejection,
  the zswap 2^64−1 coin-value cap, credit accumulation past 2^64 without
  wrapping), exact-balance withdrawal boundaries, balance-key isolation
  (zero secret, one-bit-different secrets), the zero-recipient guards, and
  state integrity after failed calls.
- **Integration** ([test/integration/shielded-night.security.test.ts](test/integration/shielded-night.security.test.ts)):
  ledger-enforced properties the simulator cannot falsify — forged
  (never-minted) coins, inflated coin values, double-burns of a spent coin,
  nonce-reuse double-mints (duplicate commitment), the reserve invariant
  (locked NIGHT == credits + outstanding wrapper), and a cross-wallet theft
  attempt (burning someone else's coin).

The contract asserts `"invalid recipient"` on all-zero withdrawal targets:
an all-zero coin public key is Midnight's burn representation, so minting to
it would irrecoverably destroy the wrapper while its backing NIGHT stayed
locked (this guard was added by this suite; see git history).

## Burn transient (`depositShielded`)

`depositShielded` receives the exact wrapper coin the wallet sends and burns it
via `sendImmediateShielded` in the same transaction (a transient), so the
wrapper supply is elastic both ways: minted on withdraw, burnt on deposit.
[test/integration/shielded-night.transient.test.ts](test/integration/shielded-night.transient.test.ts)
pins the fixed behavior on the current stack (toolchain 0.31.101 / ledger-v8
8.1.0): the transaction applies, the credit equals the coin value, the **wallet
sees the coin as spent** (the historical bug left the spent UTXO listed as
spendable, corrupting wallet state), and the credit withdraws again cleanly.

## Known sharp edges

- `getBalance(secret)` **throws** for a never-used secret (`balances.lookup`
  without a `member` guard). Off-chain callers must probe `balances.member`
  first. Pinned by tests in both tiers.
- `depositShielded` and `convertToUnshielded` do **not** require the wallet to
  own the `coin` passed as the circuit argument. `receive` claims that coin as
  an output addressed to the contract, and the wallet funds it from its own
  wrapper balance (inputs + change), so what is required is *enough sNight*,
  not that exact coin — any nonce and any value up to the balance balances.
  The round-trip test passes back the coin `withdrawShielded` returned because
  that is convenient, not because it is necessary;
  [test/integration/shielded-night.reverse-any-amount.test.ts](test/integration/shielded-night.reverse-any-amount.test.ts)
  reverses fractions, a wallet change coin and two merged coins with fresh
  random nonces, and shows the only failure mode is `Wallet.InsufficientFunds`.
- The historical live e2e (pre-git, different monorepo) is documented in
  [README.md](README.md) under "Live status".
