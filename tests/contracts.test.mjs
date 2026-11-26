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
import { createHolder, recordAndProveCheck, readClearance } from '../protocol/clearance.mjs';
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
    await refuses(program.chain.call(registry, stranger, 'define_profile', padTo32Bytes('free-pass'), minLevelsVector(program.slots, {}), 1000n), /not an admin/);
    await refuses(program.chain.call(registry, stranger, 'register_check', 0n, LocalChain.contractReference(program.checkAddress('education'))), /not an admin/);
    await refuses(program.chain.call(program.addresses.PolicyBinder, stranger, 'define_cover_class', padTo32Bytes('cover-standard'), padTo32Bytes('basic')), /not an admin/);
  });

  test('the admin role can only be claimed once', async () => {
    const program = await freshProgram();
    await refuses(program.chain.call(program.addresses.ClearanceRegistry, stranger, 'claim_admin'), /already claimed/);
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

  test('identity: a revoked credential is refused', async () => {
    const program = await freshProgram();
    const { holder } = holderFor(program, 'bonnie-lachance');
    const answer = goodAnswer(program, 'identity');
    await program.chain.call(program.checkAddress('identity'), program.operators.identity, 'revoke_credential', Uint8Array.from(Buffer.from(answer.credentialId, 'hex')));
    await refuses(recordAndProveCheck(program, holder, 'identity', answer), /revoked/);
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

describe('modularity: checks can be swapped and added without touching other contracts', () => {
  test('replacing the contract in a slot makes passes from the old one worthless', async () => {
    const program = await freshProgram();
    const { holder } = holderFor(program, 'mei-lin-zhao');
    await givePasses(program, holder, ['banList', 'walletControl']);
    await grant(program, holder.ticket, 'basic');

    const replacement = await program.chain.deploy('BanListCheck');
    await program.chain.call(program.addresses.ClearanceRegistry, program.admin, 'register_check', BigInt(program.slots.banList), LocalChain.contractReference(replacement));
    await refuses(grant(program, holder.ticket, 'basic'), /no pass from this check/);
  });

  test('a sixth check can be plugged into a free slot and required by a new profile', async () => {
    const program = await freshProgram();
    const registry = program.addresses.ClearanceRegistry;
    // Any contract that answers require_pass will do. Here: a second
    // EducationCheck standing in for "a check nobody has invented yet".
    const sixthCheck = await program.chain.deploy('EducationCheck');
    await program.chain.call(sixthCheck, program.admin, 'claim_admin');
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

  test('the admin can release a wallet, after which it can be bound again', async () => {
    const { program, holder } = await clearedHolder('standard');
    await bind(program, holder, 'cover-standard');
    await refuses(program.chain.call(program.addresses.PolicyBinder, stranger, 'release_binding', holder.privateState.walletHash), /not an admin/);
    await program.chain.call(program.addresses.PolicyBinder, program.admin, 'release_binding', holder.privateState.walletHash);
    await bind(program, holder, 'cover-standard');
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

  test('refused if sender and receiver are the same ticket', async () => {
    const { program, sender } = await twoClearedHolders();
    await refuses(issue(program, sender.ticket, sender.ticket), /must be different/);
  });
});

describe('privacy: what is NOT on the ledger', () => {
  test('after a full clearance and binding, no contract stores the address or the wallet hash', async () => {
    const program = await freshProgram();
    const { holder } = holderFor(program, 'mei-lin-zhao');
    await givePasses(program, holder, ALL_CHECKS);
    await grant(program, holder.ticket, 'enhanced');
    await program.chain.call(program.addresses.PolicyBinder, { ...holder.privateState, bindingSalt: random32Bytes() }, 'bind_policy', holder.ticket, padTo32Bytes('cover-enhanced'), random32Bytes());

    const secrets = {
      'the wallet address': Buffer.from(holder.wallet.address, 'utf8'),
      'the wallet hash': Buffer.from(holder.privateState.walletHash),
      'the holder secret key': Buffer.from(holder.privateState.secretKey),
      'the holder public key': Buffer.from(holder.holderPublicKey),
      'the ticket salt': Buffer.from(holder.privateState.ticketSalt)
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
