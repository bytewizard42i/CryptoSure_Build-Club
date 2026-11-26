# Deploying large contracts: the block-write limit, what we measured, what we did

> A note for Jay (and anyone else reviewing the deployment tooling).
> Written Nov 26 2026, corrected the same day after Midnight's own runbook
> and live measurement set the diagnosis straight. Where something is
> inference rather than observation, it says so.

## The short version

A Midnight block allows **50,000 bytes of persistent writes**, and a single
transaction may use only about 65% of that (~32 KB), because normal
transactions share the block with inherents and initialization weight. A
contract deployment writes **one verifier key (~2 KB) for every exported
impure circuit**, plus its initial ledger state. A contract with enough
circuits simply does not fit in one transaction, and the node refuses it at
validation with:

```
1010: Invalid Transaction: Transaction would exhaust the block limits
```

The limits are identical on mainnet, preprod, preview and the local dev
chain (`block_limits.bytesWritten = 50,000`), so a contract that is too big
is too big everywhere. This is documented in Midnight's own runbook
("Deploying a contract too large for one block", in the midnightntwrk
servicedesk repo), which we found after measuring the same threshold
ourselves: their 40-circuit test contract passed at 14 circuits (~31 KB
written) and failed at 15 (~34 KB).

## What we measured here

| Contract | exported circuits | verifier-key bytes | deployed on Preview? |
|---|---|---|---|
| BanListCheck | 11 | 22.5 KB | yes — block 282,488 |
| IdentityCheck, EducationCheck, WalletControlCheck | 10 each | 20.4 KB | fit comfortably |
| ClearanceRegistry, PolicyBinder | 7 | 14.8 KB | fit comfortably |
| PairReceipt | 6 | 12.0 KB | fits comfortably |
| **RegionCheck** | **12** | **24.7 KB** | **refused, every time** |

RegionCheck is only one key ahead of BanListCheck, but it also carries two
Merkle trees of initial state, and the measured boundary sits exactly
between the two. The refusal is instant and deterministic; retrying cannot
help because the transaction never becomes smaller.

## What this is NOT (corrections to our own first guesses)

- **Not the per-account throttle.** `pallet_throttle` rate-limits accounts
  to 10 MB of transaction data per day; we never came close. Newer nodes
  give throttling its own error code (`Custom(254)`) precisely because the
  shared 1010 message confuses people — it confused us. The wait-and-retry
  wrapper in `src/network-chain.mjs` is harmless (a retry that can never
  succeed simply never fires), but the diagnosis it was built for was
  wrong, and the first version of this note repeated that wrong diagnosis.
- **Not Merkle tree depth.** Tree depth affects proving cost, not the size
  of the deployment transaction. Reducing it would have been surgery on
  the wrong organ.
- **Not a defect in the local rehearsal chain.** The limits are production
  values everywhere.

## What we did about it

The runbook's least-invasive remedy: **merge near-duplicate entry points
into one circuit with a selector argument.** The add/remove pairs for the
admin and operator roles are pure toggles, so they became
`set_admin(key, enabled)` and `set_operator(key, enabled)`. Two verifier
keys saved in every contract that carries them, identical security
semantics — same gating, same assertions (an admin cannot be added twice;
the last admin cannot be removed). The region allow-list pair was left
alone: its two halves take different argument types (a region code vs a
tree index), so merging them would make a worse API for no need.

Result: every contract is at most 10 circuits (RegionCheck), most are 8
or fewer, and all sit comfortably under the ceiling. All 112 protocol
tests pass unchanged in what they assert; only the circuit names at the
call sites changed.

## If a contract ever outgrows this anyway

The runbook documents the production path, and it needs no contract
redesign: **batched deployment**. Deploy with the circuits that fit, then
insert the remaining verifier keys one per maintenance transaction
(`submitInsertVerifierKeyTx` in midnight-js, ~3 KB each, signed by the
contract maintenance authority). It is resumable and cost us nothing to
know about. Splitting a contract across trust boundaries is the last
resort, not the first: it taxes every future proof with cross-contract
calls to save deploy-time bytes once.
