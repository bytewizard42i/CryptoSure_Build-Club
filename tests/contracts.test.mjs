// ============================================================================
// contracts.test.mjs — the contracts enforce the rules on their own
// ============================================================================
// Every test here talks to the compiled contracts DIRECTLY and skips the
// off-chain protocol and the providers. The question is always the same:
// "if someone bypassed our software and called the contract themselves,
// would the contract still say no?"
//
// These run the real compiled circuits on a local stand-in for a chain
// (protocol/local-chain.mjs). No network and no proofs are involved.
// ============================================================================

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { LocalChain, ContractRejectedError } from '../protocol/local-chain.mjs';
import {
  createHolder, recordAndProveCheck, readClearance, recordCheckEvidence, proveCheck,
  revokeEvidence, revokePass, revokeClearance
} from '../protocol/clearance.mjs';
import { minLevelsVector } from '../protocol/program.mjs';
import { deriveDemoSecretKey, padTo32Bytes, random32Bytes, bytesToHex } from '../protocol/encoding.mjs';
import { ALL_CHECKS, ONE_DAY, SUBJECTS, freshProgram, givePasses, goodAnswer, holderFor } from './helpers.mjs';

const refuses = (promise, messagePattern) => assert.rejects(promise, (error) => error instanceof ContractRejectedError && messagePattern.test(error.message));
const grant = (program, ticket, profile, issuedAt = program.chain.now) =>
  program.chain.call(program.addresses.ClearanceRegistry, {}, 'grant_clearance', ticket, padTo32Bytes(profile), BigInt(issuedAt));
const stranger = { secretKey: deriveDemoSecretKey('a-stranger') };

describe('roles: only the right party can feed or configure a contract', () => {
  test('a stranger cannot record a screening result', async () => {
    const program = await freshProgram();
    await refuses(program.chain.call(program.checkAddress('banList'), stranger, 'record_screening', { walletHash: random32Bytes(), listVersion: 1n }), /not an approved operator/);
  });

  test('the operator of one check is not an operator of another', async () => {
    const program = await freshProgram();
    await refuses(program.chain.call(program.checkAddress('identity'), program.operators.banList, 'issue_credential', random32Bytes()), /not an approved operator/);
  });

  test('a stranger cannot define a profile, plug in a check, or define a cover class', async () => {
    const program = await freshProgram();
    const registry = program.addresses.ClearanceRegistry;
    await refuses(program.chain.call(registry, stranger, 'define_profile', padTo32Bytes('free-pass'), minLevelsVector(program.slots, { banList: 1 }), 1000n), /not an admin/);
    await refuses(program.chain.call(registry, stranger, 'register_check', 0n, LocalChain.contractReference(program.checkAddress('education'))), /not an admin/);
    await refuses(program.chain.call(program.addresses.PolicyBinder, stranger, 'define_cover_class', padTo32Bytes('cover-standard'), padTo32Bytes('basic')), /not an admin/);
  });

  test('a freshly deployed contract already has its admin; there is nothing for a stranger to claim', async () => {
    const program = await freshProgram();
    const fresh = await program.chain.deploy('BanListCheck', program.roleKeyOf(program.admin));
    assert.equal(program.chain.publicLedger(fresh).admins.member(program.roleKeyOf(program.admin)), true);
    await assert.rejects(program.chain.call(fresh, stranger, 'claim_admin'), /no circuit named "claim_admin"/);
    await refuses(program.chain.call(fresh, stranger, 'add_operator', program.roleKeyOf(stranger)), /not an admin/);
  });

  test('an admin can be added and removed, but the last admin cannot be removed', async () => {
    const program = await freshProgram();
    const registry = program.addresses.ClearanceRegistry;
    const second = { secretKey: deriveDemoSecretKey('second-admin') };
    await refuses(program.chain.call(registry, program.admin, 'remove_admin', program.roleKeyOf(program.admin)), /last admin cannot be removed/);
    await program.chain.call(registry, program.admin, 'add_admin', program.roleKeyOf(second));
    await refuses(program.chain.call(registry, program.admin, 'add_admin', program.roleKeyOf(second)), /already an admin/);
    // The new admin removes the old one (for example after a key leak).
    await program.chain.call(registry, second, 'remove_admin', program.roleKeyOf(program.admin));
    await refuses(program.chain.call(registry, program.admin, 'define_profile', padTo32Bytes('x'), minLevelsVector(program.slots, { banList: 1 }), 60n), /not an admin/);
    await refuses(program.chain.call(registry, stranger, 'remove_admin', program.roleKeyOf(second)), /not an admin/);
  });
});

describe('tickets: a pass can only be collected by the person the ticket was made for', () => {
  test('someone else cannot collect a pass on my ticket', async () => {
    const program = await freshProgram();
    const { holder: mine } = holderFor(program, 'bonnie-lachance');
    const { holder: theirs } = holderFor(program, 'theo-brandt');
    // Theo presents Bonnie's ticket with his own private inputs.
    const impostor = { ...theirs, ticket: mine.ticket };
    await refuses(recordAndProveCheck(program, impostor, 'banList', goodAnswer(program, 'banList')), /does not belong to the caller/);
  });
});

