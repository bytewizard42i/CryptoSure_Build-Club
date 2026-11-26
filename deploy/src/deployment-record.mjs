// ============================================================================
// deployment-record.mjs — the written record of what is deployed where
// ============================================================================
// WHAT THIS IS
//   deployments/<network>.json: one file per network listing each contract's
//   address, the id of every transaction we sent, the versions used and when.
//   It contains only PUBLIC information and is meant to be committed.
//
// WHY IT MATTERS: RESUMING
//   Deploying eight contracts and ~20 wiring transactions takes many minutes
//   and any step can fail (network hiccup, out of DUST). The record is saved
//   after EVERY successful step, so running the script again skips what is
//   already there and carries on from the first missing step.
//
// SHAPE
//   {
//     "network": "preview",
//     "createdAt": "...", "updatedAt": "...",
//     "deployerAddress": "mn_addr_preview1...",
//     "versions": { compiler..., sdk packages... },
//     "contracts": { "BanListCheck": { "address", "deployTransactionId", "blockHeight", "deployedAt" }, ... },
//     "wiringSteps": { "<step id>": { "transactionId", "blockHeight", "completedAt" }, ... }
//   }
//
// IDEAS, NOT BUILT
//   IDEA: record the hash of each contract's verifier keys, so a later run can
//         warn when build/ no longer matches what is on-chain.
// ============================================================================

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DEPLOYMENTS_FOLDER } from './config.mjs';

export function deploymentRecordPath(networkName) {
  if (!/^[a-z0-9-]+$/.test(networkName)) throw new TypeError(`"${networkName}" is not a valid network name for a file.`);
  return path.join(DEPLOYMENTS_FOLDER, `${networkName}.json`);
}

/** The record for a network, or null if nothing has been deployed there by us. */
export function readDeploymentRecord(networkName) {
  const recordPath = deploymentRecordPath(networkName);
  if (!existsSync(recordPath)) return null;
  let record;
  try {
    record = JSON.parse(readFileSync(recordPath, 'utf8'));
  } catch (error) {
    throw new Error(`${recordPath} is not valid JSON (${error.message}). Next step: fix or restore the file; do not delete it, it is the only list of deployed addresses.`);
  }
  if (record.network !== networkName || typeof record.contracts !== 'object' || typeof record.wiringSteps !== 'object') {
    throw new Error(`${recordPath} does not look like a deployment record for "${networkName}".`);
  }
  return record;
}

/** A new, empty record. */
export function createDeploymentRecord({ networkName, deployerAddress, versions }) {
  const now = new Date().toISOString();
  return { network: networkName, createdAt: now, updatedAt: now, deployerAddress, versions, contracts: {}, wiringSteps: {} };
}

/**
 * Save the record. Written to a temporary file first and then renamed, so a
 * crash half-way through cannot leave a broken file behind.
 */
export function saveDeploymentRecord(record) {
  mkdirSync(DEPLOYMENTS_FOLDER, { recursive: true });
  record.updatedAt = new Date().toISOString();
  const recordPath = deploymentRecordPath(record.network);
  const temporaryPath = `${recordPath}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(record, null, 2)}\n`);
  renameSync(temporaryPath, recordPath);
}
