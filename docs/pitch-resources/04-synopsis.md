# CryptoSure synopsis (one page)

## The problem

Crypto held in wallets is almost entirely uninsured. Companies holding
treasury, custodians holding assets for users, exchanges and platforms, and
individuals in self-custody all carry the risk themselves. Carriers have
stayed out, not because the risk is unknowable but because nobody has given
them a validated way to underwrite it: fixed criteria, provable eligibility,
evidence at claim time, and a privacy model their customers will accept.

## The thesis

Crypto is the most insurable asset class ever created. Every loss leaves a
permanent, public trail. Ownership is proven cryptographically. Losses can
be prevented at the moment of transfer, traced after the fact, and often
recovered. The insurance market simply has not been built for it. CryptoSure
is building it, and will do one thing: insure crypto in wallets, honestly
and well.

## The product

Two forms of coverage, both first-class:

- **Wallet coverage.** A periodic policy on a wallet, in fixed tiers, with
  written scope bound to the policy so there is no ambiguity at claim time.
- **Transfer coverage.** Point-of-use protection for a single high-value
  transfer. The sender's payment intent (recipient, asset, amount, chain,
  nonce, expiry) is signed by the recipient's own key before funds move,
  which defeats address poisoning, fake receipts, and replay. Coverage
  applies only when the mitigation ran and produced evidence.

Both are gated by tiered education (the safest holders earn the best
terms), a signed contract, and a human underwriting review before binding.

## The first instrument: WalletBinder

One Compact contract on Midnight, compiled on compactc 0.35.0 with full
proving keys, eighteen circuits. A wallet is bound to a policy only after
three checks pass inside a single ZK (zero-knowledge) proof:

| Check | What the chain sees | What it never sees |
|---|---|---|
| Sanctions | A Merkle root check against the screening tree, at a fresh list version | Which wallet was screened |
| KYC (Know Your Customer) | A root check, a level threshold passed, a coarse expiry | Name, documents, or which credential |
| Jurisdiction | A root check against the allowed-jurisdiction tree | Where the holder lives |

A single-use nullifier stops the same wallet binding twice. The binding is a
hidden commitment; at claim time the holder proves the claimed wallet is the
bound one without publishing it. Sanctions lists churn, so every clearance
carries a list version and the contract enforces a freshness floor.

## The black boxes

KYCz (privacy-preserving identity), GeoZ (privacy-preserving location), and
the ZK proof itself are sealed black boxes to CryptoSure. A trusted issuer,
an exchange or a government provider, verifies the person, certifies the
record, seals it, and keeps the key. CryptoSure receives a commitment it can
verify but cannot open. If a warrant is issued it is served on the issuer,
who opens the box. Absent a warrant, CryptoSure learns only that this
wallet's holder qualifies. That lets us say two true things at once: to the
carrier, every insured wallet traces to a verified person through lawful
process; to the customer, we hold nothing that could leak.

## Status and honesty

The contract is real and compiles. The demo feeds it simulated identity and
sanctions data, including a fixture of twenty fictional addresses with half
planted on a mock denylist, so a reviewer can watch a bad address get
rejected by the proof. Nothing in the contracts changes when real feeds
replace the fixtures. KYCz and GeoZ are consumed, not built, inside this
project. No policy has been sold; nothing here is a solicitation.

## The path

Carrier-backed structure, Pennsylvania first, business customers first
(companies holding crypto, custodians, platforms), with a light retail
product to validate the full flow from underwriter to insured. Fixed,
versioned underwriting criteria with no platform discretion, the model
Lloyd's digital platform providers already operate under. Relationships
with carriers, reinsurers, and recovery partners are the moat. The team is
John Santi (founder) with David Hamilton as collaborator.
