// ============================================================================
// Shared plumbing for calling an external black-box oracle over HTTP.
// ============================================================================
// CryptoSure knows three things about each oracle: where it lives, what to
// send, and what comes back. Nothing about how it decides. Those three things
// are in oracle-endpoints.json; this file does the actual network call.
// ============================================================================

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ENDPOINTS_PATH = fileURLToPath(new URL('./oracle-endpoints.json', import.meta.url));
export const ORACLE_ENDPOINTS = JSON.parse(readFileSync(ENDPOINTS_PATH, 'utf8'));

const REQUEST_TIMEOUT_MILLISECONDS = 5_000;

// Thrown when the oracle cannot be reached or answers with something
// unusable. Distinct from a "no" answer, which is a normal result.
export class OracleUnavailableError extends Error {}

export function resolveOracleUrl(oracleName) {
  const endpoint = ORACLE_ENDPOINTS[oracleName];
  return process.env[endpoint.urlEnvVar] ?? endpoint.defaultUrl;
}

export async function postToOracle(oracleName, requestBody) {
  const endpoint = ORACLE_ENDPOINTS[oracleName];
  const url = resolveOracleUrl(oracleName) + endpoint.route;

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MILLISECONDS)
    });
  } catch (error) {
    throw new OracleUnavailableError(
      `Could not reach the ${oracleName} oracle at ${url} (${error.cause?.code ?? error.name}).\n` +
      `Next step: start it from its own repository (${endpoint.repository}):\n` +
      `  cd ${endpoint.localPath} && node ${endpoint.serverEntry}\n` +
      `or run "npm run oracles" here, or set ${endpoint.urlEnvVar} to where it is running.`
    );
  }

  const responseBody = await response.json().catch(() => null);
  if (!response.ok || responseBody === null || typeof responseBody !== 'object') {
    throw new OracleUnavailableError(
      `The ${oracleName} oracle rejected the request (HTTP ${response.status}): ${responseBody?.error ?? 'no readable body'}`
    );
  }
  return responseBody;
}
