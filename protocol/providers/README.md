# Providers: where the answers come from

The protocol asks five questions about a wallet and its holder. It does not
know how to answer any of them. Each answer comes from a **provider**, an
outside party treated as a black box: a question goes in, a yes or no comes
out, and the reasoning stays on the provider's side.

Swap a provider and nothing else changes. That is the point of the split.

| Provider | Question | On "pass" it returns | Feeds contract |
|---|---|---|---|
| `banList` | Is this wallet clean on the current list? | `listVersion` | `BanListCheck` |
| `walletControl` | Did the wallet's own key sign this challenge? | `expiresAt` | `WalletControlCheck` |
| `region` | Is this holder in a region we serve? | `regionCode`, `expiresAt` | `RegionCheck` |
| `identity` | Has this holder been verified, and how strongly? | `level`, `credentialId`, `expiresAt` | `IdentityCheck` |
| `education` | Has this holder passed the required course? | `level`, `certificateId`, `expiresAt` | `EducationCheck` |

## The one answer shape

Every provider method resolves to one of:

```js
{ outcome: 'pass',    ...evidence }          // yes, and here is what to record
{ outcome: 'refuse',  referenceId }          // no
{ outcome: 'unknown', referenceId }          // cannot say (never seen, service down)
```

- A provider **never returns a reason**. `referenceId` is an opaque handle
  that only the provider can look up.
- `refuse` makes a wallet **not cleared**. `unknown` makes it **unsure**.
- Times are unix seconds. Every request carries `now`, so a simulated clock
  and the provider agree on what "now" is.

## Methods

```js
providers.banList.screen({ wallet, now })
providers.walletControl.createChallenge({ wallet })                 // -> challenge text
providers.walletControl.verify({ wallet, challenge, signatureHex, now })
providers.walletControl.verifyMessage({ wallet, messageText, signatureHex })   // -> boolean
providers.region.attest({ subjectId, allowedRegions, now })
providers.identity.verify({ subjectId, holderPublicKeyHex, now })
providers.education.certify({ subjectId, now })
```

`subjectId` is whatever handle the provider uses for a person. In the mock
it is a fixture id.

## What ships here

- `mock-providers.mjs`: answers from `fixtures/mock-subjects.json`. Synthetic,
  runs anywhere, no network. This is what the tests and `npm run demo` use.

Real and test-wired providers live in their own repositories. A provider is
written by implementing the methods above; nothing in `protocol/` needs to
change.