describe('each check contract refuses bad evidence', () => {
  test('ban list: a wallet with no screening result gets no pass', async () => {
    const program = await freshProgram();
    const { holder } = holderFor(program, 'bonnie-lachance');
    await refuses(program.chain.call(program.checkAddress('banList'), { ...holder.privateState, listVersion: 1n }, 'prove_not_listed', holder.ticket, BigInt(program.chain.now)), /not been cleared by screening/);
  });

  test('ban list: a result from an outdated list is refused once the floor is raised', async () => {
    const program = await freshProgram();
    const { holder } = holderFor(program, 'bonnie-lachance');
    await program.chain.call(program.checkAddress('banList'), program.admin, 'set_min_list_version', 2n);
    await refuses(recordAndProveCheck(program, holder, 'banList', { listVersion: 1 }), /stale/);
    await recordAndProveCheck(program, holder, 'banList', { listVersion: 2 });
  });

  test('ban list: the list version floor cannot be lowered', async () => {
    const program = await freshProgram();
    const banList = program.checkAddress('banList');
    await program.chain.call(banList, program.admin, 'set_min_list_version', 5n);
    await refuses(program.chain.call(banList, program.admin, 'set_min_list_version', 4n), /cannot go backwards/);
  });

  test('region: a region the program does not serve is refused', async () => {
    const program = await freshProgram();
    const { holder } = holderFor(program, 'bonnie-lachance');
    await refuses(recordAndProveCheck(program, holder, 'region', goodAnswer(program, 'region', { regionCode: 'REGION-Z' })), /not one this program serves/);
  });

  test('identity: a credential whose leaf has been blanked can no longer be proven', async () => {
    const program = await freshProgram();
    const { holder } = holderFor(program, 'bonnie-lachance');
    const answer = goodAnswer(program, 'identity');
    // The issuer records the credential, then revokes it before the holder
    // ever proves it. The index is what the issuer kept; nothing about the
    // credential itself is named.
    const evidence = await recordCheckEvidence(program, holder, 'identity', answer);
    await revokeEvidence(program, 'identity', evidence.leafIndex);
    await refuses(proveCheck(program, holder, 'identity', evidence), /No such identity credential/);
  });

  test('identity, education, region, wallet control: evidence issued to someone else is refused', async () => {
    const program = await freshProgram();
    const { holder: bonnie } = holderFor(program, 'bonnie-lachance');
    const { holder: theo } = holderFor(program, 'theo-brandt');
    for (const checkName of ['identity', 'education', 'region', 'walletControl']) {
      // The operator seals evidence for Theo; Bonnie tries to use it.
      const evidence = await recordAndProveCheck(program, theo, checkName, goodAnswer(program, checkName));
      const circuit = { identity: 'prove_identity', education: 'prove_education', region: 'prove_in_region', walletControl: 'prove_wallet_control' }[checkName];
      await refuses(program.chain.call(program.checkAddress(checkName), { ...bonnie.privateState, ...evidence }, circuit, bonnie.ticket, BigInt(program.chain.now)), /someone else|different holder/);
    }
  });

  test('wallet control: an attestation for a different wallet is refused', async () => {
    const program = await freshProgram();
    const { holder } = holderFor(program, 'bonnie-lachance');
    // Same person, but a ticket for another wallet.
    const otherWallet = createHolder(program, { subjectId: 'bonnie-lachance', wallet: SUBJECTS['theo-brandt'].wallet });
    const evidence = await recordAndProveCheck(program, holder, 'walletControl', goodAnswer(program, 'walletControl'));
    await refuses(program.chain.call(program.checkAddress('walletControl'), { ...otherWallet.privateState, ...evidence }, 'prove_wallet_control', otherWallet.ticket, BigInt(program.chain.now)), /different wallet/);
  });

  test('any check: evidence that has already expired gives no pass', async () => {
    const program = await freshProgram();
    const { holder } = holderFor(program, 'bonnie-lachance');
    await refuses(recordAndProveCheck(program, holder, 'identity', goodAnswer(program, 'identity', { expiresAt: program.chain.now - 1 })), /already expired/);
  });

  test('any check: a holder cannot date a pass in the future to stretch it', async () => {
    const program = await freshProgram();
    const { holder } = holderFor(program, 'bonnie-lachance');
    await program.chain.call(program.checkAddress('banList'), program.operators.banList, 'record_screening', { walletHash: holder.privateState.walletHash, listVersion: 1n });
    await refuses(program.chain.call(program.checkAddress('banList'), { ...holder.privateState, listVersion: 1n }, 'prove_not_listed', holder.ticket, BigInt(program.chain.now + 3600)), /in the future/);
  });
});

