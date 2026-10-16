# CryptoSure

**Privacy-preserving insurance for crypto.**

CryptoSure is building a new category of insurance: defined, provable
coverage for crypto held in wallets, from everyday self-custody to
institutional treasury and custodial arrangements.

The wager is simple. Crypto is uniquely insurable: every loss leaves a
permanent, verifiable trail; ownership can be proven cryptographically;
and losses can be prevented, tracked, and in many cases recovered. The
insurance market just hasn't been built for it yet. We're building it.

## What we're exploring

- Coverage that knows what it covers: written scope, bound to the policy,
  no ambiguity at claim time
- Education-gated protection: the safest holders earn the best terms
- Loss prevention as a feature: tooling that intervenes at dangerous
  moments, not after them
- Privacy-first verification: proving what matters without exposing who
  you are or what you hold
- Recovery-aware claims: claims that trace and fight, not just pay

## First instrument: the WalletBinder

Before a wallet can be attached to a policy, three things must be true.
It must not be on a sanctions denylist. Its holder must have passed KYC
with an approved provider. And the holder must be in a jurisdiction the
program is licensed for.

Today, proving those three things means handing an insurer your identity,
your address, and your wallet. `contracts/WalletBinder.compact` proves all
three in a single zero-knowledge proof on Midnight instead:

| Check | What the chain sees | What it never sees |
|---|---|---|
| Sanctions | A Merkle root check against the screening tree | Which wallet was screened |
| KYC | A root check, a level threshold passed, a coarse expiry | Name, documents, or which credential |
| Jurisdiction | A root check against the allowed-jurisdiction tree | Where the holder lives |

A single-use nullifier prevents the same wallet from being bound twice.
The binding itself is a hidden commitment; at claim time the holder proves
"the wallet I am claiming on is the one that was bound" without publishing
it. Denylists churn (entries get added and delisted), so every clearance
carries a list version and the contract enforces a freshness floor.

KYC itself is a black box to CryptoSure. A trusted issuer verifies the
holder, [KYCz](https://github.com/bytewizard42i/KYCz_us_app) holds the
anchor, and a thin facade hands CryptoSure a credential commitment and
nothing more. The integration spec lives in the KYCz repo under
`docs/integrations/cryptosure/`.

Roles are explicit: an **issuer** (exchange, government provider, or
licensed KYC vendor) inserts credential commitments; a **screener** inserts
sanctions clearances; an **admin** manages roles, jurisdictions, and the
freshness floor. Everything is a Merkle membership proof, so the chain
learns that *some* eligible holder bound *some* cleared wallet, and nothing
else.

### Status of the contract

- Compiles under Compact 0.35.0 (language 0.27) with full proving keys,
  18 circuits. The contract is written as production logic, not a sketch.
- Honest boundary: list-based sanctions screening requires the screener to
  see the address it screens, exactly as every compliance vendor does
  today. Midnight's contribution is that the result reaches the chain as a
  hidden leaf and the holder proves clearance without revealing which
  address was cleared.
- Cross-contract calls are not yet available on Midnight, so the three
  checks live in one contract on purpose. No off-chain attestor bridges
  them; the gate is atomic.

### The demo

The KYC provider and the sanctions feeds are **simulated** in the demo.
`demo/mock-screening-fixture.json` holds twenty fictional wallet addresses,
half of them planted on a mock denylist with fictional attributions. The
demo app lets you pick one and try to bind it. A clean address passes the
gate. A planted one is rejected by the proof, and only then does the demo
tell you why: you cannot tell a banned address by looking at it, which is
the whole reason the check exists.

The contract does not know or care that the data is simulated. Swap the
mock provider for a real KYC issuer and a live denylist feed and the same
circuits run unchanged.

## Repository layout

```
contracts/
  WalletBinder.compact        the eligibility gate (compiles, full ZK keys)
demo/
  mock-screening-fixture.json simulated addresses + mock KYC provider shape
```

## See it

[cryptosure.pro](https://cryptosure.pro) ·
[demo.cryptosure.pro](https://demo.cryptosure.pro)

## Status

Early build. We are developing in the open where it helps and keeping the
rest close where it matters.

---

*Built on Midnight. Built to last.*
