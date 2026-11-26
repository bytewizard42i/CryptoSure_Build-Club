// ============================================================================
// dishonest-device.test.mjs — "what if the holder's own device lies?"
// ============================================================================
// A witness is a private input supplied by the caller's own device. A
// dishonest caller controls that device and can make any witness return
// anything. A contract is only as safe as its checks on what witnesses hand
// back.
//
// Each test here swaps in a LYING witness and expects the contract to refuse.
// The honest witnesses used everywhere else can never catch these bugs,
// because they never lie.
//
// History: the first version of the contracts trusted the Merkle path a
// witness returned without checking it was for the right leaf. Every test in
// the first block below passed the wrong way round until that was fixed
// (see contracts/lib/Membership.compact).
// ============================================================================

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ContractRejectedError } from '../protocol/local-chain.mjs';
import { recordAndProveCheck } from '../protocol/clearance.mjs';
import { padTo32Bytes, random32Bytes, bytesToHex } from '../protocol/encoding.mjs';
import { ALL_CHECKS, freshProgram, givePasses, goodAnswer, holderFor } from './helpers.mjs';

const refuses = (promise, messagePattern) => assert.rejects(promise, (error) => error instanceof ContractRejectedError && messagePattern.test(error.message));
const WRONG_LEAF = /Merkle path is for a different leaf/;
const now = (program) => BigInt(program.chain.now);

// An honest person (Theo) gets real evidence into every tree. The cheat
// (Colin) has none, and will try to borrow Theo's place in each tree.
async function honestAndCheat() {
  const program = await freshProgram();
  const { holder: honest } = holderFor(program, 'theo-brandt');
  const { holder: cheat } = holderFor(program, 'colin-mcbride');
  const honestEvidence = await givePasses(program, honest, ALL_CHECKS);
  return { program, honest, cheat, honestEvidence };
}