describe('ClearanceRegistry: a clearance needs every pass the profile asks for', () => {
  test('all five passes give an enhanced clearance; the registry consults all five contracts in one call', async () => {
    const program = await freshProgram();
    const { holder } = holderFor(program, 'mei-lin-zhao');
    await givePasses(program, holder, ALL_CHECKS);
    const granted = await grant(program, holder.ticket, 'enhanced');
    assert.equal(granted.callTrace.filter((step) => step.endsWith('.require_pass')).length, 5);
    assert.equal(granted.callTrace.at(-1), 'ClearanceRegistry.grant_clearance');
    assert.equal(readClearance(program, holder.ticket, 'enhanced').clear, true);
  });

  test('a profile only consults the checks it requires', async () => {
    const program = await freshProgram();
    const { holder } = holderFor(program, 'mei-lin-zhao');
    await givePasses(program, holder, ['banList', 'walletControl']);
    const granted = await grant(program, holder.ticket, 'basic');
    assert.deepEqual(granted.callTrace, ['BanListCheck.require_pass', 'WalletControlCheck.require_pass', 'ClearanceRegistry.grant_clearance']);
  });

  for (const missing of ALL_CHECKS) {
    test(`missing the ${missing} pass: refused`, async () => {
      const program = await freshProgram();
      const { holder } = holderFor(program, 'mei-lin-zhao');
      await givePasses(program, holder, ALL_CHECKS.filter((checkName) => checkName !== missing));
      await refuses(grant(program, holder.ticket, 'enhanced'), /no pass from this check/);
    });
  }

  test('a pass at too low a level is refused, and the level comes from the ledger, not the caller', async () => {
    const program = await freshProgram();
    const { holder } = holderFor(program, 'bonnie-lachance');
    await givePasses(program, holder, ALL_CHECKS, { identity: { level: 1 } });
    await grant(program, holder.ticket, 'standard');
    await refuses(grant(program, holder.ticket, 'enhanced'), /below what is required/);
  });

  test('an unknown profile is refused', async () => {
    const program = await freshProgram();
    const { holder } = holderFor(program, 'mei-lin-zhao');
    await refuses(grant(program, holder.ticket, 'no-such-profile'), /no such profile/);
  });

  test('a stranger cannot shorten or kill someone else\'s clearance by re-granting it with an old date', async () => {
    const program = await freshProgram();
    const { holder } = holderFor(program, 'mei-lin-zhao');
    await givePasses(program, holder, ['banList', 'walletControl']);
    await grant(program, holder.ticket, 'basic');
    const before = readClearance(program, holder.ticket, 'basic').validUntil;
    // grant_clearance is open to anyone, so these are the attacks to refuse.
    await refuses(grant(program, holder.ticket, 'basic', 1), /already be expired/);
    await refuses(grant(program, holder.ticket, 'basic', program.chain.now - 3600), /at least this long is already recorded/);
    await refuses(grant(program, holder.ticket, 'basic'), /at least this long is already recorded/);
    assert.equal(readClearance(program, holder.ticket, 'basic').validUntil, before);
  });

  test('a profile that requires nothing cannot be defined', async () => {
    const program = await freshProgram();
    await refuses(program.chain.call(program.addresses.ClearanceRegistry, program.admin, 'define_profile', padTo32Bytes('free-pass'), minLevelsVector(program.slots, {}), 1000n), /at least one check/);
  });

  test('shelf lives are bounded, so a typo cannot break later arithmetic', async () => {
    const program = await freshProgram();
    const tooLong = 315360001n;
    await refuses(program.chain.call(program.addresses.ClearanceRegistry, program.admin, 'define_profile', padTo32Bytes('forever'), minLevelsVector(program.slots, { banList: 1 }), tooLong), /between one second and ten years/);
    await refuses(program.chain.call(program.checkAddress('identity'), program.admin, 'set_shelf_life', tooLong), /between one second and ten years/);
    await refuses(program.chain.call(program.checkAddress('identity'), program.admin, 'set_shelf_life', 0n), /between one second and ten years/);
    await refuses(program.chain.call(program.addresses.PairReceipt, program.admin, 'set_receipt_life', 86401n), /between one second and one day/);
  });

  test('a clearance cannot be dated in the future', async () => {
    const program = await freshProgram();
    const { holder } = holderFor(program, 'mei-lin-zhao');
    await givePasses(program, holder, ['banList', 'walletControl']);
    await refuses(grant(program, holder.ticket, 'basic', program.chain.now + 60), /in the future/);
  });

  test('a clearance ends with its weakest evidence', async () => {
    const program = await freshProgram();
    const { holder } = holderFor(program, 'mei-lin-zhao');
    // Wallet-control evidence that runs out in one hour.
    await givePasses(program, holder, ['banList', 'walletControl'], { walletControl: { expiresAt: program.chain.now + 3600 } });
    const granted = await grant(program, holder.ticket, 'basic');
    assert.equal(Number(granted.result), program.chain.now + 3600);
  });

  test('an expired clearance stops counting, and cannot be renewed on stale passes', async () => {
    const program = await freshProgram();
    const { holder } = holderFor(program, 'mei-lin-zhao');
    await givePasses(program, holder, ['banList', 'walletControl']);
    await grant(program, holder.ticket, 'basic');
    program.chain.advanceTime(ONE_DAY + 1);   // the ban-list pass lasts one day
    assert.equal(readClearance(program, holder.ticket, 'basic').clear, false);
    await refuses(program.chain.call(program.addresses.ClearanceRegistry, {}, 'require_clearance', holder.ticket, padTo32Bytes('basic')), /expired/);
    await refuses(grant(program, holder.ticket, 'basic'), /has expired/);
    // A fresh ban-list pass is enough to renew: the wallet-control pass is still good.
    await givePasses(program, holder, ['banList']);
    await grant(program, holder.ticket, 'basic');
  });
});

