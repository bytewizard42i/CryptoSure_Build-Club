// ============================================================================
// KYCz client — "is this person verified?"
// ============================================================================
// KYCz is an external black box (see oracle-endpoints.json for its repo).
// We send a subject reference and the holder's CryptoSure-scoped public key.
// We get back yes/no. On "no" we are told nothing about why; we only get a
// referenceId the KYCz operator can look up on their side.
//
// TEST-WIRED: the subject reference is a synthetic persona id. With the real
// facade it becomes a KYCz assertion (a ZK proof that KYC passed).
// ============================================================================

import { postToOracle, OracleUnavailableError } from './oracle-http.mjs';

const HEX_64_PATTERN = /^[0-9a-f]{64}$/;

/**
 * @returns {Promise<{verified: true, level: number, credentialId: string, salt: string, expiresAt: number, referenceId: string}
 *                 | {verified: false, referenceId: string}>}
 */
export async function requestKycCredential({ syntheticPersonaId, presenterPublicKeyHex, verifierNonceHex }) {
  const answer = await postToOracle('kycz', {
    presenterPk: presenterPublicKeyHex,
    verifierNonce: verifierNonceHex,
    kyczAssertion: { syntheticPersonaId }
  });

  // Validate what came back. An oracle is external data: never trust its shape.
  if (answer.verified === false && typeof answer.referenceId === 'string') {
    return { verified: false, referenceId: answer.referenceId };
  }
  const looksValid =
    answer.verified === true &&
    Number.isInteger(answer.level) && answer.level >= 1 && answer.level <= 255 &&
    typeof answer.credentialId === 'string' && HEX_64_PATTERN.test(answer.credentialId) &&
    typeof answer.salt === 'string' && HEX_64_PATTERN.test(answer.salt) &&
    Number.isSafeInteger(answer.expiresAt) && answer.expiresAt > 0 &&
    typeof answer.referenceId === 'string';
  if (!looksValid) throw new OracleUnavailableError('The kycz oracle returned a malformed answer.');
  return answer;
}
