# Shielded NIGHT frontend

A Vite, React and TypeScript dApp for converting unshielded NIGHT to shielded sNight and back. The public selector supports Preview and Preprod on Midnight 1.x plus Stagenet on Midnight 2.x.

## Setup

Install the app and both isolated protocol trees from the repository root:

```bash
bun install --frozen-lockfile
bun --cwd frontend install --frozen-lockfile
npm --prefix frontend/protocols/v1 ci
npm --prefix frontend/protocols/v2 ci
bun --cwd frontend run dev
```

The development server listens on `http://localhost:5173`. The repository must contain the full v1 artifacts in `src/managed` and v2 artifacts in `contracts/v2/managed`.

## Network configuration

`frontend/.env` contains only public contract addresses and is committed:

| Variable | Selector | Protocol |
| --- | --- | --- |
| `PREVIEW_ADDRESS` | Preview | Midnight 1.x |
| `PREPROD_ADDRESS` | Preprod | Midnight 1.x |
| `STAGENET_ADDRESS` | Stagenet | Midnight 2.x |
| `UNDEPLOYED_ADDRESS` | Local (development only) | Midnight 1.x |

Preview, Preprod and Stagenet always appear. A missing or malformed address displays an unavailable state and blocks wallet connection and transactions. Local appears in development or when its address is explicitly configured.

The wallet supplies its network, indexer and proving capabilities. The app verifies the wallet network throughout the operation and delegates proving, transaction balancing and submission to the wallet. It submits the exact balanced bytes returned by the wallet.

### Runtime address override

`index.html` loads `public/config.js` before the module bundle. A stack may replace its no-op value at container startup:

```js
window.SHIELDED_NIGHT = {
  UNDEPLOYED_ADDRESS: "0123…",
};
```

The supported keys are `PREVIEW_ADDRESS`, `PREPROD_ADDRESS`, `STAGENET_ADDRESS` and `UNDEPLOYED_ADDRESS`. A non-blank runtime value wins over its build-time value. Only public addresses are injectable; secrets remain outside the frontend.

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

### Reverse conversion and the coin store

`convertToUnshielded` claims its coin as an output addressed to the contract, and the wallet funds that output by ordinary shielded coin selection: inputs of the wrapper token totalling at least the amount, plus change. The nonce is chosen by this app and does not have to match a coin the wallet owns. Reverse conversion therefore works for **any amount up to the wallet's sNight balance**, whatever minted those coins — this browser, another browser, the other origin, or another wallet that sent them. The adapter builds a fresh random 32-byte nonce for the requested amount and checks the amount against `getShieldedBalances()` before any wallet interaction, so an over-large amount is reported as the wallet total instead of failing during balancing.

This is proven on chain, not inferred: [test/integration/shielded-night.reverse-any-amount.test.ts](../test/integration/shielded-night.reverse-any-amount.test.ts) reverses half of a minted coin, then the wallet's own change coin, then the merged value of two separately minted coins — each with a fresh nonce — and shows the only remaining failure is `Wallet.InsufficientFunds`.

The browser coin store is **not** the set of reversible coins. It records what this browser minted (so a forward conversion's exact coin is never fabricated) and carries the older v1 two-step UI's records, which still resume through it; valid legacy records migrate into the scoped v1 store. An uncertain forward submission keeps its minted record quarantined with the transaction id and network, and a known pre-submission failure or wallet cancellation removes a pending forward candidate. An uncertain reverse submission is reported with its transaction id and must not be retried blindly — a retry converts more sNight.

## Validation

```bash
bun --cwd frontend run typecheck
bun --cwd frontend run build
bun run test:unit -- test/unit/frontend-wallet-boundary.unit.test.ts test/unit/runtime-config.unit.test.ts
```

CI additionally installs both protocol lockfiles on Linux, rebuilds both contract artifact trees with their pinned Compact compilers, checks byte-exact output and runs the Docker integration suite.
