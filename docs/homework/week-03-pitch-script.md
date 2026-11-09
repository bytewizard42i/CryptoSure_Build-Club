# Week 3 — Three-Minute Pitch (Draft for Rehearsal)

**Build Club assignment 03 | Due November 9, 2026 | Presenter: John Santi**

This is a spoken script, not a technical architecture presentation. Approximately 360 words; time it aloud and trim to three minutes.

## Script

Imagine having a valuable asset that you can prove you own, but finding almost nobody willing to insure it.

That's the situation for millions of people and businesses holding cryptocurrency. A company holding digital assets on its balance sheet needs protection. A custodian wants to reassure its clients. And someone holding their own crypto may have no practical way to insure a stolen wallet or a disastrous transfer.

The problem isn't simply that crypto is risky. It's that today's insurance process often demands sensitive information: your identity, where you live, and details about your wallet and holdings. For privacy-conscious customers, that's a serious barrier. And for insurers, collecting that information creates another security burden.

We're building CryptoSure to change that.

CryptoSure is a proposed insurance platform for digital assets, with two products in development: ongoing wallet coverage and protection for individual high-value transfers. Our initial business approach is to work with licensed insurance partners rather than pretend we can issue regulated policies ourselves.

The distinctive piece is how we establish eligibility.

Using Midnight's zero-knowledge technology, our WalletBinder contract is designed to confirm three things: that a wallet passes sanctions screening, that its holder has completed the required identity verification with a trusted issuer, and that the holder is in an eligible jurisdiction. The goal is to prove those conditions without publishing the person's identity or private details on-chain.

That matters to customers because they can seek protection without unnecessarily exposing their financial lives. It matters to insurance partners because they can receive evidence of eligibility without taking custody of every underlying personal record.

And this isn't just a slide-deck idea. We've compiled a WalletBinder prototype with eighteen circuits and built a demonstration fixture using fictional data. The proof-of-concept is real development work, but it is not yet a live, carrier-backed insurance product. Underwriting, regulatory review, real-world integrations, and claims operations remain ahead.

Why am I building it? Because crypto shouldn't have to choose between financial protection and privacy. I believe the next generation of digital-asset insurance should be verifiable, commercially responsible, and designed to minimize unnecessary disclosure.

CryptoSure's ambition is to make that possible—and to show how Midnight can enable a regulated financial service that conventional systems struggle to deliver.

## Delivery notes

- Start with the uninsured-asset image, not an architecture diagram.
- Speak slowly at the opening and after “We're building CryptoSure to change that.”
- Keep the prototype-versus-live-product distinction explicit.
- Do not imply a carrier has agreed to underwrite coverage or that policies are available today.
- Ask a listener outside the team: “Where did I lose you, and what would you want clarified?”
