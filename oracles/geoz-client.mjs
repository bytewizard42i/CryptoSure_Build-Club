// ============================================================================
// GeoZ client — "is this person inside a region we are licensed for?"
// ============================================================================
// GeoZ is an external black box (see oracle-endpoints.json for its repo).
// We send the regions our program is licensed for. On "yes" we learn which
// of OUR regions matched. On "no" we learn nothing about where the person is.
//
// TEST-WIRED: the subject reference is a synthetic persona id.
// ============================================================================

import { postToOracle, OracleUnavailableError } from './oracle-http.mjs';

/**
 * @returns {Promise<{inRegion: true, regionCode: string, attestedAt: number, referenceId: string}
 *                 | {inRegion: false, referenceId: string}>}
 */
export async function checkRegion({ syntheticPersonaId, allowedRegions }) {
  const answer = await postToOracle('geoz', { syntheticPersonaId, allowedRegions });

  if (answer.inRegion === false && typeof answer.referenceId === 'string') {
    return { inRegion: false, referenceId: answer.referenceId };
  }
  // A "yes" must name one of the regions we asked about, or we do not accept it.
  const looksValid =
    answer.inRegion === true &&
    typeof answer.regionCode === 'string' && allowedRegions.includes(answer.regionCode) &&
    typeof answer.referenceId === 'string';
  if (!looksValid) throw new OracleUnavailableError('The geoz oracle returned a malformed answer.');
  return answer;
}
