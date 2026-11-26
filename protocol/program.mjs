// ============================================================================
// program.mjs — stand up one CryptoSure program: deploy and wire the contracts
// ============================================================================
// A "program" is one working set of the eight contracts, wired together:
//
//   five check contracts ──► ClearanceRegistry ──► PolicyBinder
//   (each answers                (turns passes into       (binds a policy to
//    require_pass)                one clearance)           a cleared wallet)
//                                        └──────────────► PairReceipt
//                                                         (two clear wallets,
//                                                          one dated receipt)
//
// Deploying them separately is what makes the design modular: any one can be
// replaced by deploying a new contract and repointing a slot or a registry
// reference. Nothing else has to be redeployed.
//
// This file does the wiring an administrator would do once, by hand or by
// script, on a real network:
//   1. deploy each contract, naming its first admin as it is deployed
//   2. (nothing: there is no separate "claim" step for a stranger to win)
//   3. appoint the operator each check trusts
//   4. plug each check into its slot in the ClearanceRegistry
//   5. define the profiles and cover classes from config/program.json
//   6. point PolicyBinder and PairReceipt at the ClearanceRegistry
//
// IDEAS, NOT BUILT
//   - a different admin key per contract (today one demo admin runs them all)
//   - a migration script that swaps one check for a new version on a live
//     program and proves old clearances still verify
// ============================================================================

import { LocalChain } from './local-chain.mjs';
import { deriveDemoSecretKey, padTo32Bytes } from './encoding.mjs';

// Which contract answers for which named check.
const CHECK_CONTRACTS = {
  banList: 'BanListCheck',
  region: 'RegionCheck',
  identity: 'IdentityCheck',
  education: 'EducationCheck',
  walletControl: 'WalletControlCheck'
};

export const CHECK_NAMES = Object.keys(CHECK_CONTRACTS);

const SLOT_COUNT = 8;

// Turns { banList: 1, identity: 2 } into the eight numbers the contract
// stores, using the program's slot numbering. Unknown names are an error:
// a typo must not silently mean "not required".
export function minLevelsVector(slots, minLevelsByName) {
  const vector = Array.from({ length: SLOT_COUNT }, () => 0n);
  for (const [checkName, level] of Object.entries(minLevelsByName)) {
    if (!(checkName in slots) || checkName.startsWith('_')) throw new TypeError(`Unknown check "${checkName}" in a profile.`);
    if (!Number.isInteger(level) || level < 0 || level > 255) throw new RangeError(`Level for "${checkName}" must be a whole number from 0 to 255.`);
    vector[slots[checkName]] = BigInt(level);
  }
  return vector;
}

function namedEntries(section) {
  return Object.entries(section).filter(([name]) => !name.startsWith('_'));
}

/**
 * Deploy and wire a whole program on a LocalChain.
 *
 * @param {object} programConfig   the parsed config/program.json (or a private equivalent)
 * @param {{startTime?: number}} [options]
 * @returns the program: chain, contract addresses, role holders, and the config
 */
export async function deployProgram(programConfig, options = {}) {
  const chain = new LocalChain(options);

  // DEMO ONLY: one admin and one operator per check, with repeatable keys.
  const admin = { secretKey: deriveDemoSecretKey('program-admin') };
  const operators = Object.fromEntries(CHECK_NAMES.map((checkName) => [checkName, { secretKey: deriveDemoSecretKey(`operator:${checkName}`) }]));

  // 1: deploy everything. Each contract is told who its first admin is in
  // the same step, so it is never without an owner.
  const { derive_role_key } = await LocalChain.pureCircuitsOf('ClearanceRegistry');
  const roleKeyOf = (actor) => derive_role_key(actor.secretKey);
  const addresses = {};
  for (const contractName of [...Object.values(CHECK_CONTRACTS), 'ClearanceRegistry', 'PairReceipt', 'PolicyBinder']) {
    addresses[contractName] = await chain.deploy(contractName, roleKeyOf(admin));
  }

  // 3 + 4: appoint each check's operator and plug the check into its slot.
  const slots = Object.fromEntries(namedEntries(programConfig.slots));
  for (const checkName of CHECK_NAMES) {
    const checkAddress = addresses[CHECK_CONTRACTS[checkName]];
    await chain.call(checkAddress, admin, 'set_operator', roleKeyOf(operators[checkName]), true);
    await chain.call(addresses.ClearanceRegistry, admin, 'register_check', BigInt(slots[checkName]), LocalChain.contractReference(checkAddress));
  }

  // 5: profiles, cover classes, regions.
  for (const [profileName, profile] of namedEntries(programConfig.profiles)) {
    await chain.call(addresses.ClearanceRegistry, admin, 'define_profile', padTo32Bytes(profileName), minLevelsVector(slots, profile.minLevels), BigInt(profile.shelfLifeSeconds));
  }
  for (const regionCode of programConfig.allowedRegions) {
    await chain.call(addresses.RegionCheck, admin, 'add_allowed_region', padTo32Bytes(regionCode));
  }

  // 6: the two consumers of clearance.
  const registryReference = LocalChain.contractReference(addresses.ClearanceRegistry);
  await chain.call(addresses.PolicyBinder, admin, 'set_clearance_registry', registryReference);
  await chain.call(addresses.PairReceipt, admin, 'set_clearance_registry', registryReference);
  for (const [coverClass, requiredProfile] of namedEntries(programConfig.coverClasses)) {
    if (!(requiredProfile in programConfig.profiles)) throw new TypeError(`Cover class "${coverClass}" requires an unknown profile "${requiredProfile}".`);
    await chain.call(addresses.PolicyBinder, admin, 'define_cover_class', padTo32Bytes(coverClass), padTo32Bytes(requiredProfile));
  }

  return {
    chain,
    addresses,
    checkAddress: (checkName) => addresses[CHECK_CONTRACTS[checkName]],
    admin,
    operators,
    slots,
    roleKeyOf,
    config: programConfig,
    // DEMO ONLY: the secret behind every wallet hash (see encoding.mjs).
    walletHashKey: deriveDemoSecretKey('program-wallet-hash-key')
  };
}
