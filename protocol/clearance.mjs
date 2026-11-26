// ============================================================================
// clearance.mjs — clear one wallet: ask the providers, then let the contracts
// decide
// ============================================================================
// THE FLOW FOR ONE WALLET AND ONE PROFILE
//
//   for each check the profile requires, cheapest first:
//     1. ASK      the provider (a black box): pass, refuse, or unknown?
//                 refuse  -> stop, the wallet is NOT CLEARED
//                 unknown -> stop, the wallet is UNSURE
//     2. RECORD   the provider's operator seals the result into that check's
//                 own contract (a hidden leaf; nothing readable)
//     3. PROVE    the holder proves, privately, that the sealed result is
//                 about them and their wallet; the contract stamps a PASS
//                 against their ticket
//   then:
//     4. GRANT    ClearanceRegistry asks every required check contract
//                 "does this ticket hold a current pass?" and, if all say
//                 yes, records the clearance with an expiry
//
// STOP AT THE FIRST FAILURE
//   Nothing after a failed check runs. Checks are tried in `checkOrder`, so a
//   cheap check that fails saves the cost of every later one.
//
// DO NOT REPEAT WHAT IS STILL GOOD
//   Each pass has its own shelf life. If the ticket already holds a current
//   pass at a sufficient level, that check is skipped and the pass is reused.
//   A ban-list pass goes stale in a day; an identity pass lasts months.
//
// THREE OUTCOMES
//   clear        every required check passed and the registry recorded it
//   unsure       a provider could not say (never seen, or unavailable)
//   not-cleared  a provider said no, or a contract refused
//
// WHO SEES WHAT
//   The caller of this function gets yes/no per step and an opaque reference.
//   Reasons stay with the providers. The chain gets hidden leaves, a ticket,
//   and passes.
//
// IDEAS, NOT BUILT
//   - running independent checks in parallel when speed matters more than
//     saving work
//   - charging per check, so a deeper profile costs more
//   - a "what would it take?" answer listing which checks are still missing
// ============================================================================

import { CHECK_NAMES } from './program.mjs';
import { ContractRejectedError } from './local-chain.mjs';
import { bytesToHex, deriveDemoSecretKey, deriveWalletHash, hexToBytes, padTo32Bytes, random32Bytes } from './encoding.mjs';

// Cheapest and most likely to fail first. A program may supply its own order.
export const DEFAULT_CHECK_ORDER = ['banList', 'walletControl', 'region', 'identity', 'education'];

/**
 * Everything one holder keeps on their own device for one wallet.
 * `privateState` is what the contracts' witnesses read; none of it is ever
 * written on-chain as-is.
 *
 * DEMO ONLY: the secret key is derived from the subject id so runs repeat.
 */
export function createHolder(program, { subjectId, wallet }) {
  const secretKey = deriveDemoSecretKey(`holder:${subjectId}`);
  const walletHash = deriveWalletHash(program.walletHashKey, wallet);
  const ticketSalt = random32Bytes();
  const pure = program.chain.pureCircuits(program.addresses.PolicyBinder);
  const holderPublicKey = pure.derive_holder_key(secretKey);
  return {
    subjectId,
    wallet,
    holderPublicKey,
    // The ticket: the public handle every pass and clearance is stamped on.
    ticket: pure.derive_ticket(holderPublicKey, walletHash, ticketSalt),
    privateState: { secretKey, walletHash, ticketSalt }
  };
}

// ---------------------------------------------------------------------------
// WHERE A PIECE OF EVIDENCE LANDS IN ITS TREE
//
// Each check contract can REVOKE one piece of evidence by blanking its leaf,
// and it takes the leaf's INDEX to say which (see the long note at the top of
// contracts/checks/IdentityCheck.compact for why an index and not a value).
// A circuit cannot hand back the index that `insert` chose, so each contract
// keeps a counter of insertions: its value just before a record call is the
// index that call will land at.
//
// So every `record` below reads its contract's counter FIRST and returns the
// index with the evidence. Whoever issued the evidence has to keep that index
// to be able to withdraw it later. Nothing on-chain links the index to a
// holder; it is bookkeeping for the issuer, like the policy record an insurer
// keeps.
// ---------------------------------------------------------------------------
function nextLeafIndex(program, checkName, counterName) {
  return Number(program.chain.publicLedger(program.checkAddress(checkName))[counterName]);
}

