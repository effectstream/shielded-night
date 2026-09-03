# Testing

Two tiers, modeled on the OpenZeppelin compact-contracts and midnight-canary
reference suites:

| Tier | What runs | Infrastructure | Wall clock |
| --- | --- | --- | --- |
| Unit (simulator) | Every circuit against an in-memory `CircuitContext` | none | seconds |
| Integration (docker) | Real deploys + balanced transactions via a genesis wallet | docker: node, indexer, proof server | minutes |

## Prerequisites

- Node 22+ (vitest runs under Node; bun is the package manager)
- `bun install`
- The `compact` CLI (this branch's scripts pin compiler `0.34.0`; `main` pins `0.31.1`)
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
(`envs/docker-compose-dynamic.yml`: on this `ledger-v9` branch midnight-node
2.0.0-rc.4, indexer-standalone 4.4.0-rc.1, proof-server 9.0.0-rc.5 — the Midnight
2.x triple; `main` runs 1.0.0 / 4.3.3 / 8.1.0) via testcontainers, then the suite deploys the
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
pins the fixed behavior on the current stack (on `main`, toolchain 0.31.101 /
ledger-v8 8.1.0; on `ledger-v9`, toolchain 0.34.0 / ledger-v9 1.0.0-rc.3): the transaction applies, the credit equals the coin value, the **wallet
sees the coin as spent** (the historical bug left the spent UTXO listed as
spendable, corrupting wallet state), and the credit withdraws again cleanly.

## Known sharp edges

- `getBalance(secret)` **throws** for a never-used secret (`balances.lookup`
  without a `member` guard). Off-chain callers must probe `balances.member`
  first. Pinned by tests in both tiers.
- `depositShielded` requires the wallet to spend the *exact* `coin` passed as
  the circuit argument. The round-trip test retains the coin returned by
  `withdrawShielded` and passes it back verbatim.
- The historical live e2e (pre-git, different monorepo) is documented in
  [README.md](README.md) under "Live status".