// ============================================================================
// Revocation, added after the Nov 25 2026 review found that nothing could be
// withdrawn before it expired.
// ============================================================================
describe('revocation: a pass, a piece of evidence, a region and a clearance can all be withdrawn', () => {
  test('a revoked pass stops a clearance being granted, and only the operator or admin can revoke it', async () => {
    const program = await freshProgram();
    const { holder } = holderFor(program, 'mei-lin-zhao');
    await givePasses(program, holder, ['banList', 'walletControl']);

    await refuses(revokePass(program, 'banList', holder.ticket, stranger), /neither an admin nor an approved operator/);
    // The operator of a DIFFERENT check is just as much a stranger here.
    await refuses(revokePass(program, 'banList', holder.ticket, program.operators.education), /neither an admin nor an approved operator/);

    await revokePass(program, 'banList', holder.ticket);
    assert.equal(program.chain.publicLedger(program.checkAddress('banList')).passes.member(holder.ticket), false);
    await refuses(grant(program, holder.ticket, 'basic'), /no pass from this check/);
    // Revoking twice is refused rather than silently doing nothing.
    await refuses(revokePass(program, 'banList', holder.ticket), /no pass from this check/);
    // The admin may also revoke (the operator may have gone silent).
    await revokePass(program, 'walletControl', holder.ticket, program.admin);
  });

  test('revoking the pass alone is not enough: the holder re-proves unless the evidence goes too', async () => {
    const program = await freshProgram();
    const { holder } = holderFor(program, 'mei-lin-zhao');
    const evidence = await recordCheckEvidence(program, holder, 'banList', goodAnswer(program, 'banList'));
    await proveCheck(program, holder, 'banList', evidence);

    // Half the job: the pass is gone, but the screening leaf is still there.
    await revokePass(program, 'banList', holder.ticket);
    await proveCheck(program, holder, 'banList', evidence);
    assert.equal(program.chain.publicLedger(program.checkAddress('banList')).passes.member(holder.ticket), true);

    // The whole job. This is the order the contracts' comments prescribe.
    await revokePass(program, 'banList', holder.ticket);
    await revokeEvidence(program, 'banList', evidence.leafIndex);
    await refuses(proveCheck(program, holder, 'banList', evidence), /not been cleared by screening/);
  });

  test('revoking evidence names only an index, and an index nothing was recorded at is refused', async () => {
    const program = await freshProgram();
    const { holder } = holderFor(program, 'mei-lin-zhao');
    const evidence = await recordCheckEvidence(program, holder, 'identity', goodAnswer(program, 'identity'));
    assert.equal(evidence.leafIndex, 0);
    // A counter that only ever goes up is what makes an index safe to use:
    // blanking a leaf must not free its index for the next insert.
    await revokeEvidence(program, 'identity', 0);
    const second = await recordCheckEvidence(program, holder, 'identity', goodAnswer(program, 'identity'));
    assert.equal(second.leafIndex, 1, 'a blanked index must not be handed out again');
    await refuses(revokeEvidence(program, 'identity', 2), /No credential has been issued at that index/);
    // The second credential is untouched by the first one's revocation.
    await proveCheck(program, holder, 'identity', second);
  });

  test('every check can revoke its own evidence, and the other checks are unaffected', async () => {
    const program = await freshProgram();
    const { holder } = holderFor(program, 'mei-lin-zhao');
    const evidence = await givePasses(program, holder, ALL_CHECKS);
    await grant(program, holder.ticket, 'enhanced');

    for (const checkName of ALL_CHECKS) {
      await revokePass(program, checkName, holder.ticket);
      await revokeEvidence(program, checkName, evidence[checkName].leafIndex);
      await refuses(proveCheck(program, holder, checkName, evidence[checkName]), /No such|not been cleared|not one this program serves/);
    }
    await refuses(grant(program, holder.ticket, 'enhanced'), /no pass from this check/);
  });

  test('only the admin can withdraw a region, and an index nothing was allowed at is refused', async () => {
    const program = await freshProgram();
    const region = program.checkAddress('region');
    await refuses(program.chain.call(region, stranger, 'remove_allowed_region', 0n), /not an admin/);
    await refuses(program.chain.call(region, program.operators.region, 'remove_allowed_region', 0n), /not an admin/);
    // config/program.json allows two regions, so indexes 0 and 1 exist.
    await refuses(program.chain.call(region, program.admin, 'remove_allowed_region', 2n), /No region has been allowed at that index/);
    await program.chain.call(region, program.admin, 'remove_allowed_region', 1n);
  });

  test('a revoked clearance stops everything that relies on it, and only the admin can revoke it', async () => {
    const program = await freshProgram();
    const { holder } = holderFor(program, 'mei-lin-zhao');
    await givePasses(program, holder, ALL_CHECKS);
    await grant(program, holder.ticket, 'standard');
    assert.equal(readClearance(program, holder.ticket, 'standard').clear, true);

    await refuses(revokeClearance(program, holder.ticket, 'standard', stranger), /not an admin/);
    await refuses(revokeClearance(program, holder.ticket, 'enhanced'), /not cleared for this profile/);

    await revokeClearance(program, holder.ticket, 'standard');
    assert.equal(readClearance(program, holder.ticket, 'standard').clear, false);
    await refuses(program.chain.call(program.addresses.ClearanceRegistry, {}, 'require_clearance', holder.ticket, padTo32Bytes('standard')), /not cleared for this profile/);
    // A policy cannot be bound on a clearance that has been withdrawn.
    await refuses(
      program.chain.call(program.addresses.PolicyBinder, { ...holder.privateState, bindingSalt: random32Bytes() }, 'bind_policy', holder.ticket, padTo32Bytes('cover-standard'), random32Bytes()),
      /not cleared for this profile/
    );
  });

  test('a withdrawn clearance can be earned again while its passes are good — and cannot once they are revoked', async () => {
    // This is the documented behaviour, not an accident: the registry must
    // not be able to brick a ticket permanently. See revoke_clearance in
    // contracts/ClearanceRegistry.compact.
    const program = await freshProgram();
    const { holder } = holderFor(program, 'mei-lin-zhao');
    const evidence = await givePasses(program, holder, ['banList', 'walletControl']);
    await grant(program, holder.ticket, 'basic');

    await revokeClearance(program, holder.ticket, 'basic');
    await grant(program, holder.ticket, 'basic');
    assert.equal(readClearance(program, holder.ticket, 'basic').clear, true);

    // Now do it properly: take the pass and the evidence away as well.
    await revokeClearance(program, holder.ticket, 'basic');
    await revokePass(program, 'banList', holder.ticket);
    await revokeEvidence(program, 'banList', evidence.banList.leafIndex);
    await refuses(grant(program, holder.ticket, 'basic'), /no pass from this check/);
    await refuses(proveCheck(program, holder, 'banList', evidence.banList), /not been cleared by screening/);
  });
});

