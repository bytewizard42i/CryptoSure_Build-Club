// ============================================================================
// network-program.mjs — one CryptoSure program on a network: who, what, wiring
// ============================================================================
// WHAT THIS IS
//   The network counterpart of protocol/program.mjs. That file deploys and
//   wires a program on the local stand-in in one go. On a network the same
//   work is ~27 transactions that can each fail, so here it is expressed as
//   DATA: an ordered list of deploys and an ordered list of wiring steps,
//   each with a stable id. deploy-program.mjs walks the lists and skips
//   whatever the deployment record already has. That is what makes it
//   resumable.
//
// THE SAME ORDER AS protocol/program.mjs
//   1. deploy the five checks, ClearanceRegistry, PairReceipt, PolicyBinder
//   3+4. per check: add_operator on the check, register_check on the registry
//   5. define_profile (registry) per profile; add_allowed_region (RegionCheck)
//   6. set_clearance_registry on PolicyBinder and PairReceipt;
//      define_cover_class per cover class
//
// !! DEMO KEYS — READ THIS BEFORE USING ON ANY NETWORK THAT MATTERS !!
//   The admin key and the operator keys are derived from fixed LABELS
//   (protocol/encoding.mjs deriveDemoSecretKey), exactly as the local demo
//   does. Anyone who reads this repository can derive the same keys and act
//   as admin of the deployed contracts. That is acceptable for a rehearsal
//   on a test network and for nothing else.
//   IDEA: read the admin and operator secret keys from files outside the
//         repository (like the deployer seed), one per role.
//
// REUSED FROM protocol/ RATHER THAN COPIED
//   minLevelsVector and CHECK_NAMES (program.mjs); deriveDemoSecretKey and
//   padTo32Bytes (encoding.mjs).
// ============================================================================

import { CHECK_NAMES, minLevelsVector } from '../../protocol/program.mjs';
import { deriveDemoSecretKey, padTo32Bytes } from '../../protocol/encoding.mjs';
import { NetworkChain } from './network-chain.mjs';
import { CONTRACT_NAMES_IN_DEPLOY_ORDER } from './compiled-contracts.mjs';

// Which contract answers for which named check. (The same table as
// protocol/program.mjs, which does not export it.)
export const CHECK_CONTRACTS = {
  banList: 'BanListCheck',
  region: 'RegionCheck',
  identity: 'IdentityCheck',
  education: 'EducationCheck',
  walletControl: 'WalletControlCheck'
};

// Entries of a config section, skipping "_comment" keys.
function namedEntries(section) {
  return Object.entries(section).filter(([name]) => !name.startsWith('_'));
}

/** The role holders: one admin, one operator per check. DEMO KEYS (see header). */
export function createDemoRoleHolders() {
  return {
    admin: { secretKey: deriveDemoSecretKey('program-admin') },
    operators: Object.fromEntries(CHECK_NAMES.map((checkName) => [checkName, { secretKey: deriveDemoSecretKey(`operator:${checkName}`) }]))
  };
}

/** The public "role key" a contract stores for a secret key. */
export async function createRoleKeyFunction() {
  const { derive_role_key } = await NetworkChain.pureCircuitsOf('ClearanceRegistry');
  return (actor) => derive_role_key(actor.secretKey);
}

/** Refuse a config that would wire something that does not exist. Runs before any transaction. */
export function validateProgramConfig(programConfig) {
  for (const checkName of CHECK_NAMES) {
    const slot = programConfig.slots?.[checkName];
    if (!Number.isInteger(slot) || slot < 0 || slot > 7) throw new TypeError(`config slots.${checkName} must be a whole number from 0 to 7.`);
  }
  for (const [coverClass, requiredProfile] of namedEntries(programConfig.coverClasses)) {
    if (!(requiredProfile in programConfig.profiles)) throw new TypeError(`Cover class "${coverClass}" requires an unknown profile "${requiredProfile}".`);
  }
  if (!Array.isArray(programConfig.allowedRegions)) throw new TypeError('config allowedRegions must be a list.');
}

/**
 * The wiring an administrator does once, as an ordered list of steps.
 * Each step: { id, contractName, circuitName, buildArguments(addresses) }.
 * All are sent by the admin. `id` is what the deployment record stores, so
 * it must stay stable and must be safe to use as a JSON key.
 */
