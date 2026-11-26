# Technical review, Nov 25 2026: concerns and how the MVP answers them

At the Build Club weekly tech stand-up a Midnight technical reviewer pressed
on how CryptoSure becomes a working product. The concerns were about the
path, not about whether the idea is worth pursuing. This page records them
and says plainly which ones the MVP answers, which it avoids by scope, and
which are still open.

Source: an AI-generated summary of the call, not a transcript. Where a
"possible answer" below is ours and not the reviewer's, it says so.

## The concerns

| # | Concern | Pitfall if ignored |
|---|---|---|
| 1 | **No clear way to insure a transfer.** There is no built-in hook to detect a transfer and offer cover. It needs wallet integration or routing the transfer through a contract. | Designing around a pop-up that no wallet supports. |
| 2 | **Control sounds custodial.** The controls described sounded like custody, and token-specific controls may not reach other assets without pulling them into a contract. | Finding out late that the design needs custody, which breaks the product's promise. |
| 3 | **Visibility versus privacy.** A contract cannot watch shielded activity; the transactions would have to be unshielded. | Cover that depends on information the system cannot see. |
| 4 | **Dependence on a wallet provider.** An integration adds dependencies to the wallet. | A working product that cannot reach users. |
| 5 | **Reputation risk for the wallet.** A glitchy button damages the wallet's name even if CryptoSure carries the financial liability. | Assuming a payout fixes a partner's UX problem. |
| 6 | **Weak partner incentive, and update control.** With no revenue or distribution, why would a wallet adopt an outside stack, and what stops our updates changing their app? | Overrating the partnership pitch; underrating their maintenance burden. |
| 7 | **Too much at once.** Wallet cover, transfer cover, privacy and integrations together, before anything runs. | Never shipping. |

**The reviewer's recommendation:** review the repo together and narrow the
next milestone to an MVP that processes a transaction on pre-prod.

## How the MVP answers them

The MVP does one thing: it **clears a wallet** against a set of checks and
records the result on Midnight without revealing who the holder is. A
cleared wallet can then be checked as one end of a transfer, or bound to a
policy. Nothing in it intercepts, holds, or blocks a transfer.

| # | Status | Answer |
|---|---|---|
| 1 | Avoided by scope | The MVP insures a wallet at rest. It does not detect or intercept transfers. Transfer cover is later work and will start as a user-initiated flow, not a wallet hook. |
| 2 | Answered | Non-custodial by construction. The contract never holds an asset or a key. The only thing a holder does with the insured wallet is sign two messages. |
| 3 | Answered for the MVP, open beyond it | The contract watches nothing. The holder generates the proof; the chain sees roots, a nullifier and a counter. What evidence a claim on a shielded asset needs is not designed yet. |
| 4 | Avoided by scope | The MVP is headless. It needs no wallet's cooperation: any wallet that can sign a message works. |
| 5 | Avoided by scope | No code of ours runs inside a wallet, so there is no button to glitch. |
| 6 | Deferred | No partnership is asked for. The intent is to show a standalone flow with real usage first. If an integration ever happens, releases would be partner-approved. That last point is our position, not something the reviewer agreed. |
| 7 | Accepted | The milestone is exactly the reviewer's: one wallet cleared and bound, with real proofs, on pre-prod. |

## Gaps named on Nov 25, and where they stand now

The MVP was rebuilt as separate contracts after this review. Status of the
gaps listed in the first version of this page:

| Gap | Now |
|---|---|
| The identity level a policy requires was passed in by the caller | **Closed.** `PolicyBinder` reads the required profile from the ledger, and the registry reads each minimum level from the profile. |
| Education and the signed acknowledgment were not checked by a contract | **Education closed:** it is a check contract with its own pass. **Acknowledgment unchanged:** verified off-chain; the contract stores a hash that commits to it. |
| Wallet control was checked off-chain only | **Partly closed.** It is now a check contract, and a clearance cannot be granted without its pass. The signature itself is still verified off-chain by an operator. |
| The demo runs the compiled contracts locally | **Unchanged.** No network deployment and no generated proofs yet. Wallet signatures use stand-in keys. |

Current design and limits: [`protocol.md`](protocol.md).

## Still open

- How transfer cover works without interception or custody.
- Claim evidence for shielded assets.
- Whether any wallet provider would want an integration, and on what terms.