describe('a holder cannot weaken their own pass', () => {
  test('re-proving at a lower level, or with evidence that ends sooner, is refused', async () => {
    const program = await freshProgram();
    const { holder } = holderFor(program, 'mei-lin-zhao');
    await recordAndProveCheck(program, holder, 'identity', goodAnswer(program, 'identity', { level: 2 }));
    const strong = program.chain.publicLedger(program.checkAddress('identity')).passes.lookup(holder.ticket);

    await refuses(recordAndProveCheck(program, holder, 'identity', goodAnswer(program, 'identity', { level: 1 })), /already holds a stronger or longer pass/);
    await refuses(
      recordAndProveCheck(program, holder, 'identity', goodAnswer(program, 'identity', { level: 2, expiresAt: program.chain.now + 60 })),
      /already holds a stronger or longer pass/
    );
    const after = program.chain.publicLedger(program.checkAddress('identity')).passes.lookup(holder.ticket);
    assert.equal(after.level, strong.level);
    assert.equal(after.validUntil, strong.validUntil);
  });

  test('re-proving at a HIGHER level, or later so the pass lasts longer, still works', async () => {
    const program = await freshProgram();
    const { holder } = holderFor(program, 'mei-lin-zhao');
    await recordAndProveCheck(program, holder, 'identity', goodAnswer(program, 'identity', { level: 1 }));
    // An upgrade from basic to enhanced identity must not be blocked.
    await recordAndProveCheck(program, holder, 'identity', goodAnswer(program, 'identity', { level: 2 }));
    assert.equal(program.chain.publicLedger(program.checkAddress('identity')).passes.lookup(holder.ticket).level, 2n);

    // A ban-list pass is capped by its one-day shelf life, so renewing it a
    // day later is strictly longer and must be allowed.
    await recordAndProveCheck(program, holder, 'banList', goodAnswer(program, 'banList'));
    const before = program.chain.publicLedger(program.checkAddress('banList')).passes.lookup(holder.ticket).validUntil;
    program.chain.advanceTime(ONE_DAY);
    await recordAndProveCheck(program, holder, 'banList', goodAnswer(program, 'banList'));
    assert.ok(program.chain.publicLedger(program.checkAddress('banList')).passes.lookup(holder.ticket).validUntil > before);
  });
});

describe('sealed evidence of different kinds cannot be confused', () => {
  test('structs of the same shape seal to different bytes, because each kind has its own type tag', async () => {
    const program = await freshProgram();
    const { holder } = holderFor(program, 'mei-lin-zhao');
    const salt = random32Bytes();
    const identity = program.chain.pureCircuits(program.checkAddress('identity'));
    const education = program.chain.pureCircuits(program.checkAddress('education'));
    const region = program.chain.pureCircuits(program.checkAddress('region'));
    const control = program.chain.pureCircuits(program.checkAddress('walletControl'));

    // An identity credential and an education certificate have the same
    // shape: {Bytes<32>, Uint<8>, Bytes<32>, Uint<64>}. Same field values,
    // same salt, so without a type tag they would seal to the SAME 32 bytes.
    const sharedId = random32Bytes();
    const graded = { holderPk: holder.holderPublicKey, level: 2n, expiresAt: 1_900_000_000n };
    assert.notDeepEqual(
      identity.commit_identity_credential({ ...graded, credentialId: sharedId }, salt),
      education.commit_education_certificate({ ...graded, certificateId: sharedId }, salt)
    );

    // A region attestation and a wallet-control attestation are the other
    // same-shaped pair: {Bytes<32>, Bytes<32>, Uint<64>}.
    const second = random32Bytes();
    const dated = { holderPk: holder.holderPublicKey, expiresAt: 1_900_000_000n };
    assert.notDeepEqual(
      region.commit_region_attestation({ ...dated, regionLeaf: second }, salt),
      control.commit_control_attestation({ ...dated, walletHash: second }, salt)
    );
  });

  test('a ticket is not confusable with any other sealed value', async () => {
    const program = await freshProgram();
    const pure = program.chain.pureCircuits(program.addresses.PolicyBinder);
    const a = random32Bytes();
    const b = random32Bytes();
    const salt = random32Bytes();
    // The ticket's own tag means its 32 bytes cannot coincide with a plain
    // commitment to the same two values.
    assert.notDeepEqual(pure.derive_ticket(a, b, salt), pure.derive_holder_key(a));
    assert.notDeepEqual(pure.derive_ticket(a, b, salt), pure.derive_ticket(b, a, salt));
  });
});