// ---------------------------------------------------------------------------
// One entry per check: how to ask its provider, how its operator seals the
// result, and which circuit the holder proves with. Adding a sixth check
// means adding one entry here, one contract, and one slot in the config.
// ---------------------------------------------------------------------------
const CHECK_RUNNERS = {
  banList: {
    ask: ({ providers, holder, now }) => providers.banList.screen({ wallet: holder.wallet, now }),
    async record({ program, holder, answer }) {
      const listVersion = BigInt(answer.listVersion);
      const leafIndex = nextLeafIndex(program, 'banList', 'screeningsRecorded');
      await program.chain.call(program.checkAddress('banList'), program.operators.banList, 'record_screening', { walletHash: holder.privateState.walletHash, listVersion });
      return { listVersion, leafIndex };
    },
    proveCircuit: 'prove_not_listed',
    revokeEvidenceCircuit: 'revoke_screening',
    level: () => 1
  },

  walletControl: {
    async ask({ providers, holder, now, walletSigner }) {
      const challenge = providers.walletControl.createChallenge({ wallet: holder.wallet });
      const signatureHex = await walletSigner.sign(challenge);
      return providers.walletControl.verify({ wallet: holder.wallet, challenge, signatureHex, now });
    },
    async record({ program, holder, answer }) {
      const controlAttestation = { holderPk: holder.holderPublicKey, walletHash: holder.privateState.walletHash, expiresAt: BigInt(answer.expiresAt) };
      const controlAttestationSalt = random32Bytes();
      const address = program.checkAddress('walletControl');
      const commitment = program.chain.pureCircuits(address).commit_control_attestation(controlAttestation, controlAttestationSalt);
      const leafIndex = nextLeafIndex(program, 'walletControl', 'attestationsRecorded');
      await program.chain.call(address, program.operators.walletControl, 'record_control_attestation', commitment);
      return { controlAttestation, controlAttestationSalt, leafIndex };
    },
    proveCircuit: 'prove_wallet_control',
    revokeEvidenceCircuit: 'revoke_control_attestation',
    level: () => 1
  },

  region: {
    ask: ({ providers, holder, now, program }) => providers.region.attest({ subjectId: holder.subjectId, allowedRegions: program.config.allowedRegions, now }),
    async record({ program, holder, answer }) {
      const address = program.checkAddress('region');
      const pure = program.chain.pureCircuits(address);
      const regionAttestation = { holderPk: holder.holderPublicKey, regionLeaf: pure.derive_region_leaf(padTo32Bytes(answer.regionCode)), expiresAt: BigInt(answer.expiresAt) };
      const regionAttestationSalt = random32Bytes();
      const leafIndex = nextLeafIndex(program, 'region', 'attestationsRecorded');
      await program.chain.call(address, program.operators.region, 'record_region_attestation', pure.commit_region_attestation(regionAttestation, regionAttestationSalt));
      return { regionAttestation, regionAttestationSalt, leafIndex };
    },
    proveCircuit: 'prove_in_region',
    revokeEvidenceCircuit: 'revoke_region_attestation',
    level: () => 1
  },

  identity: {
    ask: ({ providers, holder, now }) => providers.identity.verify({ subjectId: holder.subjectId, holderPublicKeyHex: bytesToHex(holder.holderPublicKey), now }),
    async record({ program, holder, answer }) {
      const identityCredential = { holderPk: holder.holderPublicKey, level: BigInt(answer.level), credentialId: hexToBytes(answer.credentialId), expiresAt: BigInt(answer.expiresAt) };
      const identityCredentialSalt = random32Bytes();
      const address = program.checkAddress('identity');
      const leafIndex = nextLeafIndex(program, 'identity', 'credentialsIssued');
      await program.chain.call(address, program.operators.identity, 'issue_credential', program.chain.pureCircuits(address).commit_identity_credential(identityCredential, identityCredentialSalt));
      return { identityCredential, identityCredentialSalt, leafIndex };
    },
    proveCircuit: 'prove_identity',
    revokeEvidenceCircuit: 'revoke_credential',
    level: (answer) => answer.level
  },

  education: {
    ask: ({ providers, holder, now }) => providers.education.certify({ subjectId: holder.subjectId, now }),
    async record({ program, holder, answer }) {
      const educationCertificate = { holderPk: holder.holderPublicKey, level: BigInt(answer.level), certificateId: hexToBytes(answer.certificateId), expiresAt: BigInt(answer.expiresAt) };
      const educationCertificateSalt = random32Bytes();
      const address = program.checkAddress('education');
      const leafIndex = nextLeafIndex(program, 'education', 'certificatesIssued');
      await program.chain.call(address, program.operators.education, 'issue_certificate', program.chain.pureCircuits(address).commit_education_certificate(educationCertificate, educationCertificateSalt));
      return { educationCertificate, educationCertificateSalt, leafIndex };
    },
    proveCircuit: 'prove_education',
    revokeEvidenceCircuit: 'revoke_certificate',
    level: (answer) => answer.level
  }
};