export function listWiringSteps(programConfig, { roleKeyOf, operators }) {
  const slots = Object.fromEntries(namedEntries(programConfig.slots));
  const steps = [];

  // 3 + 4: appoint each check's operator and plug the check into its slot.
  for (const checkName of CHECK_NAMES) {
    const checkContract = CHECK_CONTRACTS[checkName];
    steps.push({
      id: `add-operator:${checkName}`,
      contractName: checkContract,
      circuitName: 'add_operator',
      buildArguments: () => [roleKeyOf(operators[checkName])]
    });
    steps.push({
      id: `register-check:${checkName}`,
      contractName: 'ClearanceRegistry',
      circuitName: 'register_check',
      buildArguments: (addresses) => [BigInt(slots[checkName]), NetworkChain.contractReference(addresses[checkContract])]
    });
  }

  // 5: profiles and regions.
  for (const [profileName, profile] of namedEntries(programConfig.profiles)) {
    steps.push({
      id: `define-profile:${profileName}`,
      contractName: 'ClearanceRegistry',
      circuitName: 'define_profile',
      buildArguments: () => [padTo32Bytes(profileName), minLevelsVector(slots, profile.minLevels), BigInt(profile.shelfLifeSeconds)]
    });
  }
  for (const regionCode of programConfig.allowedRegions) {
    steps.push({
      id: `add-allowed-region:${regionCode}`,
      contractName: 'RegionCheck',
      circuitName: 'add_allowed_region',
      buildArguments: () => [padTo32Bytes(regionCode)]
    });
  }

  // 6: the two consumers of clearance.
  for (const consumerContract of ['PolicyBinder', 'PairReceipt']) {
    steps.push({
      id: `set-clearance-registry:${consumerContract}`,
      contractName: consumerContract,
      circuitName: 'set_clearance_registry',
      buildArguments: (addresses) => [NetworkChain.contractReference(addresses.ClearanceRegistry)]
    });
  }
  for (const [coverClass, requiredProfile] of namedEntries(programConfig.coverClasses)) {
    steps.push({
      id: `define-cover-class:${coverClass}`,
      contractName: 'PolicyBinder',
      circuitName: 'define_cover_class',
      buildArguments: () => [padTo32Bytes(coverClass), padTo32Bytes(requiredProfile)]
    });
  }
  return steps;
}

/** Contract name -> address, from a deployment record. */
export function addressesFromRecord(record) {
  return Object.fromEntries(Object.entries(record.contracts).map(([contractName, entry]) => [contractName, entry.address]));
}

/**
 * Build the `program` object the protocol code expects (the same shape
 * protocol/program.mjs deployProgram() returns), for a program that is
 * ALREADY deployed and wired on a network.
 *
 * @param {{chain: NetworkChain, record: object, programConfig: object}} input
 */
export async function loadDeployedProgram({ chain, record, programConfig }) {
  validateProgramConfig(programConfig);
  const missingContracts = CONTRACT_NAMES_IN_DEPLOY_ORDER.filter((contractName) => record.contracts[contractName] === undefined);
  const roleHolders = createDemoRoleHolders();
  const roleKeyOf = await createRoleKeyFunction();
  const missingSteps = listWiringSteps(programConfig, { roleKeyOf, operators: roleHolders.operators }).filter((step) => record.wiringSteps[step.id] === undefined);
  if (missingContracts.length > 0 || missingSteps.length > 0) {
    throw new Error(
      `The program on "${record.network}" is not completely deployed.\n` +
      `  contracts missing: ${missingContracts.join(', ') || 'none'}\n` +
      `  wiring steps missing: ${missingSteps.map((step) => step.id).join(', ') || 'none'}\n` +
      'Next step: run "npm run deploy" again; it carries on from where it stopped.'
    );
  }

  const addresses = addressesFromRecord(record);
  for (const contractName of CONTRACT_NAMES_IN_DEPLOY_ORDER) await chain.attach(contractName, addresses[contractName]);

  return {
    chain,
    addresses,
    checkAddress: (checkName) => addresses[CHECK_CONTRACTS[checkName]],
    admin: roleHolders.admin,
    operators: roleHolders.operators,
    slots: Object.fromEntries(namedEntries(programConfig.slots)),
    roleKeyOf,
    config: programConfig,
    // DEMO ONLY: the secret behind every wallet hash (see protocol/encoding.mjs).
    walletHashKey: deriveDemoSecretKey('program-wallet-hash-key')
  };
}