describe('PolicyBinder: knowing a wallet does not tell you whether it is insured', () => {
  test('the binding nullifier cannot be computed without the holder\'s secret', async () => {
    const program = await freshProgram();
    const { holder } = holderFor(program, 'mei-lin-zhao');
    await givePasses(program, holder, ALL_CHECKS);
    await grant(program, holder.ticket, 'standard');
    const binder = program.addresses.PolicyBinder;
    const pure = program.chain.pureCircuits(binder);
    await program.chain.call(binder, { ...holder.privateState, bindingSalt: random32Bytes() }, 'bind_policy', holder.ticket, padTo32Bytes('cover-standard'), random32Bytes());

    const nullifiers = program.chain.publicLedger(binder).bindingNullifiers;
    const walletHash = holder.privateState.walletHash;

    // The holder, who has the secret, finds their own nullifier.
    const real = pure.derive_binding_nullifier(walletHash, pure.derive_binding_key(holder.privateState.secretKey));
    assert.equal(nullifiers.member(real), true);

    // An operator knows the wallet hash (it holds the key the hash is made
    // with) but not the holder's secret. Nothing it can derive from the
    // wallet hash alone is in the set. These are the values the OLD design
    // put on the ledger, and the ones an operator would try first.
    for (const guessedKey of [walletHash, pure.derive_binding_key(walletHash), pure.derive_holder_key(walletHash), new Uint8Array(32)]) {
      assert.equal(nullifiers.member(pure.derive_binding_nullifier(walletHash, guessedKey)), false);
    }
    // Nor does guessing another person's secret help.
    assert.equal(nullifiers.member(pure.derive_binding_nullifier(walletHash, pure.derive_binding_key(deriveDemoSecretKey('holder:theo-brandt')))), false);
  });

  test('the price of that: one wallet shared by two holder keys can hold two bindings', async () => {
    // The documented trade-off. "One wallet, one binding" became "one wallet,
    // one binding per holder key" when the nullifier stopped being
    // computable from the wallet alone. See the header of
    // contracts/PolicyBinder.compact.
    const program = await freshProgram();
    const wallet = SUBJECTS['mei-lin-zhao'].wallet;
    const first = createHolder(program, { subjectId: 'mei-lin-zhao', wallet });
    const second = createHolder(program, { subjectId: 'theo-brandt', wallet });
    assert.deepEqual(first.privateState.walletHash, second.privateState.walletHash);

    for (const holder of [first, second]) {
      await givePasses(program, holder, ALL_CHECKS);
      await grant(program, holder.ticket, 'standard');
      await program.chain.call(program.addresses.PolicyBinder, { ...holder.privateState, bindingSalt: random32Bytes() }, 'bind_policy', holder.ticket, padTo32Bytes('cover-standard'), random32Bytes());
    }
    assert.equal(Number(program.chain.publicLedger(program.addresses.PolicyBinder).bindingCount), 2);

    // The same PERSON still cannot bind the same wallet twice, however many
    // fresh tickets they make. That is the part that mattered.
    const freshTicket = createHolder(program, { subjectId: 'mei-lin-zhao', wallet });
    await givePasses(program, freshTicket, ALL_CHECKS);
    await grant(program, freshTicket.ticket, 'standard');
    await refuses(
      program.chain.call(program.addresses.PolicyBinder, { ...freshTicket.privateState, bindingSalt: random32Bytes() }, 'bind_policy', freshTicket.ticket, padTo32Bytes('cover-standard'), random32Bytes()),
      /already bound/
    );
  });
});

describe('modularity: checks can be swapped and added without touching other contracts', () => {
  test('replacing the contract in a slot makes passes from the old one worthless', async () => {
    const program = await freshProgram();
    const { holder } = holderFor(program, 'mei-lin-zhao');
    await givePasses(program, holder, ['banList', 'walletControl']);
    await grant(program, holder.ticket, 'basic');

    const replacement = await program.chain.deploy('BanListCheck', program.roleKeyOf(program.admin));
    await program.chain.call(program.addresses.ClearanceRegistry, program.admin, 'register_check', BigInt(program.slots.banList), LocalChain.contractReference(replacement));
    await refuses(grant(program, holder.ticket, 'basic'), /no pass from this check/);
  });

  test('a sixth check can be plugged into a free slot and required by a new profile', async () => {
    const program = await freshProgram();
    const registry = program.addresses.ClearanceRegistry;
    // Any contract that answers require_pass will do. Here: a second
    // EducationCheck standing in for "a check nobody has invented yet".
    const sixthCheck = await program.chain.deploy('EducationCheck', program.roleKeyOf(program.admin));
    await program.chain.call(registry, program.admin, 'register_check', 5n, LocalChain.contractReference(sixthCheck));
    const levels = minLevelsVector(program.slots, { banList: 1 });
    levels[5] = 1n;
    await program.chain.call(registry, program.admin, 'define_profile', padTo32Bytes('with-sixth'), levels, 3600n);

    const { holder } = holderFor(program, 'mei-lin-zhao');
    await givePasses(program, holder, ['banList']);
    await refuses(grant(program, holder.ticket, 'with-sixth'), /no pass from this check/);
    // Profiles that do not mention slot 5 are unaffected.
    await givePasses(program, holder, ['walletControl']);
    await grant(program, holder.ticket, 'basic');
  });

  test('a profile that needs an empty slot is refused, not silently passed', async () => {
    const program = await freshProgram();
    const levels = minLevelsVector(program.slots, {});
    levels[7] = 1n;
    await program.chain.call(program.addresses.ClearanceRegistry, program.admin, 'define_profile', padTo32Bytes('needs-slot-7'), levels, 3600n);
    const { holder } = holderFor(program, 'mei-lin-zhao');
    await refuses(grant(program, holder.ticket, 'needs-slot-7'), /not plugged in/);
  });
});

