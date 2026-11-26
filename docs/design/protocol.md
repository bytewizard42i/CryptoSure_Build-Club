# Protocol design notes

How the Build Club MVP is put together, what it puts on-chain, and where its
limits are. Written for someone reviewing the code.

## Vocabulary

| Word | Meaning |
|---|---|
| **Holder** | The person asking to have a wallet cleared. |
| **Ticket** | A sealed commitment to `{holder key, wallet hash}`. Public, 32 random-looking bytes. Every pass and clearance is stamped on a ticket. |
| **Provider** | An outside party that answers one question off-chain. A black box. |
| **Operator** | The provider's on-chain role in one check contract: it may record sealed evidence there. |
| **Pass** | A public record in a check contract: this ticket passed, at this level, until this time. |
| **Profile** | A named list of minimum levels, one per check. |
| **Clearance** | A public record in the registry: this ticket holds every pass this profile needs, until this time. |
| **Cover class** | A label for a kind of policy. Each maps to the profile it requires. |

## One check, step by step

1. **Ask.** The provider answers pass, refuse or unknown.
2. **Record.** On a pass, the operator inserts a sealed leaf into that check
   contract's Merkle tree. The leaf is unreadable.
3. **Prove.** The holder proves in zero knowledge that they can open their
   ticket, that a leaf in the tree is about the same holder (and, where it
   matters, the same wallet), and that it has not expired or been revoked.
   The contract records a pass against the ticket.

Then `ClearanceRegistry.grant_clearance` asks each required check contract
`require_pass(ticket, minimum level)` in the same transaction and records
the clearance. It needs no private input, so anyone may call it.

## Why separate contracts

- A check can be replaced by deploying a new contract and repointing a slot.
- A new kind of check needs one contract and one free slot. Nothing existing
  is redeployed.
- Each contract has one operator and one reason to change.

The cost is that a clearance is no longer one proof. It is several proofs
tied together by the ticket: each check makes the holder open the same
ticket, so the passes can only have been collected by one person for one
wallet.

## How contracts call each other

A caller declares the shape of the contract it depends on:

```compact
contract Check {
  circuit require_pass(ticket: Bytes<32>, min_level: Uint<8>): Uint<64>;
}
```

and calls it through a stored reference. Midnight's rules, which shape the
design:

- A circuit that another contract calls **cannot use witnesses**. So every
  cross-called circuit here (`require_pass`, `require_clearance`,
  `require_receipt`) works only from public ledger state and its arguments.
- Arguments to a cross-contract call are disclosed.
- Cross-contract calls are limited to unshielded data in this phase.
- A call cycle fails at run time.
- The called contract must carry a verifier key for the circuit, so the
  contracts must be compiled with keys to run the tests.

References: Compact language reference, "Contract types" and "Cross-contract
calls"; Compact toolchain 0.36.0 release notes.

## What is on-chain

| Public | Never on-chain |
|---|---|
| Tickets | Names, documents, addresses |
| Passes: ticket, level, expiry | Which region, which credential, which list entry |
| Clearances: ticket, profile, expiry | The wallet hash |
| Receipts: an id, two times | Anything about the transfer (amount, asset) |
| A binding nullifier, a hidden binding commitment, the cover class | The policy, its terms, the signed acknowledgment |
| A revocation nullifier per identity credential | Why a provider said no |

The test "what is NOT on the ledger" searches the raw state of all eight
contracts for the address, wallet hash, holder keys and ticket salt after a
full run.

## What an observer can infer

Stated plainly, because the privacy is not total:

- **Passes on one ticket are linked to each other.** That is the purpose of
  a ticket. A holder who wants a fresh start makes a new ticket.
- **Levels are visible.** An identity pass shows level 1 or 2.
- **Profiles and cover classes are visible.** They hint at how much checking
  a ticket went through, and a cover class may hint at policy size.
- **Receipts link two tickets.** An observer learns those two tickets were
  checked together, at that time.
- **Timing.** An operator recording a leaf and a holder proving shortly
  after can be correlated.
- **Two tickets backed by the same identity credential** share a revocation
  nullifier and are linkable to each other.

## Trust placed in each party

