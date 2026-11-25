// ============================================================================
// Start the KYCz and GeoZ test-wired oracles from their own repositories.
// ============================================================================
// The oracles are separate projects. In a local checkout they sit next to
// this repo (see localPath in oracles/oracle-endpoints.json). This helper
// launches each one as its own process, the same as running
//   cd ../KYCz && node src/oracle/server.mjs
// in two more terminals, and tells the clients where they are listening.
//
// Run directly to keep them up until Ctrl+C:   npm run oracles
// ============================================================================

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ORACLE_ENDPOINTS } from '../oracles/oracle-http.mjs';

const REPOSITORY_ROOT = fileURLToPath(new URL('..', import.meta.url));
const STARTUP_TIMEOUT_MILLISECONDS = 10_000;

export function findOracleServerEntry(oracleName) {
  const endpoint = ORACLE_ENDPOINTS[oracleName];
  const serverEntry = resolve(REPOSITORY_ROOT, endpoint.localPath, endpoint.serverEntry);
  return existsSync(serverEntry) ? serverEntry : null;
}

// Which oracle repos are missing from this machine (empty array = all present).
export function missingOracleRepositories() {
  return Object.keys(ORACLE_ENDPOINTS).filter((name) => !name.startsWith('_') && findOracleServerEntry(name) === null);
}

function startOneOracle(oracleName, port, { quiet }) {
  const endpoint = ORACLE_ENDPOINTS[oracleName];
  const serverEntry = findOracleServerEntry(oracleName);
  if (serverEntry === null) {
    throw new Error(
      `The ${oracleName} oracle repository was not found at ${endpoint.localPath}.\n` +
      `It is a private repository (${endpoint.repository}). Clone it next to this repo, ` +
      `or set ${endpoint.urlEnvVar} to an oracle that is already running.`
    );
  }

  const child = spawn(process.execPath, [serverEntry], {
    env: { ...process.env, [endpoint.portEnvVar]: String(port) },
    stdio: ['ignore', 'pipe', 'inherit']
  });

  return new Promise((resolveStarted, rejectStarted) => {
    const startupTimer = setTimeout(() => {
      child.kill();
      rejectStarted(new Error(`The ${oracleName} oracle did not start within ${STARTUP_TIMEOUT_MILLISECONDS / 1000}s.`));
    }, STARTUP_TIMEOUT_MILLISECONDS);

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      if (!quiet) process.stdout.write(text);
      if (text.includes('listening')) {
        clearTimeout(startupTimer);
        // Point this process's oracle clients at the port we just started.
        process.env[endpoint.urlEnvVar] = `http://127.0.0.1:${port}`;
        resolveStarted(child);
      }
    });
    child.once('exit', (exitCode) => {
      clearTimeout(startupTimer);
      rejectStarted(new Error(`The ${oracleName} oracle exited during startup (code ${exitCode}). Is port ${port} already in use?`));
    });
  });
}

/**
 * Start both oracles. Returns a function that stops them.
 * @param {{kyczPort?: number, geozPort?: number, quiet?: boolean}} [options]
 */
export async function startOracles({ kyczPort = 4101, geozPort = 4102, quiet = false } = {}) {
  const started = [];
  try {
    started.push(await startOneOracle('kycz', kyczPort, { quiet }));
    started.push(await startOneOracle('geoz', geozPort, { quiet }));
  } catch (error) {
    started.forEach((child) => child.kill());
    throw error;
  }
  return () => started.forEach((child) => child.kill());
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const stopOracles = await startOracles();
  console.log('Both oracles are up (test-wired). Press Ctrl+C to stop them.');
  process.on('SIGINT', () => { stopOracles(); process.exit(0); });
}