describe('PolicyBinder: a policy binds only to a wallet cleared for what that policy demands', () => {
  const bind = (program, holder, coverClass, policyRef = random32Bytes(), bindingSalt = random32Bytes()) =>
    program.chain.call(program.addresses.PolicyBinder, { ...holder.privateState, bindingSalt }, 'bind_policy', holder.ticket, padTo32Bytes(coverClass), policyRef);

  async function clearedHolder(profile, subjectId = 'mei-lin-zhao') {
    const program = await freshProgram();
    const { holder } = holderFor(program, subjectId);
    await givePasses(program, holder, ALL_CHECKS);
    await grant(program, holder.ticket, profile);
    return { program, holder };
  }

  test('binds, and the binding can be proven later with the right policy only', async () => {
    const { program, holder } = await clearedHolder('enhanced');
    const policyRef = random32Bytes();
    const bindingSalt = random32Bytes();
    await bind(program, holder, 'cover-enhanced', policyRef, bindingSalt);
    const binder = program.addresses.PolicyBinder;
    const state = { ...holder.privateState, bindingSalt };
    assert.equal((await program.chain.call(binder, state, 'prove_binding', padTo32Bytes('cover-enhanced'), policyRef)).result, true);
    await refuses(program.chain.call(binder, state, 'prove_binding', padTo32Bytes('cover-enhanced'), random32Bytes()), /no such binding/);
    await refuses(program.chain.call(binder, state, 'prove_binding', padTo32Bytes('cover-standard'), policyRef), /no such binding/);
  });

  test('a standard clearance cannot bind an enhanced policy', async () => {
    const { program, holder } = await clearedHolder('standard');
    await refuses(bind(program, holder, 'cover-enhanced'), /not cleared for this profile/);
    await bind(program, holder, 'cover-standard');
  });

  test('an unknown cover class is refused', async () => {
    const { program, holder } = await clearedHolder('enhanced');
    await refuses(bind(program, holder, 'cover-imaginary'), /no such cover class/);
  });

  test('one wallet, one binding: a second binding is refused even on a new ticket', async () => {
    const { program, holder } = await clearedHolder('standard');
    await bind(program, holder, 'cover-standard');
    await refuses(bind(program, holder, 'cover-standard'), /already bound/);
    // Same person and wallet, brand new ticket, fully cleared again.
    const secondTicket = createHolder(program, { subjectId: holder.subjectId, wallet: holder.wallet });
    await givePasses(program, secondTicket, ALL_CHECKS);
    await grant(program, secondTicket.ticket, 'standard');
    await refuses(bind(program, secondTicket, 'cover-standard'), /already bound/);
  });

  test('someone else cannot bind using my cleared ticket', async () => {
    const { program, holder } = await clearedHolder('standard');
    const { holder: theo } = holderFor(program, 'theo-brandt');
    await refuses(bind(program, { ...theo, ticket: holder.ticket }, 'cover-standard'), /does not belong to the caller/);
  });

  test('an expired clearance cannot bind', async () => {
    const { program, holder } = await clearedHolder('standard');
    program.chain.advanceTime(ONE_DAY + 1);
    await refuses(bind(program, holder, 'cover-standard'), /expired/);
  });

  test('the admin can release a wallet; the old binding stops proving and the wallet can be bound again', async () => {
    const { program, holder } = await clearedHolder('standard');
    const binder = program.addresses.PolicyBinder;
    const coverClass = padTo32Bytes('cover-standard');
    const oldRef = random32Bytes();
    const oldSalt = random32Bytes();
    await bind(program, holder, 'cover-standard', oldRef, oldSalt);
    const oldBinding = program.chain.pureCircuits(binder).commit_binding({ holderPk: holder.holderPublicKey, walletHash: holder.privateState.walletHash, policyRef: oldRef, coverClass }, oldSalt);
    const oldState = { ...holder.privateState, bindingSalt: oldSalt };
    assert.equal((await program.chain.call(binder, oldState, 'prove_binding', coverClass, oldRef)).result, true);

    // The admin no longer derives the nullifier from the wallet hash (it
    // cannot: it depends on the holder's secret). It is told the nullifier,
    // from the insurer's own record of the bind_policy transaction.
    const pure = program.chain.pureCircuits(binder);
    const nullifier = pure.derive_binding_nullifier(holder.privateState.walletHash, pure.derive_binding_key(holder.privateState.secretKey));
    await refuses(program.chain.call(binder, stranger, 'release_binding', nullifier, oldBinding), /not an admin/);
    await program.chain.call(binder, program.admin, 'release_binding', nullifier, oldBinding);

    // A cancelled policy must not look like a live one at claim time.
    await refuses(program.chain.call(binder, oldState, 'prove_binding', coverClass, oldRef), /has been released/);
    // The wallet is free to be bound again, and the new binding proves.
    const newRef = random32Bytes();
    const newSalt = random32Bytes();
    await bind(program, holder, 'cover-standard', newRef, newSalt);
    assert.equal((await program.chain.call(binder, { ...holder.privateState, bindingSalt: newSalt }, 'prove_binding', coverClass, newRef)).result, true);
  });

  test('binding hands nothing back: the commitment is not returned by the contract', async () => {
    const { program, holder } = await clearedHolder('standard');
    const bound = await bind(program, holder, 'cover-standard');
    assert.deepEqual(bound.result, []);
  });
});