| Party | Trusted to | Can it see the address? |
|---|---|---|
| Ban-list operator | Screen honestly and record only clean results | Yes. List screening needs the address. |
| Wallet-control operator | Verify the wallet's signature before attesting | Yes |
| Region, identity, education operators | Issue evidence only to people who qualify | No |
| Administrator | Configure slots, profiles, cover classes honestly | No |
| The program (wallet-hash key holder) | Keep the key secret | It can recompute a wallet hash from an address |

## The wallet hash is keyed

A wallet appears to the contracts only as `walletHash`. It is an HMAC of
`chain:address` under a secret held by the program, not a plain hash. A plain
hash would let anyone hash a known address and look for values derived from
it, such as the binding nullifier. The contracts cannot enforce how the hash
was made; the off-chain code does (`protocol/encoding.mjs`).

## Time

A circuit cannot read the clock; it can only compare against it. Callers
supply `issued_at`, and every circuit that takes it asserts it is not in the
future. Supplying an older time only shortens the caller's own pass.

## Known limits

- **Not deployed.** The contracts run on a local stand-in. No proofs are
  generated and nothing is on a Midnight network yet.
- **Wallet control is attested, not proven in-circuit.** An operator checks
  the wallet's signature off-chain. Other chains sign with schemes this MVP
  does not verify inside a proof.
- **A pass ends only by expiring.** There is no revocation of a single pass
  or clearance. A wallet that lands on the ban list keeps its clearance
  until the ban-list pass runs out (one day by default), which is why the
  pair check asks the ban list again every time.
- **Credential sharing.** Two people who share secrets can share evidence.
  No on-chain design prevents that.
- **The directory is off-chain.** Looking a wallet up by address needs a
  private mapping from address to ticket, kept by whoever runs the service.
- **No fees.** Nothing is charged for a check, a clearance or a receipt.

## Security review, Nov 25 2026

An adversarial review of the first version of these contracts found one
critical flaw and several serious ones. What was done about each:

| Finding | Status |
|---|---|
| **Critical.** The Merkle path a holder's device supplied was never checked to be for the right leaf, so anyone holding one genuine leaf could forge every pass. Confirmed with a working bypass. | **Fixed.** `lib/Membership.compact` binds the leaf at all seven sites. `tests/dishonest-device.test.mjs` replays the attack against every tree. |
| Anyone could overwrite a good clearance with an expired one by re-granting it with an old date. | **Fixed.** A clearance is never recorded already expired and never shortened. |
| The admin was claimed in a separate step that the first caller won, and an admin could never be removed. | **Fixed.** The first admin is a constructor argument. `remove_admin` exists and refuses to remove the last one. |
| A released binding still proved. | **Fixed.** Released bindings are recorded and `prove_binding` refuses them. |
| `bind_policy` returned the binding commitment publicly. | **Fixed.** It returns nothing. |
| A profile requiring nothing could be defined; shelf lives were unbounded; receipts could be back-dated or re-issued. | **Fixed.** |
| The identity revocation value links every ticket backed by one credential, and the issuer can compute it. | **Open.** Documented in `IdentityCheck.compact`. Needs a different revocation design. |
| Program operators who know a wallet hash can tell whether that wallet is bound. | **Open.** Documented in `PolicyBinder.compact`. |
| Evidence leaves cannot be revoked (identity excepted), allowed regions cannot be removed, and a clearance cannot be revoked early. | **Open.** |
| Sealed evidence structs carry no type tag, so two structs of the same shape share an encoding. No live exploit: each lives in its own tree. | **Open.** |
| Three contracts inherit an unused operator role; one binding salt per device; a holder can overwrite their own pass with a weaker one. | **Open**, low severity. |

The open items should be closed before any deployment that carries real
personal data.

## Extending it

- **A new check:** write a contract that includes `lib/Common`, `lib/Ticket`,
  `lib/Pass` and `lib/Membership`, give it a holder circuit that ends in `record_pass`,
  deploy it, and `register_check` it into a free slot.
- **A new use of clearance:** write a contract that declares
  `contract Clearance { circuit require_clearance(...): Uint<64>; }` and
  calls it, as `PairReceipt` and `PolicyBinder` do.
- **A new provider:** implement the methods in
  `protocol/providers/README.md`.
