# CryptoSure major synopsis

*For anyone who asked a second question.*

---

## 1. Why this exists

Somewhere north of a hundred billion dollars of crypto sits in wallets with
no insurance behind it. Most of that is not retail speculation. It is
company treasuries, custodians holding assets for their users, exchanges,
payment platforms, funds, and the growing number of ordinary businesses that
now hold digital assets as a matter of course. When those assets are lost to
a compromised key, a poisoned address, a phishing kit, or an insider, the
loss is total and the holder absorbs it alone.

Traditional carriers have mostly stayed out. The reasons they give are
familiar: volatile values, unclear custody, no actuarial history, and
customers who refuse to hand over the identity and wallet information an
underwriter normally demands. Each of those is real. None of them is a
reason the risk cannot be insured. They are reasons nobody has yet built the
standard, the evidence trail, and the privacy model that would let a carrier
say yes.

CryptoSure's thesis is that crypto is the most insurable asset class ever
created, not the least. Every loss leaves a permanent, public, timestamped
trail. Ownership is proven cryptographically rather than by paperwork. Loss
can be prevented at the exact moment of a transfer, traced after the fact,
and in a meaningful share of cases recovered. No other asset class offers an
insurer that much evidence. The market just has not been built. We are
building it, and we will do one thing: insure crypto held in wallets,
honestly and well.

## 2. Who it is for

| Segment | What they need | Priority |
|---|---|---|
| Companies holding crypto (treasuries, funds, operating businesses) | Defined coverage on specific wallets, evidence their auditors and boards accept | First |
| Companies custodying crypto for users (custodians, exchanges, platforms) | Coverage that scales across many wallets with aggregation controls | First |
| Individuals in self-custody | Simple fixed-tier protection and a transfer-safety tool | Light retail, as validation and distribution |

Business customers come first because the losses are larger, the buyers are
rational, and the compliance posture is already in place. The retail product
exists to prove the full workflow from underwriter to insured and to build
the loss-prevention habits the whole program depends on.

## 3. What we sell

Two forms of coverage, both first-class.

**Wallet coverage.** A periodic policy on a wallet, written in fixed tiers.
The scope is a versioned document whose hash is bound to the policy, so
"what was covered" is a fact, not an argument. Covered events are defined
loss events that can be evidenced on-chain: unauthorized transfer following
key compromise, address-poisoning loss when the mitigation tool was used,
and so on. Exclusions are written in plain language.

**Transfer coverage.** Point-of-use protection for a single high-value
transfer, which is where most money is actually lost. The flow: the sender
declares an exact payment intent (recipient address, asset, amount, chain,
nonce, expiry). The recipient signs that intent with the key controlling
the declared address. CryptoSure verifies the signature recovers the exact
declared address, not a lookalike. Only then does the transfer proceed, and
only then is it covered. This closes address poisoning, fake receipts,
replay, and in-flight modification. It does not close a coerced or
dishonest recipient, which is handled by scope, not mechanism, and we say
so.

**Prevention as a feature.** Tiered education unlocks higher coverage. The
safest holders earn the best terms. Wallet health checks, transfer
verification, suspicious-approval warnings, and signed transfer receipts
are the product as much as the payout is.

## 4. The first instrument: WalletBinder

Before any wallet is attached to a policy, three things must be true. It
must not be on a sanctions denylist. Its holder must have passed KYC (Know
Your Customer, the identity verification regulated financial firms are
required to perform) with an approved provider. And the holder must be in a
jurisdiction the program is licensed for.

Today, proving those three things means handing an insurer your identity,
your address, and your wallet. `contracts/WalletBinder.compact` proves all
three inside a single ZK (zero-knowledge) proof on Midnight instead. It
compiles on compactc 0.35.0 (language version 0.27) with full proving keys,
eighteen circuits.

| Check | What the chain sees | What it never sees |
|---|---|---|
| Sanctions | A Merkle root check against the screening tree, at or above a freshness floor | Which wallet was screened |
| KYC | A root check, a level threshold passed, a coarse (month-rounded) expiry | Name, documents, or which credential was opened |
| Jurisdiction | A root check against the allowed-jurisdiction tree | Where the holder lives |

Design choices worth knowing:

- **One contract, on purpose.** Cross-contract calls are not yet available
  on Midnight. Splitting the gate across contracts would require an
  off-chain service to bridge them, and that service becomes a trust hole.
  All three trees live in one contract so one circuit enforces the whole
  gate atomically.
- **Merkle membership, not set lookups.** A plain set or map lookup reveals
  which element is being tested. Every check here is a Merkle path proof,
  so the chain sees a root and never a leaf.
- **Nullifiers for one-wallet-one-binding.** A deterministic nullifier
  derived from the wallet hash prevents double-binding without revealing
  the wallet to anyone who does not already know it.
- **Freshness for churning lists.** Sanctions lists change; entries are
  added and delisted. Every clearance carries the list version it was
  checked against, and an admin-set floor rejects stale clearances.
- **Claim-time proof.** The binding is a hidden commitment. At claim time
  the holder proves "the wallet I am claiming on is the one that was bound"
  without publishing it.