/**
 * Step 2 alone: the operator seals the provider's answer into the check's
 * contract. Returns the evidence the holder needs to prove it, including the
 * `leafIndex` the issuer must keep in order to revoke it later.
 *
 * Separate from proving so that tests, and real operators, can record
 * evidence and then do something other than prove it next.
 */
export async function recordCheckEvidence(program, holder, checkName, answer) {
  const runner = CHECK_RUNNERS[checkName];
  if (runner === undefined) throw new TypeError(`There is no check named "${checkName}".`);
  return runner.record({ program, holder, answer });
}

/** Step 3 alone: the holder proves evidence already recorded, and collects the pass. */
export async function proveCheck(program, holder, checkName, evidence) {
  const runner = CHECK_RUNNERS[checkName];
  if (runner === undefined) throw new TypeError(`There is no check named "${checkName}".`);
  return program.chain.call(program.checkAddress(checkName), { ...holder.privateState, ...evidence }, runner.proveCircuit, holder.ticket, BigInt(program.chain.now));
}

/**
 * Steps 2 and 3 for one check: the operator seals the provider's answer into
 * the check's contract, then the holder proves it and collects the pass.
 * Exported so tests can drive a contract directly with any answer they like,
 * including answers no honest provider would give.
 * Throws ContractRejectedError if a contract refuses.
 */
export async function recordAndProveCheck(program, holder, checkName, answer) {
  const evidence = await recordCheckEvidence(program, holder, checkName, answer);
  await proveCheck(program, holder, checkName, evidence);
  return evidence;
}

/**
 * Withdraw one piece of evidence from a check's tree, so it can never be
 * proven again. `leafIndex` is the number `recordAndProveCheck` returned with
 * the evidence; the issuer is the only party that has it.
 *
 * Takes effect for FUTURE proofs. A pass the holder already collected from
 * this evidence stays where it is until it expires, so to put a holder out
 * now, call revokePass() as well. The contracts say the same thing in
 * contracts/lib/Pass.compact.
 *
 * @param actor  the check's operator or its admin
 */
export async function revokeEvidence(program, checkName, leafIndex, actor = program.operators[checkName]) {
  const runner = CHECK_RUNNERS[checkName];
  if (runner === undefined) throw new TypeError(`There is no check named "${checkName}".`);
  if (!Number.isInteger(leafIndex) || leafIndex < 0) throw new TypeError('revokeEvidence needs the whole-number leaf index the evidence was recorded at.');
  return program.chain.call(program.checkAddress(checkName), actor, runner.revokeEvidenceCircuit, BigInt(leafIndex));
}

/**
 * End one pass now, before it expires. The ticket is already public, so this
 * names it; the reason stays with the provider.
 *
 * @param actor  the check's operator or its admin
 */
export async function revokePass(program, checkName, ticket, actor = program.operators[checkName]) {
  if (!(checkName in CHECK_RUNNERS)) throw new TypeError(`There is no check named "${checkName}".`);
  return program.chain.call(program.checkAddress(checkName), actor, 'revoke_pass', ticket);
}

/**
 * End one clearance now, before it expires. Admin only.
 *
 * This stops everything that asks `require_clearance` (PolicyBinder,
 * PairReceipt) at once. It does NOT stop the holder granting it again if the
 * underlying passes are still good: revoke those too. See
 * contracts/ClearanceRegistry.compact.
 */
export async function revokeClearance(program, ticket, profileName, actor = program.admin) {
  return program.chain.call(program.addresses.ClearanceRegistry, actor, 'revoke_clearance', ticket, padTo32Bytes(profileName));
}

// Does the ticket already hold a current pass of at least this level?
function currentPass(program, checkName, ticket, minimumLevel) {
  const passes = program.chain.publicLedger(program.checkAddress(checkName)).passes;
  if (!passes.member(ticket)) return null;
  const pass = passes.lookup(ticket);
  const stillGood = pass.validUntil > BigInt(program.chain.now) && pass.level >= BigInt(minimumLevel);
  return stillGood ? pass : null;
}

