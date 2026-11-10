# Week 3: Pitch Development

Build Club week 3 homework. A three-minute spoken pitch covering the problem, who has it, what we built, and why us. The architecture diagram is cut on purpose. Speak it, do not read it.

About 475 words. Timed aloud at a conversational pace this lands right around three minutes.

## The script

Eleven days ago, Binance lost six point three billion dollars in twenty minutes. It says it covered the loss from its own reserves. Almost nobody else in crypto could.

Crypto is a two and a half trillion dollar asset class, and about nine in ten people who hold it carry no insurance at all.

That is not because nobody sells it. Evertas, a Lloyd's coverholder, can write up to four hundred and twenty million dollars on a single policy for a custodian or exchange. AnchorWatch insures bitcoin in self-custody, up to a hundred million per customer.

So the market is not empty. It is narrow. You can get covered if you are a large custodian that opens its books to an underwriter, or a bitcoin holder who lets the insurer co-sign every transaction. A business holding its own crypto, in its own wallet, has very few places to go.

An insurer gets comfortable with a wallet in one of two ways: collect everything about the owner, or hold a key. The first builds a honeypot of identities and holdings. The second puts the insurer inside your wallet.

We are building a third way. Certify the wallet instead.

CryptoSure is defined coverage for crypto held in wallets: a periodic policy on a wallet, and point-of-use protection for a single high-value transfer, the moment most money is actually lost.

A wallet earns coverage with three certifications.

One, KYC. A trusted issuer verifies the holder is real. Identity stays sealed with that issuer, not with us.

Two, multi-sig. The wallet is controlled by a quorum, so no single stolen key can move the funds. And a covered transfer has to carry that quorum's approval.

Three, a zero-knowledge proof binds it together. The proof shows the wallet is clear of sanctions, the holder passed KYC and lives where we are licensed, and the quorum is real. It never shows who, where, or which wallet.

So a regulated institution gets KYC built in. The client keeps their confidentiality. We hold nothing that can leak, and we never hold a key.

Where are we? Our first contract, WalletBinder, is compiled on Midnight with full proving keys. Today it proves sanctions, KYC and jurisdiction on simulated data, and you can watch a planted bad address get rejected by the proof itself. Multi-sig certification is designed, and it is what we build next. This is a working proof of concept, not an insurance product. Carrier, licence and underwriting are ahead of us.

Why us? We are not trying to out-capacity Evertas. We want to be the layer that lets a carrier, a bank or a broker say yes to wallets it cannot see into today. Insurance first. Pennsylvania first. Business customers first. Love the customer, respect the risk, honor the promise.

We will do one thing, insure crypto in wallets, and do it right.

## Who, what, why, in one glance

- **Problem:** crypto insurance exists but is narrow. It reaches large custodians and insurer-co-signed bitcoin vaults, because insurers trust a wallet only by collecting the owner's data or holding a key.
- **Who has it:** businesses holding their own crypto in their own wallets, first. Then custodians and exchanges below the size the big facilities serve, and self-custody individuals.
- **What we built:** defined wallet and transfer coverage, earned through three certifications. WalletBinder, a compiled Compact contract, proves sanctions, KYC and jurisdiction today. Multi-sig certification is designed, not built.
- **Product-market fit:** a regulated institution gets KYC, sanctions and jurisdiction assurance built in; the client keeps identity and holdings confidential; covered transfers are secured by a quorum. Untested with carriers or customers. See the [market analysis](./week-03-market-analysis.md).
- **Why us:** insurance-first discipline, certification instead of collection or co-signing, and a Pennsylvania-first carrier-backed path that complements existing capacity instead of competing with it.

## The three certifications

Each certification answers one underwriting question, and only the first and third exist in WalletBinder today.

| Certification | Question it answers | Who attests | Status |
| --- | --- | --- | --- |
| KYC | Is there a real, verified person or company behind this wallet? | A trusted third-party issuer; identity stays with them | In WalletBinder, on simulated data |
| Multi-sig, wallet | Can one stolen key move the funds? | The wallet's own on-chain quorum configuration | Designed, not built |
| Multi-sig, transaction | Did the quorum approve this specific covered transfer? | The signatures on the transfer | Designed, not built |
| Zero-knowledge proof | Can all of the above, plus sanctions and jurisdiction, be verified without disclosing who, where or which wallet? | The proof itself, checked on Midnight | Sanctions, KYC and jurisdiction compiled with full proving keys |

Background only, not for the pitch: Midnight's mainnet launched in a federated model in 2026 and is built for this pattern of proving compliance without publishing identity ([Midnight docs](https://docs.midnight.network/learn)).

## What changed after practice

Pending. This line will be filled in after the pitch is delivered to someone outside the team, with the actual observation and the actual edit. It will not be invented in advance.

## Delivery notes

- The hook is the Binance number, then the turn: coverage exists, and it is narrow. Update "eleven days ago" to the real gap on the day you speak. Drop the Binance open entirely once it is more than a few weeks old.
- Name Evertas and AnchorWatch with respect. The room trusts a founder who knows the incumbents.
- Say "zero-knowledge proof" once, then just say "the proof."
- Do not describe contract internals, Merkle trees, circuits, signature schemes or issuers beyond what the script says. That is the architecture diagram sneaking back in.
- Never imply a carrier has agreed, a licence is held, coverage is for sale today, or that multi-sig certification is built.
- Never imply Evertas, AnchorWatch or any named firm is a partner or has seen this.

Three questions to expect:

1. **"Bybit was multi-sig and still lost $1.5B."** True. Its signers approved a transaction a compromised interface misrepresented. Multi-sig stops a single stolen key; it does not stop a quorum signing the wrong thing. That is why the transaction certification matters, and why multi-sig is one of three checks and not the product.
2. **"AnchorWatch says its co-signature is what makes the risk underwritable. Why would a carrier accept less?"** Honest answer: we do not know yet that one will. It is the first thing to test in carrier conversations.
3. **"Why not just buy from Evertas?"** If you are a large custodian with a broker, you should. We are aimed at the wallet they are not built to serve.

## Open assumptions

Each of these changes the script if wrong.

- [ ] **Multi-sig is not yet in WalletBinder.** The contract covers sanctions, KYC and jurisdiction, so the script says multi-sig is "designed, and what we build next."
- [ ] **"Multi-sig certification" means two things:** the wallet is quorum-controlled, and each covered transfer carries the quorum's approval. If CryptoSure or a carrier is meant to act as a signer, the positioning against AnchorWatch reverses.
- [ ] **CryptoSure never holds a key.** This is the sharpest line of difference in the script.
- [ ] **Business self-custody is the lead segment,** ahead of custodians and exchanges, because that is where Evertas and the Marsh facility are strongest.

## Sources this pitch draws on

- [Week 2: Problem and Solution](./week-02-problem-and-solution.md)
- [Week 3: Market Analysis](./week-03-market-analysis.md), which carries the external sources for every figure in the script
- [Pitch resources](../pitch-resources/README.md)
- [WalletBinder contract](../../contracts/WalletBinder.compact)

*Not an offer of insurance. CryptoSure is a pre-licensing company building a
proof of concept.*
