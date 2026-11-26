# deploy/ — putting the CryptoSure contracts on a Midnight network

Everything else in this repository runs the contracts on a stand-in inside one
program (`protocol/local-chain.mjs`). This folder is the tooling that sends them
to a **real Midnight network with real zero-knowledge proofs**: it builds a wallet
from a seed, deploys the eight contracts, wires them together, and clears one
holder.

It has its own `package.json` so the repository root stays dependency-light.

> **Where things stand (26 Nov 2026).** The whole flow has been run end to end on
> a **local rehearsal chain** (same node, indexer and proof server versions as the
> public networks, real proofs, real cross-contract calls). It has **not** been
> deployed to **Preview** yet, for one reason: the deployer wallet has no tNIGHT
> there, and the faucet needs a person to complete a captcha.
> Address to fund: `mn_addr_preview17jsz4gpr2t3qsw3nmw2hert4tc0ltu84d86lnc45rjgv4cp8muwsxqpqgh`
> See [What has actually been run](#what-has-actually-been-run).

## The pieces, in plain words

| Piece | What it is | Where it runs |
| --- | --- | --- |
| **Node** | The blockchain itself. Receives transactions. | Midnight's servers (Preview) |
| **Indexer** | A searchable copy of the chain. We read contract state and confirm transactions through it. | Midnight's servers (Preview) |
| **Proof server** | Turns private inputs into zero-knowledge proofs. Private data is sent to it, so it runs **on this computer**. | Docker, port 6300 |
| **Wallet** | Holds the keys, pays fees, signs. Here it is "headless": a program, no browser. | Inside our scripts |
| **NIGHT / DUST** | NIGHT is the token. DUST pays fees and is *generated* over time by NIGHT that has been registered. | On-chain |

## Before you start

1. **Node 22 or newer** (`node -v`).
2. **The contracts compiled with keys.** If `../build/` is missing, run `npm run compile` in the repository root (about a minute).
3. **Install this folder's packages** (exact, pinned versions):
   ```bash
   cd deploy
   npm ci          # "ci" = clean install, exactly what package-lock.json says
   ```
4. **The deployer seed file.** A file *outside the repository* whose last line is the wallet's 64-hex-character seed. The scripts read the path from `CRYPTOSURE_DEPLOYER_SEED_FILE` (default `/home/js/utils_Midnight/preProd-Wallets/tdust-secrets/sarah.seed`). The seed is never printed, logged or written anywhere by these scripts.
5. **Start the proof server** (once; it keeps running):
   ```bash
   # -d            run in the background ("detached")
   # --name        a name so we can refer to it later
   # -p 127.0.0.1:6300:6300   reachable only from this computer, on port 6300
   # -v            verbose logging (an option of midnight-proof-server itself)
   docker run -d --name cryptosure-proof-server -p 127.0.0.1:6300:6300 \
     midnightntwrk/proof-server:9.0.2 midnight-proof-server -v

   curl http://127.0.0.1:6300/health      # {"status":"ok",...} means it is ready
   ```
   Later: `docker stop cryptosure-proof-server` to stop it, `docker start cryptosure-proof-server` to start it again, `docker logs cryptosure-proof-server` to read its log.
   (Proof server 9.x takes no `--network` argument; older versions did.)

Optional settings are listed in [`.env.example`](.env.example). Copy it to `.env` (git-ignored) if you need any; the npm scripts load `.env` when it exists.

## The steps

Run these from the `deploy/` folder. Each one says what it needs and what it changes.

### 1. `npm run check-address` — is this the same wallet as before?

Needs: the seed file. Uses no network. Changes nothing.

Derives the wallet's unshielded address with Wallet SDK 2.x and compares it with the address the old SDK 1.2.0 derived from the same seed. Prints `MATCH` or `MISMATCH`, then the Preview address.

### 2. `npm run status` — where are we?

Needs: the seed file; the network for balances. Changes nothing.

Prints the deployer address, whether the proof server is healthy, the NIGHT and DUST balances, and what `deployments/<network>.json` says is deployed. Add `-- --offline` to skip the chain sync.

### 3. Fund the wallet (a person does this, once)

Open <https://midnight-tmnight-preview.nethermind.dev/>, paste the Preview address from step 1, complete the captcha, request tokens. There is no captcha-free faucet API (Midnight's docs, "Funding a wallet", describe the captcha step), and the scripts do not try to get around it.

### 4. `npm run deploy:first` — one contract first

Needs: proof server, funded wallet. Sends 1 transaction (2 if the wallet must first register for DUST).

Deploys only `BanListCheck` and stops, so you can confirm the whole pipeline (prove, pay, submit, indexer confirms) before spending time on the rest. If the wallet has NIGHT but no DUST, the script first registers the NIGHT for DUST generation and waits up to 10 minutes; if DUST still has not appeared it stops and tells you to run it again later.

### 5. `npm run deploy` — the rest, and the wiring

Needs: proof server, funded wallet. Sends up to 8 deploys + 19 wiring transactions (about 20 seconds each on the local chain; expect longer on Preview).

**Resumable:** after every confirmed step it saves `deployments/<network>.json`. If anything fails, run the same command again: finished steps are skipped.

Exit codes: `0` done, `2` "a person must do something first" (fund the wallet, start the proof server, wait for DUST), `1` a real failure.

### 6. `npm run clearance` — clear one holder

Needs: a fully deployed program. Sends 5 transactions for the "basic" profile:

| # | Contract.circuit | Who | What |
| --- | --- | --- | --- |
| 1 | `BanListCheck.record_screening` | operator | seals the provider's answer |
| 2 | `BanListCheck.prove_not_listed` | holder | proves it, collects a pass |
| 3 | `WalletControlCheck.record_control_attestation` | operator | seals the attestation |
| 4 | `WalletControlCheck.prove_wallet_control` | holder | proves it, collects a pass |
| 5 | `ClearanceRegistry.grant_clearance` | anyone | **cross-contract**: the registry calls `require_pass` on each check |

Options: `-- --standard` also clears the "standard" profile (6 more transactions); `-- --bind-policy` also binds a `cover-standard` policy (2 more, `bind_policy` is cross-contract too); `-- --subject <id>` picks another person from `fixtures/mock-subjects.json`.

The off-chain answers are still **mock** (`protocol/providers/mock-providers.mjs`); the contracts, proofs and transactions are real. The protocol code (`protocol/clearance.mjs`, `protocol/bind-policy.mjs`) runs unchanged: `src/network-chain.mjs` gives it the same operations as the local stand-in.

### `npm test`

28 tests, no network needed: the wallet signer (15), the browser-connector adapter against a fake wallet (5), and the tooling (8).

## Rehearsing on a local chain

A private one-node Midnight chain in Docker, with a wallet funded at genesis, so no faucet is needed. This is how the scripts were exercised.

```bash
npm run local:up                               # start node + indexer, wait until healthy
npm run deploy -- --network local              # 27 transactions, about 6 minutes
npm run clearance -- --network local --standard --bind-policy
npm run local:down                             # stop it and erase the local chain and its record
```

On the local network the scripts use the publicly known genesis test seed (see `src/config.mjs`), not your seed file. The proof server is the same container as above.

## What has actually been run

Dates are 26 Nov 2026 (UTC). "Confirmed" means Midnight.js returned only after the indexer reported the transaction in a block with status `SucceedEntirely`.

| What | Preview | Local rehearsal chain | Notes |
| --- | --- | --- | --- |
| Address check (SDK 2.x vs 1.2.0, preprod) | **MATCH** | n/a | offline |
| Proof server 9.0.2 healthy | yes | yes | `/health` ok, `/version` 9.0.2 |
| Wallet sync and balance read | **yes: 0 NIGHT, 0 DUST** | yes | |
| Faucet funding | **NOT DONE** (captcha) | n/a | needs a person |
| DUST registration step | **NOT RUN** | **NOT RUN** (genesis wallet already had DUST) | written from the SDK's types and the official example; untested |
| Deploy `BanListCheck` first | **NOT DONE** (no funds) | confirmed | |
| Deploy all 8 contracts | **NOT DONE** | confirmed | |
| 19 wiring transactions | **NOT DONE** | confirmed | |
| Resume after a failure | **NOT DONE** | confirmed (the indexer died mid-run; the rerun skipped 9 finished steps) | |
| "basic" clearance incl. `grant_clearance` (calls 2 contracts) | **NOT DONE** | confirmed | cross-contract |
| "standard" clearance, `grant_clearance` (calls 5 contracts) | **NOT DONE** | confirmed | six contracts in one transaction |
| `bind_policy` + `prove_binding` | **NOT DONE** | confirmed | cross-contract |
| Preprod (Blockfrost) | **UNTESTED** | | URL shapes are from a brief, WebSocket URLs are a guess |
| Headless wallet signing + verification | 15 tests pass | | offline |
| Browser wallet signing adapter | **UNTESTED-IN-BROWSER** | | 5 tests against a fake wallet only |

The local chain was erased afterwards, so its addresses and transaction ids no longer exist anywhere.

## Versions

Pinned exactly (`npm install --save-exact`), taken from Midnight's compatibility matrix (`docs/relnotes/support-matrix.json` in `midnightntwrk/midnight-docs`), read on 26 Nov 2026. All networks run ledger 9.

| Component | Version |
| --- | --- |
| Compact compiler / language | 0.36.1 / 0.28.0 (what `../build` was compiled with) |
| `@midnight-ntwrk/compact-runtime` | 0.21.0 |
| `@midnight-ntwrk/compact-js` | 3.0.2 |
| `@midnight-ntwrk/midnight-js` and the `midnight-js-*` packages | 5.0.1 |
| `@midnightntwrk/wallet-sdk` | 2.0.1 |
| `@midnightntwrk/ledger-v9` | 1.0.2 |
| `@midnightntwrk/dapp-connector-api` | 4.1.0 |
| Proof server (Docker) | `midnightntwrk/proof-server:9.0.2` |
| Local rehearsal only: node / indexer (Docker) | `midnightntwrk/midnight-node:2.1.101` / `midnightntwrk/indexer-standalone:4.4.101` |
| Test only: `@noble/curves` | 2.4.0 (independent check of the signature format) |

Note the two npm scopes: `@midnight-ntwrk/` (with a hyphen) for Midnight.js and Compact, `@midnightntwrk/` (no hyphen) for the wallet SDK, ledger and connector. Newer `midnight-js` 5.0.2/5.0.3 packages exist under the no-hyphen scope; the matrix still names 5.0.1 under the hyphenated scope, so that is what is installed.

## Things to know before trusting a deployment

- **Demo admin and operator keys.** The contracts' admin and operator keys are derived from fixed labels (`protocol/encoding.mjs`, `deriveDemoSecretKey`), as in the local demo. Anyone who reads this repository can derive them and act as admin of the deployed contracts. Fine for a rehearsal on a test network; not for anything that matters. See the `IDEA` in `src/network-program.mjs`.
- **The private-state database** (`.local-state/<network>/`, git-ignored) holds each contract's maintenance key, encrypted with a password derived from the seed. Deleting it does not affect the deployed contracts' normal operation, but the maintenance keys in it cannot be recreated.
- **Noise.** The wallet SDK prints `RPC-CORE: ... disconnected ... Normal Closure` lines and occasional `level=WARN` lines while it works. They are not failures.
- **Time.** Contracts check "issued at" against the block's time. The scripts report "now" as the computer's clock minus 30 seconds so a slightly fast clock does not cause a refusal.
- **Witnesses are a copy.** `src/witnesses.mjs` repeats the table in `protocol/local-chain.mjs` because that file does not export it. A test checks the copy covers every witness the compiled contracts declare.

## Wallet signatures (Goal 2)

`src/midnight-wallet-signer.mjs`:

- `createMidnightWalletSigner({ seedHex, networkId })` gives `{ address, sign(messageText) }`. `sign` returns `{ scheme, data, signature, verifyingKey }`, the same shape a browser wallet returns from the DApp Connector's `signData`.
- `verifyMidnightWalletSignature({ address, networkId, messageText, signed })` returns `true` only if the signature is valid **and** the verifying key is the one that owns that address on that network.

What is signed is `midnight_signed_message:<size in bytes>:` followed by the message, as the DApp Connector specification requires of wallets; the signature is BIP-340 Schnorr over the SHA-256 of those bytes (checked in the tests against an independent library).

`src/connector-wallet-signer.mjs` wraps a browser wallet's `signData` in the same `{ address, sign }` shape. It is **UNTESTED-IN-BROWSER**.

Neither is wired into the clearance flow yet: the mock wallet-control provider still checks stand-in keys.

## Files

| File | What it is |
| --- | --- |
| `src/config.mjs` | Network table (preview, local, preprod-UNTESTED), folders, environment variables |
| `src/seed-file.mjs` | Reads the seed from a file outside the repository; never prints it |
| `src/wallet.mjs` | Headless wallet: keys from a seed, sync, balances, DUST registration, clean shutdown |
| `src/witnesses.mjs` | The private-input functions the contracts ask for |
| `src/compiled-contracts.mjs` | Loads `../build/<Name>` for Midnight.js (and why a copy of the JS is made) |
| `src/providers.mjs` | The Midnight.js provider set, including what cross-contract calls need |
| `src/network-chain.mjs` | Network twin of `protocol/local-chain.mjs`: deploy, call, read state |
| `src/network-program.mjs` | The program as data: role holders, the 19 wiring steps |
| `src/deployment-record.mjs` | Reads and writes `deployments/<network>.json` |
| `src/session.mjs` | Opens wallet + providers + chain for a script; stops with instructions when a person is needed |
| `src/check-address.mjs` | Step 1 |
| `src/check-status.mjs` | Step 2 |
| `src/deploy-program.mjs` | Steps 4 and 5 |
| `src/run-one-clearance.mjs` | Step 6 |
| `src/midnight-wallet-signer.mjs` | Sign and verify with a real Midnight unshielded key |
| `src/connector-wallet-signer.mjs` | The same for a browser wallet (UNTESTED-IN-BROWSER) |
| `local-network/compose.yml` | The local rehearsal chain |
| `tests/*.test.mjs` | 28 tests, no network |
| `.env.example`, `.gitignore` | Optional settings; what must never be committed |
