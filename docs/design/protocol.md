# Protocol design notes

How the Build Club MVP is put together, what it puts on-chain, and where its
limits are. Written for someone reviewing the code.

## Vocabulary

| Word | Meaning |
|---|---|
| **Holder** | The person asking to have a wallet cleared. |
| **Ticket** | A sealed commitment to `{holder key, wallet hash}`. Public, 32 random-looking bytes. Every pass and clearance is stamped on a ticket. |
| **Provider** | An outside party that answers one question off-chain. A black box. |
| **Operator** | The provider's on-chain role in one check contract: it may record sealed evidence there, and withdraw evidence or a pass again. Only the five check contracts have one. |
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
   matters, the same wallet), and that it has not expired. Revocation needs
   no separate check: a withdrawn leaf has been blanked, so membership in the
   tree *is* the test. The contract records a pass against the ticket.

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
| When something is revoked: the leaf's **index** in its tree | Which credential, result or attestation that index holds, and why a provider said no |

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
  after can be correlated. This is now the main way a ticket can be tied to
  the issuance it came from, and nothing in these contracts prevents it.
- **A revocation names an index.** `revoke_credential(7)` says "whatever was
  recorded seventh is withdrawn". An observer who was watching when leaf 7
  went in knows which transaction that was, so a revocation is linkable to
  an *issuance transaction*. It is not linkable to a ticket, a wallet or a
  person, and the holder's own proofs publish nothing that would join the
  two.
- **Revoking a pass names the ticket.** It has to: whoever relies on the
  pass must be able to see it is gone. Tickets are public anyway, so this
  reveals nothing new about who holds one, only that this check withdrew its
  pass from it.

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
- **Revocation needs two calls, and nothing enforces that both are made.**
  Withdrawing a pass (`revoke_pass`) stops anything relying on it at once,
  but the evidence behind it is still in its tree, so the holder can
  re-prove and collect the pass again. Withdrawing the evidence
  (`revoke_*(index)`) stops that, but does not touch a pass already
  collected. Both are needed, in either order, and an operator that does
  only one has not finished the job. The contracts say so in their comments
  and a test holds them to it, but no circuit can check it, because neither
  contract can see the other's intent.
- **Revocation depends on off-chain bookkeeping.** A leaf is withdrawn by
  its index, and the only party that knows which index holds whose evidence
  is the issuer that recorded it. An issuer that loses that record cannot
  revoke. The same is true of `release_binding`, which now needs the
  nullifier from the insurer's own policy record.