describe('PairReceipt: a receipt needs two different tickets, both clear right now', () => {
  const issue = (program, senderTicket, receiverTicket) =>
    program.chain.call(program.addresses.PairReceipt, {}, 'issue_receipt', senderTicket, receiverTicket, padTo32Bytes('basic'), BigInt(program.chain.now));

  async function twoClearedHolders() {
    const program = await freshProgram();
    const holders = [];
    for (const subjectId of ['mei-lin-zhao', 'theo-brandt']) {
      const { holder } = holderFor(program, subjectId);
      await givePasses(program, holder, ['banList', 'walletControl']);
      await grant(program, holder.ticket, 'basic');
      holders.push(holder);
    }
    return { program, sender: holders[0], receiver: holders[1] };
  }

  test('issues a receipt, which the contract confirms until it goes stale', async () => {
    const { program, sender, receiver } = await twoClearedHolders();
    const issued = await issue(program, sender.ticket, receiver.ticket);
    assert.deepEqual(issued.callTrace, ['ClearanceRegistry.require_clearance', 'ClearanceRegistry.require_clearance', 'PairReceipt.issue_receipt']);
    const receipts = program.addresses.PairReceipt;
    await program.chain.call(receipts, {}, 'require_receipt', issued.result);
    program.chain.advanceTime(901);   // receipts last fifteen minutes
    await refuses(program.chain.call(receipts, {}, 'require_receipt', issued.result), /gone stale/);
  });

  test('refused if either side is not clear', async () => {
    const { program, sender } = await twoClearedHolders();
    const { holder: uncleared } = holderFor(program, 'anya-petrova');
    await refuses(issue(program, sender.ticket, uncleared.ticket), /not cleared/);
    await refuses(issue(program, uncleared.ticket, sender.ticket), /not cleared/);
  });

  test('a receipt cannot be back-dated beyond its own lifetime, or issued twice', async () => {
    const { program, sender, receiver } = await twoClearedHolders();
    const receipts = program.addresses.PairReceipt;
    const at = (when) => program.chain.call(receipts, {}, 'issue_receipt', sender.ticket, receiver.ticket, padTo32Bytes('basic'), BigInt(when));
    await refuses(at(program.chain.now - 901), /too far in the past/);
    await at(program.chain.now);
    await refuses(at(program.chain.now), /already been issued/);
  });

  test('refused if sender and receiver are the same ticket', async () => {
    const { program, sender } = await twoClearedHolders();
    await refuses(issue(program, sender.ticket, sender.ticket), /must be different/);
  });
});

describe('privacy: what is NOT on the ledger', () => {
  test('after a full clearance and binding, no contract stores the address or the wallet hash', async () => {
    const program = await freshProgram();
    const { holder } = holderFor(program, 'mei-lin-zhao');
    const evidence = await givePasses(program, holder, ALL_CHECKS);
    await grant(program, holder.ticket, 'enhanced');
    await program.chain.call(program.addresses.PolicyBinder, { ...holder.privateState, bindingSalt: random32Bytes() }, 'bind_policy', holder.ticket, padTo32Bytes('cover-enhanced'), random32Bytes());

    const secrets = {
      'the wallet address': Buffer.from(holder.wallet.address, 'utf8'),
      'the wallet hash': Buffer.from(holder.privateState.walletHash),
      'the holder secret key': Buffer.from(holder.privateState.secretKey),
      'the holder public key': Buffer.from(holder.holderPublicKey),
      'the ticket salt': Buffer.from(holder.privateState.ticketSalt),
      // The identity credential id is the value the OLD revocation design
      // hashed and published on every use, which let the issuer recognise
      // which anonymous tickets it had verified. Nothing derived from it
      // reaches the chain any more, so neither does it.
      'the identity credential id': Buffer.from(evidence.identity.identityCredential.credentialId),
      'the identity credential salt': Buffer.from(evidence.identity.identityCredentialSalt),
      'the education certificate id': Buffer.from(evidence.education.educationCertificate.certificateId),
      'the binding key': Buffer.from(program.chain.pureCircuits(program.addresses.PolicyBinder).derive_binding_key(holder.privateState.secretKey))
    };
    for (const [contractName, address] of Object.entries(program.addresses)) {
      const state = program.chain.serializedPublicState(address);
      for (const [what, bytes] of Object.entries(secrets)) {
        assert.equal(state.includes(bytes), false, `${contractName} stores ${what}`);
      }
    }
    // Sanity check on the method itself: things that ARE public must be found
    // by the same search. (The stored form drops trailing zero bytes, so the
    // profile name is searched for as text, without its padding.)
    assert.equal(program.chain.serializedPublicState(program.addresses.ClearanceRegistry).includes(Buffer.from('enhanced', 'utf8')), true);
    assert.equal(program.chain.serializedPublicState(program.checkAddress('banList')).includes(Buffer.from(holder.ticket)), true, `ticket ${bytesToHex(holder.ticket)} should be public`);
  });
});
