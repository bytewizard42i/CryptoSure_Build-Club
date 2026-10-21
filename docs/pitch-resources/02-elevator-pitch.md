# Elevator pitch (about two minutes spoken)

Over a hundred billion dollars of crypto sits in wallets with no insurance,
and most of it belongs to companies: treasuries, custodians, exchanges,
platforms holding assets for their users. The reason is not that crypto is
uninsurable. It is the opposite. Every loss leaves a permanent, public trail.
Ownership can be proven cryptographically. Losses can be prevented, traced,
and often recovered. No other asset class gives an insurer that much
evidence. The market just has not been built for it.

CryptoSure is building it. We write two things: a periodic policy on a
wallet, and point-of-use protection for a single high-value transfer, the
moment when most money is actually lost. Coverage is defined and written
down, bound to the policy, so there is no argument at claim time about what
was covered.

The hard part of insuring crypto is that the people who want it most are
the people least willing to hand an insurer their identity, their address,
and their wallet. So we built it on Midnight. Our first instrument is a
single smart contract that gates a wallet onto a policy only after three
checks pass inside one ZK (zero-knowledge) proof: the wallet is clear of
sanctions lists, the holder has passed KYC (Know Your Customer, the
regulated identity check) with a trusted issuer, and the holder lives where
we are licensed to sell. The chain learns that someone eligible bound a
clean wallet. It never learns who, where, or which wallet.

Identity itself is a sealed black box to us. A trusted issuer, an exchange
or a government provider, verifies the person and holds the key. If a
warrant is ever issued, it goes to the issuer, not to us. We hold nothing
that could leak, and we can still prove to a carrier that every insured
wallet traces to a real, verified person through lawful process. That
sentence is the whole business.

The contract is compiled today, with full proving keys. The demo runs on
simulated identity and sanctions data so you can watch a planted bad
address get rejected by the proof itself. Swap the fake feeds for real ones
and nothing in the contracts changes.

We are going carrier-backed, Pennsylvania first, business customers first,
with a light retail product to prove the end-to-end flow. We will do one
thing, insure crypto in wallets, and do it right.
