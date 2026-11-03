# Week 2 — Problem & Solution Definition

Build Club week 2 homework. Problem statement in three lengths, the solution
paragraph, and why this has to be built this way.

## Problem — one sentence

Over a hundred billion dollars of crypto sits uninsured, not because it can't
be insured but because the people who need coverage most won't hand an insurer
their identity, their address, and their wallet.

## Problem — five sentences

Over a hundred billion dollars of crypto sits in wallets with no insurance.
Custodians lose institutional deals when clients ask "is it insured?",
companies carry the risk raw on their balance sheets, and individuals who get
drained have nowhere to turn. The strange truth is that crypto is the most
insurable asset ever made — every loss leaves a permanent public trail and
ownership is provable — so the blocker is not the risk, it is the process.
An insurer that demands full identity, addresses, and holdings becomes a data
honeypot and loses exactly the customers it needs. No insurer exists that can
verify a customer without collecting them.

## Problem — fifteen sentences

Roughly 1 to 3 percent of digital assets carry any insurance, versus about
7 percent of GDP in the traditional economy. That gap is not a demand problem.
Custodians, exchanges, and wallet providers are asked by institutional clients
and regulators whether customer assets are insured, and the honest answer is
usually no. Companies holding crypto on their balance sheets self-insure by
default, which is just unallocated risk with a name. Self-custody holders lose
billions a year to phishing, drained wallets, and wrong-address transfers with
no product at the moment of risk. The irony is that crypto is the most
insurable asset class ever created. Every loss leaves a permanent, public,
timestamped trail. Ownership can be proven cryptographically. Stolen funds can
be traced, frozen at exchanges, and often recovered. No insurer in history has
priced a risk on evidence this good. What it lacks is the insurer. Today's
alternatives are crime policies whose exclusions swallow the actual loss
modes, custody-side specialists writing for institutions only, and on-chain
mutuals covering smart-contract failure, not wallets. The real blocker is
privacy: the people who most need coverage will not hand an insurer their
identity, their address, and a map of their holdings. An insurer that collects
all of that becomes a regulatory liability and a hack target itself. So the
market stays empty on both sides. The problem to solve is verification without
collection: an insurer that can prove a customer qualifies without ever
learning who they are.

## Solution

CryptoSure is privacy-preserving insurance for crypto held in wallets. We
write defined coverage — a periodic wallet policy and point-of-use protection
for a single high-value transfer — and our first instrument, the WalletBinder,
is a smart contract that gates a wallet onto a policy only after three checks
pass inside one zero-knowledge proof: the wallet is clear of sanctions lists,
the holder passed KYC (Know Your Customer, the regulated identity check) with
a trusted issuer, and the holder lives where we are licensed to sell. The
network learns that someone eligible insured a clean wallet; it never learns
who, where, or which wallet. Identity stays sealed with the issuer, who holds
a trap door reachable only by lawful warrant, so we can prove to a carrier
that every insured wallet traces to a real verified person while holding
nothing ourselves that could leak. Coverage is written down and bound to the
policy, and claims become forensic recovery operations — which is the part
that makes the economics work: the trail never disappears, so payouts become
recoveries.

## Why it has to be built this way

A spreadsheet insurer still has to see everything — the wallet, the person,
the jurisdiction — to check it, which means we become the honeypot that loses
the exact customers the product exists for. The privacy must live in the
mechanism, not in a policy promise: the three eligibility checks run inside a
zero-knowledge proof on Midnight, so the chain records that someone qualified,
never who they are. It also cannot be an ordinary app because the credential
is sealed with a third-party trusted issuer — we hold a proof, not the
person's file — so lawful access exists through a warrant on the issuer while
we hold nothing. No other chain lets a contract verify those facts without
publishing them.

## Status

Contract compiled on compactc 0.35.0 (language 0.27) with full proving keys,
18 circuits. The demo fixture ships 20 fictional addresses, half planted as
banned, so the gate can be exercised end to end on simulated feeds without
real identity data.