- **A revocation invalidates in-flight proofs.** Blanking a leaf is followed
  by `resetHistory()`, which drops every earlier root. A holder who had just
  built a proof against one of those roots must build it again. This is
  deliberate: without `resetHistory()` the revocation would not work at all
  (see below).
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
| The identity revocation value links every ticket backed by one credential, and the issuer can compute it. | **Fixed**, by redesign. Nothing credential-derived is published at all now. See [Identity revocation](#identity-revocation-the-hard-one) below. |
| Program operators who know a wallet hash can tell whether that wallet is bound. | **Fixed.** The binding nullifier now mixes in a secret only the holder has. See [The binding nullifier](#the-binding-nullifier). |
| Evidence leaves cannot be revoked (identity excepted), allowed regions cannot be removed, and a clearance cannot be revoked early. | **Fixed.** Every check can withdraw its own evidence and its passes; regions can be withdrawn; clearances can be revoked. See [Revocation](#revocation-what-can-now-be-withdrawn). |
| Sealed evidence structs carry no type tag, so two structs of the same shape share an encoding. No live exploit: each lives in its own tree. | **Fixed.** Every sealed value is hashed under a per-kind tag. See [Type tags](#type-tags-on-sealed-evidence). |
| Three contracts inherit an unused operator role; a holder can overwrite their own pass with a weaker one. | **Fixed.** The operator role moved to `lib/Operator.compact`, included only by the five checks; `record_pass` refuses a weaker or shorter replacement. |
| One binding salt per device. | **Open**, low severity. The holder's device uses a single `get_binding_salt()` witness, so a device holding two bindings cannot tell the contracts which one it means. Harmless while a holder has one policy per wallet; it needs a salt per binding before a holder can hold several. |

Everything the review raised except the last row is now closed. What follows
is what each fix actually guarantees, and what it does not. The honest
summary: **the linkability flaw is genuinely gone, and the remaining risks
are correlation by timing and the fact that revocation depends on issuers
keeping their own records.**

### Identity revocation: the hard one

**What was wrong.** Every use of a credential published
`hash(credential id)` as a revocation nullifier. Two consequences, both bad:
every ticket backed by one credential carried the same tag and so was
linkable to the others however many fresh salts the holder used; and the
issuer, which knows the credential id, could compute the tag and pick out
exactly which anonymous tickets belonged to someone it had verified. That is
the opposite of what the ticket exists to do.

**Why no tweak fixes it.** Any value that the issuer can recompute and the
holder must publish is a linking tag by construction. Salting it does not
help, because the holder must publish the *same* value every time for the
revocation set to be checkable. The only way out is to publish nothing
derived from the credential.

**What was done, and why this path.** John's instruction was to attempt the
proper fix first: non-membership in a revocation set, or membership in an
accumulator of unrevoked credentials. The second is what Compact supports
cleanly, so that is what was built. Revocation moved off the holder's side
of the proof entirely and onto the issuer's side of the tree:

- `issue_credential` appends the sealed credential and increments
  `credentialsIssued`. Because `insert` appends at the next free index, the
  counter's value just before the call *is* the index the credential lands
  at. That is the only way the issuer can learn it, since a circuit cannot
  return the index `insert` chose.
- `revoke_credential(index)` blanks that leaf with `insertIndexDefault`,
  then calls `resetHistory()`.
- `prove_identity` proves membership of the leaf in the tree, exactly as
  before, and publishes only a Merkle root. A blanked leaf is not in the
  tree, has no path, and cannot be proven. There is no separate revocation
  check and no published value derived from the credential.

The same mechanism was then applied to every other evidence tree, so the
whole system revokes the same way.

**`resetHistory()` is load-bearing, and this was verified, not assumed.** A
`HistoricMerkleTree` accepts a proof against *any* root it has ever had, so
blanking a leaf without clearing that history leaves every pre-revocation
root valid and the revoked holder simply proves against an older one. This
was checked by experiment against compiler 0.36.1 before the change was
written, and is now pinned by tests: with `resetHistory()` a replayed
pre-revocation path is refused; with the call deleted, the identity replay
test fails (confirmed by deleting it and watching the test go red).

**What this guarantees.** The issuer can no longer recognise a holder's
tickets, because there is nothing to recognise them by: after a full
clearance, no contract's state contains the credential id, the credential
salt, the certificate id, or any value derived from them, and a test
searches the raw state of all eight contracts for exactly those bytes. Two
tickets backed by one credential are no longer linkable to each other.

**Residual risk, stated plainly.**

- **Timing correlation is untouched, and is now the weakest point.** The
  issuer sees the transaction in which it recorded a credential and can
  watch for a `prove_identity` shortly afterwards. With few users that is
  often enough to guess the pairing. Nothing in these contracts addresses
  it; mitigating it needs batching, delay, or many users, none of which is
  built.
- **The revoked index is public.** It identifies an *issuance transaction*,
  which the issuer already knew about, and cannot be joined to a ticket.
- **The issuer still knows who it verified.** It did the identity check off
  chain. The fix stops it recognising their on-chain activity; it does not
  and cannot stop it knowing they are a customer.
- **Revocation now depends on the issuer's own index records.** An issuer
  that loses them cannot revoke. The old design could revoke from the
  credential id alone, which was precisely the property that leaked.
- **A holder who re-uses one credential across tickets is still linkable by
  the operator who issued it** if that operator colludes with whoever
  recorded the other evidence, by timing, not by any published value.
- **Not reviewed by anyone else yet.** This is a design change made in one
  sitting. It should be read by someone who did not write it before it
  carries real personal data.

### The binding nullifier

`derive_binding_nullifier` was `hash(walletHash)`, and the program's own
operators compute wallet hashes routinely because they hold the HMAC key, so
any of them could test a wallet and learn whether it was insured. It is now
`hash(walletHash, hash("…holder:", holder secret key))`. Without the
holder's secret the value cannot be produced, so no operator, insurer or
observer can test a wallet for a policy. The holder's device computes it
inside the proof and the secret never leaves the device.

**The price, accepted deliberately.** The rule became "one wallet, one
binding **per holder key**" instead of per wallet outright. The same person
still cannot bind the same wallet twice however many fresh tickets they
make, because their secret is the same; but two different holder keys that
both control one wallet could each bind it once. That is a worse answer for
an underwriter than for a privacy design, and it is the right way round: the
underwriter can see a double binding in its own records, whereas a public
value that lets anyone test a wallet cannot be taken back. A test pins both
halves of this behaviour.

`release_binding` now takes the nullifier rather than the wallet hash,
because the admin can no longer derive it. The insurer records it from the
`bind_policy` transaction it took part in. An insurer that loses that record
cannot release the wallet.

**Still true:** `walletHash` must remain a keyed HMAC, not a plain hash. The
nullifier no longer depends on that, but the ban-list check's leaves do.

### Revocation: what can now be withdrawn

| Withdrawn by | Circuit | Who may call it |
|---|---|---|
| A pass | `revoke_pass(ticket)` | that check's operator or admin |
| A screening result | `BanListCheck.revoke_screening(index)` | operator or admin |
| An identity credential | `IdentityCheck.revoke_credential(index)` | operator or admin |
| An education certificate | `EducationCheck.revoke_certificate(index)` | operator or admin |
| A region attestation | `RegionCheck.revoke_region_attestation(index)` | operator or admin |
| A wallet-control attestation | `WalletControlCheck.revoke_control_attestation(index)` | operator or admin |
| An allowed region | `RegionCheck.remove_allowed_region(index)` | admin |
| A clearance | `ClearanceRegistry.revoke_clearance(ticket, profile)` | admin |

Evidence is withdrawn by index rather than by value, for the same reason
throughout: a circuit cannot search a Merkle tree, and naming the value
would publish exactly what the tree exists to hide. The allow-list is the
clearest case — it is a tree, not a public `Set`, precisely so a holder can
prove "my region is in the list" without saying which region, so it can only
be edited by position.

**Two things this does not do.**

- **A revoked clearance can be earned again** while the passes under it are
  still good. `grant_clearance` re-asks every required check, so it succeeds
  again. That is the correct answer when a clearance was withdrawn over
  something since resolved, and the alternative — a registry that can brick
  a ticket permanently — is a worse failure mode. To put a ticket out and
  keep it out, revoke the pass and the evidence in the check that went bad
  as well. Tests cover both halves.
- **Nothing forces an operator to do both calls.** See
  [Known limits](#known-limits).

### Type tags on sealed evidence

Two pairs of structs had identical shapes and therefore identical
encodings: `IdentityCredential` and `EducationCertificate`
(`{Bytes<32>, Uint<8>, Bytes<32>, Uint<64>}`), and `RegionAttestation` and
`ControlAttestation` (`{Bytes<32>, Bytes<32>, Uint<64>}`). The second pair
mattered most: a region attestation says nothing about a wallet, while a
wallet-control attestation is what proves a holder controls the wallet in
their ticket.

There was no live exploit, because each lives in its own tree in its own
contract. The fix is cheap insurance against the day a tree is shared, a
contract reused, or a check re-pointed: every sealed value is now hashed
under a tag naming its kind, inside the same `commit_*` helper the off-chain
code already used, so no off-chain signature changed. Tickets and bindings
got tags too. A test asserts that the same field values under the same salt
now seal to different bytes for each pair.

The ban-list leaf was already tagged.

### The unused operator role

`lib/Common.compact` declared the operator set and `add_operator` /
`remove_operator`, and every contract includes it, so `ClearanceRegistry`,
`PairReceipt` and `PolicyBinder` each carried an operator set and two
admin-callable circuits that nothing could use: state an auditor has to
reason about, circuits a confused admin could call, and proving keys paid for
at compile time. The role moved to `lib/Operator.compact`, which only the
five checks include, so a contract that does not include it provably has no
operator. `PolicyBinder` went from nine provable circuits to seven.

### A holder can no longer weaken their own pass

`record_pass` inserted unconditionally, so proving again with weaker or
shorter evidence replaced a stronger pass. Only the holder could do it, so
it was self-harm rather than an attack, but it was pure downside. It now
refuses a replacement that is lower-level, or same-level and shorter.
Upgrading (level 1 to level 2) and renewing (a longer expiry) still work,
which the tests check in both directions.

## Extending it

- **A new check:** write a contract that includes `lib/Common`, `lib/Ticket`,
  `lib/Pass` and `lib/Membership`, give it a holder circuit that ends in `record_pass`,
  deploy it, and `register_check` it into a free slot.
- **A new use of clearance:** write a contract that declares
  `contract Clearance { circuit require_clearance(...): Uint<64>; }` and
  calls it, as `PairReceipt` and `PolicyBinder` do.
- **A new provider:** implement the methods in
  `protocol/providers/README.md`.