Roles are explicit. An **issuer** (exchange, government provider, licensed
KYC vendor) inserts credential commitments. A **screener** (a sanctions
compliance provider) inserts clearance leaves after checking an address
against the live feeds. An **admin** manages roles, allowed jurisdictions,
and the freshness floor. Each role is removable.

## 5. The black boxes

Three instruments feed the WalletBinder, and all three are outside the
scope of this Build Club project. CryptoSure treats each as a sealed black
box: we consume its output and never look inside.

**KYCz**, our privacy-preserving KYC protocol. A trusted issuer runs full
KYC on the potential insured and enters everything it collected into KYCz.
The issuer certifies the contents are correct and sufficient for the
applicable standard, then seals the box. What CryptoSure receives is the
sealed box: a cryptographic commitment we can verify but cannot open. The
box is trap-doored, and the trap door is held by the trusted issuer, not by
us. If the holder is suspected of a crime and a warrant is issued, the
warrant is served on the issuer, who opens the box and releases the identity
behind the wallet. Absent a warrant, all CryptoSure learns is what the proof
says: this wallet's holder qualifies at the required level.

**GeoZ**, our privacy-preserving location oracle. Same arrangement for
jurisdiction. A trusted issuer attests the region, GeoZ seals it, and the
proof tells us only that the holder is inside a licensed jurisdiction.

**The ZK proof itself.** Produced on the holder's own device from openings
we never see, verified on Midnight. We check that it is valid; we do not,
and cannot, inspect its inputs.

To these CryptoSure adds the one check it performs directly: the wallet
address must not appear on the banned-address libraries, meaning the SDN
(Specially Designated Nationals) list kept by OFAC (the United States
Treasury's Office of Foreign Assets Control) and the consolidated sanctions
lists of the European Union, the United Kingdom, and the United Nations.
List-based screening means the screener must see the address it screens,
exactly as every compliance vendor does today. Midnight's contribution is
that the result reaches the chain as a hidden leaf and the holder proves
clearance without revealing which address.

This arrangement lets us say two true things at once. To the carrier and
the regulator: every insured wallet traces to a verified person through
lawful process. To the customer: we hold nothing that could leak.

## 6. The path to being insured

```
education confirmation (ZKP)  ->  contract signing (ZKP)  ->  centralized oversight (a person checks)  ->  insured: set amount, set period, clear coverage
```

Automated proofs do not bind coverage alone. A human underwriter reviews
before anything binds. That is not a limitation we apologize for; it is the
posture a carrier expects, and the industry's failures have come from
delegating authority without oversight, not from too much of it.

## 7. The demo, honestly described

The KYC provider and the sanctions feeds are simulated. A fixture holds
twenty fictional wallet addresses, half of them planted on a mock denylist
with fictional attributions. The demo lets a reviewer pick one and try to
bind it. A clean address passes the gate. A planted one is rejected by the
proof, and only then does the demo say why: you cannot tell a banned
address by looking at it, which is the whole reason the check exists.

The contract does not know or care that the data is simulated. Swap the
mock provider for a real KYC issuer and the mock list for a live feed, and
the same circuits run unchanged. No policy has been sold. Nothing in this
repository is a solicitation or an offer of insurance.

## 8. How we use Midnight, and how we do not

Minimal blockchain footprint. Midnight is used for exactly four things:
providing insurance (eligibility, binding, policy commitments), protecting
customer privacy, paying claims, and supporting forensic recovery. It is
not used for marketing, governance theater, or anything a database does
better. Raw identity, addresses, and personal information never go
on-chain. The chain holds commitments, nullifiers, Merkle roots, and
counters.

## 9. What we will not do

- Cover undefined or unprovable loss.
- Exercise discretion at the platform level. Criteria are fixed and
  versioned; change ships as a new version applied uniformly, never as a
  bent rule.
- Grow faster than capital and oversight allow.
- Hold customer identity data we do not need.
- Claim that a feature runs before it has been compiled, tested, or
  deployed.

## 10. Business posture

Carrier-backed from the start: a licensed carrier issues policies, holds
reserves, and bears regulated risk, while CryptoSure provides the
underwriting standard, the technology, the evidence trail, and the customer
experience. Pennsylvania first. Business customers first, light retail to
validate the full flow. The underwriting standard, rating logic, education
curriculum, claims evidence schema, and reporting feeds are designed from
day one so that other carriers could adopt them, which is the long-run
shape of the company: a standard carriers write to, not just a program one
carrier runs.

The lesson from a century of insurer failures is consistent: inadequate
pricing, deficient reserves, growth beyond capital, and uncontrolled
delegated authority. The lesson from the great ones is equally consistent:
be disciplined about the math and obsessive about the people. CryptoSure
is built on the second lesson and guarded against the first.

## 11. Repository

```
contracts/WalletBinder.compact         the eligibility gate (compiles, full ZK keys)
demo/mock-screening-fixture.json       simulated addresses and mock KYC provider shape
docs/pitch-resources/                  this folder
media/cryptosure-architecture-v2_0.png the architecture diagram
```

Integration specifications for KYCz and GeoZ live in their own repositories
under `docs/integrations/cryptosure/`.

## 12. People

John Santi, founder. David Hamilton, collaborator. Built on Midnight, in
the Midnight Build Club.

---

*Built on Midnight. Built to last.*