/** Read the registry: is this ticket clear for this profile right now? */
export function readClearance(program, ticket, profileName) {
  const registry = program.addresses.ClearanceRegistry;
  const clearanceId = program.chain.pureCircuits(registry).derive_clearance_id(ticket, padTo32Bytes(profileName));
  const clearances = program.chain.publicLedger(registry).clearances;
  if (!clearances.member(clearanceId)) return { clear: false, validUntil: null };
  const validUntil = Number(clearances.lookup(clearanceId));
  return { clear: validUntil > program.chain.now, validUntil };
}

/**
 * Clear one wallet for one profile.
 *
 * @param program       from deployProgram()
 * @param providers     see providers/README.md
 * @param holder        from createHolder()
 * @param {string} profileName   a profile in the program's config
 * @param {{walletSigner: {sign(text): Promise<string>}, checkOrder?: string[]}} options
 * @returns {Promise<{status: 'clear'|'unsure'|'not-cleared', profile: string, ticketHex: string,
 *                    stoppedAt: string|null, validUntil: number|null, steps: object[]}>}
 */
export async function clearWallet(program, providers, holder, profileName, { walletSigner, checkOrder = DEFAULT_CHECK_ORDER }) {
  const profile = program.config.profiles[profileName];
  if (profile === undefined || profileName.startsWith('_')) throw new TypeError(`There is no profile "${profileName}".`);
  const unknownCheck = checkOrder.find((checkName) => !CHECK_NAMES.includes(checkName));
  if (unknownCheck !== undefined) throw new TypeError(`checkOrder names an unknown check "${unknownCheck}".`);

  const steps = [];
  const finish = (status, stoppedAt, validUntil = null) => ({ status, profile: profileName, ticketHex: bytesToHex(holder.ticket), stoppedAt, validUntil, steps });
  const requiredChecks = checkOrder.filter((checkName) => (profile.minLevels[checkName] ?? 0) > 0);

  for (const checkName of requiredChecks) {
    const minimumLevel = profile.minLevels[checkName];
    const runner = CHECK_RUNNERS[checkName];

    if (currentPass(program, checkName, holder.ticket, minimumLevel) !== null) {
      steps.push({ check: checkName, passed: true, reused: true, detail: 'A current pass is already on file; not asked again' });
      continue;
    }

    // 1. ASK
    const now = program.chain.now;
    const answer = await runner.ask({ program, providers, holder, now, walletSigner });
    if (answer.outcome !== 'pass') {
      steps.push({ check: checkName, passed: false, detail: `The provider answered "${answer.outcome}" (ref ${answer.referenceId})` });
      return finish(answer.outcome === 'unknown' ? 'unsure' : 'not-cleared', checkName);
    }
    if (runner.level(answer) < minimumLevel) {
      // Fail fast: the result is real but not strong enough for this profile.
      steps.push({ check: checkName, passed: false, detail: 'The result is below what this profile requires' });
      return finish('not-cleared', checkName);
    }

    // 2. RECORD, then 3. PROVE
    try {
      await recordAndProveCheck(program, holder, checkName, answer);
    } catch (error) {
      if (!(error instanceof ContractRejectedError)) throw error;
      steps.push({ check: checkName, passed: false, detail: `The contract refused: ${error.message}` });
      return finish('not-cleared', checkName);
    }
    steps.push({ check: checkName, passed: true, reused: false, detail: 'Passed, and a pass is recorded on the ticket' });
  }

  // Already clear for this profile? Then there is nothing to record. (The
  // registry refuses to re-record a clearance that is no longer than the one
  // it has, so asking again would be turned away.)
  const existing = readClearance(program, holder.ticket, profileName);
  if (existing.clear) {
    steps.push({ check: 'grant-clearance', passed: true, reused: true, detail: 'A current clearance is already recorded' });
    return finish('clear', null, existing.validUntil);
  }

  // 4. GRANT. Needs no private input: anyone could make this call.
  try {
    const granted = await program.chain.call(program.addresses.ClearanceRegistry, {}, 'grant_clearance', holder.ticket, padTo32Bytes(profileName), BigInt(program.chain.now));
    steps.push({ check: 'grant-clearance', passed: true, detail: `The registry consulted ${granted.callTrace.length - 1} check contract(s) and recorded the clearance` });
    return finish('clear', null, Number(granted.result));
  } catch (error) {
    if (!(error instanceof ContractRejectedError)) throw error;
    steps.push({ check: 'grant-clearance', passed: false, detail: `The registry refused: ${error.message}` });
    return finish('not-cleared', 'grant-clearance');
  }
}
