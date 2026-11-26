// ============================================================================
// seed-file.mjs — read the deployer wallet's seed, and never let it leak
// ============================================================================
// WHAT A SEED IS
//   64 hexadecimal characters (32 bytes) from which every key of a wallet is
//   derived. Whoever has the seed has the wallet. So this file has ONE job:
//   hand the seed to the wallet code in memory, and nothing else.
//
// RULES THIS FILE KEEPS
//   - The seed is read at run time from a file OUTSIDE this repository.
//   - It is never printed, logged, written to disk, or put in an error message.
//   - Error messages name the FILE and what is wrong with its shape, never
//     its contents.
//
// FILE FORMAT
//   The seed is the LAST non-empty line of the file. Lines above it may be
//   comments or notes.
// ============================================================================

import { existsSync, readFileSync } from 'node:fs';
import { deployerSeedFilePath, deployerSeedFileWasChosenExplicitly } from './config.mjs';

const SEED_PATTERN = /^[0-9a-fA-F]{64}$/;

/** True if the text is exactly 64 hex characters. Says nothing about the text itself. */
export function looksLikeSeedHex(text) {
  return typeof text === 'string' && SEED_PATTERN.test(text);
}

/**
 * Read the deployer's seed as a lowercase hex string.
 * @param {string} [seedFilePath]  defaults to CRYPTOSURE_DEPLOYER_SEED_FILE or the built-in path
 */
export function readDeployerSeedHex(seedFilePath = deployerSeedFilePath()) {
  if (!existsSync(seedFilePath)) {
    throw new Error(
      `The deployer seed file was not found at: ${seedFilePath}\n` +
      'Next step: set CRYPTOSURE_DEPLOYER_SEED_FILE to the path of a file whose last line is the 64-hex-character seed.'
    );
  }
  const nonEmptyLines = readFileSync(seedFilePath, 'utf8').split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '');
  const lastLine = nonEmptyLines.at(-1);
  if (!looksLikeSeedHex(lastLine)) {
    // Deliberately does NOT echo the line.
    throw new Error(
      `The last line of ${seedFilePath} is not a 64-character hexadecimal seed.\n` +
      'Next step: check the file by eye (do not paste it anywhere). The seed must be alone on the last line.'
    );
  }
  return lastLine.toLowerCase();
}

/**
 * The seed to deploy with on a given network.
 *
 * Public networks: always the deployer seed file.
 * The local rehearsal chain: the public genesis test seed built into that
 * network's configuration (it is the only funded wallet there), unless a
 * seed file was named explicitly with CRYPTOSURE_DEPLOYER_SEED_FILE.
 *
 * @param {object} network  from config.mjs getNetworkConfig()
 */
export function readSeedHexForNetwork(network) {
  if (network.wellKnownGenesisSeedHex !== undefined && !deployerSeedFileWasChosenExplicitly()) {
    return network.wellKnownGenesisSeedHex;
  }
  return readDeployerSeedHex();
}
