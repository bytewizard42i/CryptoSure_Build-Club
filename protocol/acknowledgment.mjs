// ============================================================================
// acknowledgment.mjs — "I have read this agreement and I understand it."
// ============================================================================
// The last thing a holder does before a policy is bound: sign a plain
// statement with the wallet being insured. The statement names the cover
// class, the wallet, and a fingerprint of the exact terms, so the signature
// cannot be reused for a different class, different terms or another wallet.
//
// WHY IT MATTERS
//   It answers the oldest insurance dispute, "I never agreed to that", with
//   something checkable: the exact terms are fingerprinted into what was
//   signed. The signed statement becomes part of the private agreement, and
//   the agreement's fingerprint is what PolicyBinder seals on-chain.
//
// The check is made against the statement WE build from the terms on file,
// never against text supplied by the holder.
// ============================================================================

import { createHash } from 'node:crypto';
import { canonicalJson } from './encoding.mjs';

// Fingerprint of the terms the holder is agreeing to.
export function hashPolicyTerms(policyTerms) {
  return createHash('sha256').update(`cryptosure:policy-terms:${canonicalJson(policyTerms)}`, 'utf8').digest('hex');
}

export function buildAcknowledgmentStatement({ coverClass, policyTerms, wallet }) {
  return [
    'CryptoSure policy acknowledgment',
    `cover class: ${coverClass}`,
    `insured wallet: ${wallet.chain}:${wallet.address}`,
    `terms fingerprint: ${hashPolicyTerms(policyTerms)}`,
    'I have read this insurance agreement and I understand what is and is not covered.'
  ].join('\n');
}