describe('a borrowed Merkle path proves nothing', () => {
  test('ban list: an unscreened wallet cannot use the path of a screened one', async () => {
    const { program, honest, cheat } = await honestAndCheat();
    const banList = program.checkAddress('banList');
    const honestLeaf = program.chain.pureCircuits(banList).derive_screening_leaf({ walletHash: honest.privateState.walletHash, listVersion: 1n });
    const lyingDevice = { get_screening_path: ({ privateState, ledger }) => [privateState, ledger.screenings.findPathForLeaf(honestLeaf)] };
    await refuses(program.chain.callWithWitnesses(banList, { ...cheat.privateState, listVersion: 1n }, lyingDevice, 'prove_not_listed', cheat.ticket, now(program)), WRONG_LEAF);
    assert.equal(program.chain.publicLedger(banList).passes.member(cheat.ticket), false);
  });

  // For the four attestation checks the cheat FORGES evidence naming
  // themselves (any level, any expiry) and borrows the honest leaf's path.
  const FORGERIES = [
    ['identity', 'prove_identity', 'credentials', 'commit_identity_credential', 'identityCredential', 'identityCredentialSalt', 'get_identity_credential_path',
      (cheat) => ({ holderPk: cheat.holderPublicKey, level: 255n, credentialId: random32Bytes(), expiresAt: 18446744073709551615n })],
    ['education', 'prove_education', 'certificates', 'commit_education_certificate', 'educationCertificate', 'educationCertificateSalt', 'get_education_certificate_path',
      (cheat) => ({ holderPk: cheat.holderPublicKey, level: 255n, certificateId: random32Bytes(), expiresAt: 18446744073709551615n })],
    ['walletControl', 'prove_wallet_control', 'attestations', 'commit_control_attestation', 'controlAttestation', 'controlAttestationSalt', 'get_control_attestation_path',
      (cheat) => ({ holderPk: cheat.holderPublicKey, walletHash: cheat.privateState.walletHash, expiresAt: 18446744073709551615n })],
    ['region', 'prove_in_region', 'attestations', 'commit_region_attestation', 'regionAttestation', 'regionAttestationSalt', 'get_region_attestation_path',
      (cheat, program) => ({ holderPk: cheat.holderPublicKey, regionLeaf: program.chain.pureCircuits(program.checkAddress('region')).derive_region_leaf(padTo32Bytes('REGION-A')), expiresAt: 18446744073709551615n })]
  ];
  for (const [checkName, circuit, treeName, commitName, bodyKey, saltKey, pathWitness, forge] of FORGERIES) {
    test(`${checkName}: forged evidence plus someone else's path is refused`, async () => {
      const { program, cheat, honestEvidence } = await honestAndCheat();
      const address = program.checkAddress(checkName);
      const honestLeaf = program.chain.pureCircuits(address)[commitName](honestEvidence[checkName][bodyKey], honestEvidence[checkName][saltKey]);
      const lyingDevice = { [pathWitness]: ({ privateState, ledger }) => [privateState, ledger[treeName].findPathForLeaf(honestLeaf)] };
      const forgedState = { ...cheat.privateState, [bodyKey]: forge(cheat, program), [saltKey]: random32Bytes() };
      await refuses(program.chain.callWithWitnesses(address, forgedState, lyingDevice, circuit, cheat.ticket, now(program)), WRONG_LEAF);
      assert.equal(program.chain.publicLedger(address).passes.member(cheat.ticket), false);
    });
  }

  test('region: a region that is not allowed cannot borrow the path of one that is', async () => {
    const { program, cheat } = await honestAndCheat();
    const region = program.checkAddress('region');
    const pure = program.chain.pureCircuits(region);
    const allowedLeaf = pure.derive_region_leaf(padTo32Bytes('REGION-A'));
    // The operator honestly attests the cheat is in REGION-Z (not served).
    const regionAttestation = { holderPk: cheat.holderPublicKey, regionLeaf: pure.derive_region_leaf(padTo32Bytes('REGION-Z')), expiresAt: now(program) + 86400n };
    const regionAttestationSalt = random32Bytes();
    await program.chain.call(region, program.operators.region, 'record_region_attestation', pure.commit_region_attestation(regionAttestation, regionAttestationSalt));
    const lyingDevice = { get_allowed_region_path: ({ privateState, ledger }) => [privateState, ledger.allowedRegions.findPathForLeaf(allowedLeaf)] };
    await refuses(program.chain.callWithWitnesses(region, { ...cheat.privateState, regionAttestation, regionAttestationSalt }, lyingDevice, 'prove_in_region', cheat.ticket, now(program)), WRONG_LEAF);
  });

  test('policy binder: a real binding cannot be used to "prove" a different policy', async () => {
    const program = await freshProgram();
    const { holder } = holderFor(program, 'mei-lin-zhao');
    await givePasses(program, holder, ALL_CHECKS);
    await program.chain.call(program.addresses.ClearanceRegistry, {}, 'grant_clearance', holder.ticket, padTo32Bytes('enhanced'), now(program));
    const binder = program.addresses.PolicyBinder;
    const coverClass = padTo32Bytes('cover-enhanced');
    const realRef = random32Bytes();
    const state = { ...holder.privateState, bindingSalt: random32Bytes() };
    await program.chain.call(binder, state, 'bind_policy', holder.ticket, coverClass, realRef);
    const realBinding = program.chain.pureCircuits(binder).commit_binding({ holderPk: holder.holderPublicKey, walletHash: holder.privateState.walletHash, policyRef: realRef, coverClass }, state.bindingSalt);
    // Claim time: the holder names a policy they were never sold, and their
    // device hands back the path of the real binding.
    const lyingDevice = { get_binding_path: ({ privateState, ledger }) => [privateState, ledger.bindings.findPathForLeaf(realBinding)] };
    await refuses(program.chain.callWithWitnesses(binder, state, lyingDevice, 'prove_binding', coverClass, random32Bytes()), WRONG_LEAF);
    await refuses(program.chain.callWithWitnesses(binder, state, lyingDevice, 'prove_binding', padTo32Bytes('cover-standard'), realRef), WRONG_LEAF);
  });
});

describe('a lying device cannot open someone else\'s ticket', () => {
  test('supplying the victim\'s wallet hash and a made-up salt does not open their ticket', async () => {
    const { program, honest, cheat } = await honestAndCheat();
    const lyingDevice = {
      get_wallet_hash: ({ privateState }) => [privateState, honest.privateState.walletHash],
      get_ticket_salt: ({ privateState }) => [privateState, random32Bytes()]
    };
    await program.chain.call(program.checkAddress('banList'), program.operators.banList, 'record_screening', { walletHash: honest.privateState.walletHash, listVersion: 1n });
    await refuses(program.chain.callWithWitnesses(program.checkAddress('banList'), { ...cheat.privateState, listVersion: 1n }, lyingDevice, 'prove_not_listed', honest.ticket, now(program)), /does not belong to the caller/);
  });
});

describe('the honest path still works', () => {
  test('real evidence, honest device: every check passes', async () => {
    const program = await freshProgram();
    const { holder } = holderFor(program, 'theo-brandt');
    for (const checkName of ALL_CHECKS) {
      await recordAndProveCheck(program, holder, checkName, goodAnswer(program, checkName));
      assert.equal(program.chain.publicLedger(program.checkAddress(checkName)).passes.member(holder.ticket), true, `${checkName} pass for ticket ${bytesToHex(holder.ticket).slice(0, 8)}`);
    }
  });
});
