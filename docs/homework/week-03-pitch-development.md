# Week 3: Pitch Development

Build Club week 3 homework. A three-minute spoken pitch covering the problem,
who has it, what we built, and why us. The architecture diagram is cut on
purpose. Speak it, do not read it.

About 470 words. Timed aloud at a conversational pace this lands right around
three minutes.

## The script

Crypto is a two and a half trillion dollar asset class, and almost none of it
is insured.

That is strange, because crypto is the most insurable asset ever created.
Every loss leaves a permanent public trail. Ownership can be proven with math.
Stolen funds can be traced, frozen at exchanges, and often recovered. No
insurer in history has had evidence this good.

So why is the market empty? Because the people who need coverage most will
not hand an insurer their identity, their address, and a map of their
holdings. And an insurer that collects all of that becomes a honeypot, a
target itself. Nobody can verify a customer without collecting them. So
nothing gets written.

Who feels this? Three groups. Custodians and exchanges, who lose
institutional deals the moment a client asks "is it insured?" and the honest
answer is no. Companies holding crypto on their balance sheet, who are
self-insuring by default, which is just unallocated risk with a name. And
individuals who get drained by a phishing signature or a poisoned address
and have nowhere to turn.

That is the problem. Here is what we built.

CryptoSure is defined coverage for crypto held in wallets. A periodic policy
on a wallet, and point-of-use protection for a single high-value transfer,
which is the moment most money is actually lost. The coverage is written
down and bound to the policy, so there is no argument at claim time.

Our first instrument is called WalletBinder. It is a smart contract on
Midnight that gates a wallet onto a policy only after three checks pass
inside one zero-knowledge proof: the wallet is clear of sanctions lists, the
holder has passed KYC with a trusted issuer, and the holder lives where we
are licensed to sell. The chain learns that someone eligible bound a clean
wallet. It never learns who, where, or which wallet.

Identity stays sealed with the issuer. If a warrant is ever issued, it goes
to them, not to us. We hold nothing that can leak, and we can still prove to
a carrier that every insured wallet traces to a real, verified person.

WalletBinder is compiled today with full proving keys. It runs on simulated
data, so you can watch a planted bad address get rejected by the proof
itself. It is a working proof of concept, not a live insurance product.
Underwriting, carrier partnership, and licensing are ahead of us, and we are
honest about that.

Why us? Because we are not building a crypto toy with an insurance label. We
are building an insurance company that happens to use cryptography where it
genuinely helps. Carrier-backed. Pennsylvania first. Business customers
first. Three principles run through everything: love the customer, respect
the risk, honor the promise.

We will do one thing, insure crypto in wallets, and do it right.

## Who, what, why, in one glance

- Problem: the most insurable asset in history is almost entirely uninsured,
  because verification requires collection and collection kills trust.
- Who has it: custodians and exchanges, treasury-holding companies, and
  self-custody holders.
- What we built: defined wallet and transfer coverage, gated by WalletBinder,
  a compiled Compact contract that proves eligibility without disclosure.
- Why us: insurance-first discipline, privacy in the mechanism rather than in
  a promise, Pennsylvania-first carrier-backed path.

## What changed after practice

Pending. This line will be filled in after the pitch is delivered to someone
outside the team, with the actual observation and the actual edit. It will
not be invented in advance.

## Delivery notes

- The hook is the contradiction: most insurable asset, least insured. Let
  that sentence breathe.
- Say "zero-knowledge proof" once, then just say "the proof."
- Do not describe contract internals, Merkle trees, circuits, or issuers in
  any more depth than the script already does. That is the architecture
  diagram sneaking back in.
- Never imply a carrier has agreed, a license is held, or coverage is for
  sale today.

## Sources this pitch draws on

- [Week 2: Problem and Solution](./week-02-problem-and-solution.md)
- [Pitch resources](../pitch-resources/README.md)
- [WalletBinder contract](../../contracts/WalletBinder.compact)

*Not an offer of insurance. CryptoSure is a pre-licensing company building a
proof of concept.*
