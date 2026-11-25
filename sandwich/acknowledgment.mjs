// ============================================================================
// Acknowledgment — "I have read this agreement and I understand it."
// ============================================================================
// The last thing an applicant does before a policy is bound: sign a plain
// statement with the wallet being insured. The statement names the policy,
// its limit, and a fingerprint of the exact terms, so the signature cannot
// be reused for a different policy or for edited terms. Only the holder of
// the wallet key can produce it, which makes it the applicant's own act.
//
// SIMULATED KEYS: same stand-in wallet keys as wallet-control.mjs. A real
// integration uses the wallet's native message signing.
// ============================================================================

import { createHash, sign, verify } from 'node:crypto';
import { canonicalJson } from './encoding.mjs';

// Fingerprint of the terms the applicant is agreeing to.
export function hashPolicyTerms(policyTerms) {
  return createHash('sha256').update(`cryptosure:policy-terms:${canonicalJson(policyTerms)}`, 'utf8').digest('hex');
}

export function buildAcknowledgmentStatement({ policyTerms, wallet }) {
  return [
    'CryptoSure policy acknowledgment',
    `policy: ${policyTerms.policyId}`,
    `cover limit: USD ${policyTerms.coverage.limitUsd}`,
    `insured wallet: ${wallet.chain}:${wallet.address}`,
    `terms fingerprint: ${hashPolicyTerms(policyTerms)}`,
    'I have read this insurance agreement, I passed the required CryptoSureEdu test, and I understand what is and is not covered.'
  ].join('\n');
}

export function signAcknowledgment(walletPrivateKey, statement) {
  return sign(null, Buffer.from(statement, 'utf8'), walletPrivateKey).toString('hex');
}

// Checks the signature against the statement WE build from the policy and
// wallet on file, never against text supplied by the applicant.
export function verifyAcknowledgment({ policyTerms, wallet, walletPublicKey, signatureHex }) {
  if (typeof signatureHex !== 'string' || !/^[0-9a-f]{128}$/.test(signatureHex)) return false;
  const statement = buildAcknowledgmentStatement({ policyTerms, wallet });
  return verify(null, Buffer.from(statement, 'utf8'), walletPublicKey, Buffer.from(signatureHex, 'hex'));
}
