# Shielded NIGHT frontend

A Vite, React and TypeScript dApp for converting unshielded NIGHT to shielded sNight and back. The public selector supports Preview and Preprod on Midnight 1.x plus Stagenet on Midnight 2.x.

## Setup

Install the app and both isolated protocol trees from the repository root:

```bash
bun install --frozen-lockfile
bun --cwd=frontend install --frozen-lockfile
npm --prefix frontend/protocols/v1 ci
npm --prefix frontend/protocols/v2 ci
bun --cwd=frontend run dev
```

Use **bun 1.4 or newer**: the committed `bun.lock` files are lockfile v2, which older bun cannot read (`Unknown lockfile version`), and bun 1.4 requires the `--cwd=<dir>` spelling — written with a space it prints its usage text and exits 0 without installing or running anything. CI installs the latest bun.

The development server listens on `http://localhost:5173`. The repository must contain the full v1 artifacts in `src/managed` and v2 artifacts in `contracts/v2/managed`.

## Network configuration

`frontend/.env` contains only public contract addresses and is committed:

| Variable | Selector | Protocol |
| --- | --- | --- |
| `PREVIEW_ADDRESS` | Preview | Midnight 1.x |
| `PREPROD_ADDRESS` | Preprod | Midnight 1.x |
| `STAGENET_ADDRESS` | Stagenet | Midnight 2.x |
| `UNDEPLOYED_ADDRESS` | Local (development only) | Midnight 1.x by default, 2.x with `UNDEPLOYED_PROTOCOL` |

Preview, Preprod and Stagenet always appear. A missing or malformed address displays an unavailable state and blocks wallet connection and transactions. Local appears in development or when its address is explicitly configured.

The wallet supplies its network, indexer and proving capabilities. The app verifies the wallet network throughout the operation and delegates proving, transaction balancing and submission to the wallet. It submits the exact balanced bytes returned by the wallet.

### Local protocol selection (`UNDEPLOYED_PROTOCOL`)

Preview, Preprod and Stagenet are pinned to the ledger generation their chain runs. `undeployed` is not a chain but whichever devnet is on the other end, so its protocol family is a setting:

| Value | Effect |
| --- | --- |
| unset (default) | `Local (undeployed)`, Midnight 1.x — today's behavior |
| `midnight-1.x` | the same, stated explicitly |
| `midnight-2.x` | `Local (undeployed · 2.x)`, the v2 (ledger-v9) adapter |
| anything else | the page reports the invalid value and blocks connecting; no silent fallback |

It is read exactly like the contract addresses: baked in at `vite build` from the environment (the `UNDEPLOYED_` prefix in `vite.config.ts` exposes it), and overridable at runtime by `window.SHIELDED_NIGHT.UNDEPLOYED_PROTOCOL` (a non-blank runtime value wins; a blank one falls through to the build-time value). Values are trimmed and case-sensitive.

```bash
UNDEPLOYED_PROTOCOL=midnight-2.x bun --cwd=frontend run build   # build-time, from the repository root
```

The page is only one half of the switch: the contract it talks to has to come from the matching lane too, which is `MN_ENV=undeployed bun run deploy:v2` for `midnight-2.x` and `MN_ENV=undeployed bun run scripts/deploy.ts` for the 1.x default. The root [README](../README.md#which-lane-runs-where) has the table and the local 2.x recipe.

The wallet never announces its own ledger generation, so a mismatch (a Midnight 1.x wallet on a `midnight-2.x` local network, or the reverse) can only fail once the adapter runs; the activity log then names the configured family and what to change.

### Runtime configuration override

`index.html` loads `public/config.js` before the module bundle. A stack may replace its no-op value at container startup:

```js
window.SHIELDED_NIGHT = {
  UNDEPLOYED_PROTOCOL: "midnight-2.x",
  UNDEPLOYED_ADDRESS: "0123…",
};
```

The supported keys are `PREVIEW_ADDRESS`, `PREPROD_ADDRESS`, `STAGENET_ADDRESS`, `UNDEPLOYED_ADDRESS` and `UNDEPLOYED_PROTOCOL`. A non-blank runtime value wins over its build-time value; a blank one falls through to the build-time value. Only public addresses and that protocol switch are injectable; secrets remain outside the frontend.

## Protocol isolation

The two ledger generations use incompatible runtime and WASM class identities. `protocols/v1` and `protocols/v2` therefore have independent package manifests, lockfiles and adapters. The UI talks to their shared protocol-neutral session interface and lazy-loads only the adapter selected for the wallet connection.

The production build contains four distinct runtime assets: v1 and v2 ledger WASM plus v1 and v2 on-chain runtime WASM. Vite also copies the complete proving trees to:

- `/contract/v1/shielded-night`
- `/contract/v2/shielded-night`
- `/contract/compiled/shielded-night` (legacy v1 URL for already-open clients)

Each adapter resolves its path to an absolute URL from the page origin and the Vite base (`protocols/shared/asset-url.ts`) before handing it to the SDK, because `FetchZkConfigProvider` validates its argument with a bare `new URL()` and rejects a relative path with `Failed to construct 'URL': Invalid URL`.

The sNight token identity is derived inside the selected adapter with that generation's ledger package.

## Conversion and switching behavior

Each normal conversion calls an atomic circuit and uses one wallet approval:

- NIGHT → sNight: `convertToShielded`
- sNight → NIGHT: `convertToUnshielded`

Changing the selector disposes the old protocol session, clears balances and operation state, and requires a new wallet connection. Generation guards ignore late callbacks from the old network. Wallet network checks before and after balancing and immediately before submission prevent an old session from submitting on the newly selected network. If submission has already started, any uncertain error retains the original transaction id and network association.

The unfinished-swaps panel remains able to resume deposits created by the older two-step UI. Recovery uses the selected protocol adapter and refuses records belonging to another contract.

### Reverse coin limitation

The connector exposes shielded balances by token and amount, without the nonce of each owned coin. `convertToUnshielded` must receive that exact nonce, color and value, so the frontend persists the deterministic coin candidate before forward wallet interaction and makes it spendable only after the contract returns the same coin. Reverse conversion therefore spends one whole coin minted and retained by this browser. Valid records from the older v1 two-step UI migrate into the scoped v1 store.

An uncertain forward or reverse submission keeps the coin record quarantined with its transaction id and network; it is not offered again automatically. A known pre-submission failure or wallet cancellation removes a pending forward candidate. sNight received from another wallet, previously minted by the atomic UI that discarded its result, or cleared from browser storage cannot be reversed until the wallet connector exposes coin-level details.

## Validation

```bash
bun --cwd=frontend run typecheck
bun --cwd=frontend run build
bun run test:unit -- test/unit/frontend-wallet-boundary.unit.test.ts test/unit/networks-protocol.unit.test.ts test/unit/runtime-config.unit.test.ts
```

CI additionally installs both protocol lockfiles on Linux, rebuilds both contract artifact trees with their pinned Compact compilers, checks byte-exact output and runs the Docker integration suite.
