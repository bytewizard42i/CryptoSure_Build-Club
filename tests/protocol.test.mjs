// ============================================================================
// protocol.test.mjs — the whole flow, the way an application would run it
// ============================================================================
// These tests go through the off-chain protocol (protocol/*.mjs) with the
// mock providers. They check the three outcomes, stopping at the first
// failure, reuse of passes that are still good, the pair check, and binding.
// contracts.test.mjs separately proves the contracts refuse on their own.
// ============================================================================

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { clearWallet, createHolder, readClearance } from '../protocol/clearance.mjs';
import { ClearanceDirectory, checkPair } from '../protocol/pair-check.mjs';
import { bindPolicy } from '../protocol/bind-policy.mjs';
import { buildAcknowledgmentStatement } from '../protocol/acknowledgment.mjs';
import { createMockProviders } from '../protocol/providers/mock-providers.mjs';
import { createDemoWalletSigner } from '../protocol/wallet-signatures.mjs';
import { deriveWalletHash, deriveDemoSecretKey, padTo32Bytes } from '../protocol/encoding.mjs';
import { minLevelsVector } from '../protocol/program.mjs';
import { MOCK_FIXTURE, ONE_DAY, SUBJECTS, freshProgram, holderFor, mockProviders } from './helpers.mjs';

async function clear(program, providers, subjectId, profile, directory) {
  const { holder, walletSigner, subject } = holderFor(program, subjectId);
  const result = await clearWallet(program, providers, holder, profile, { walletSigner });
  directory?.record(holder, result, program.chain.now);
  return { holder, walletSigner, subject, result };
}
const stepNames = (result) => result.steps.map((step) => step.check);

describe('clearing a wallet: three outcomes, and it stops at the first failure', () => {
  // subject, profile, expected status, where it stops, the checks that ran
  const CASES = [
    ['bonnie-lachance', 'standard', 'clear', null, ['banList', 'walletControl', 'region', 'identity', 'education', 'grant-clearance']],
    ['mei-lin-zhao', 'enhanced', 'clear', null, ['banList', 'walletControl', 'region', 'identity', 'education', 'grant-clearance']],
    ['anya-petrova', 'basic', 'clear', null, ['banList', 'walletControl', 'grant-clearance']],
    ['colin-mcbride', 'standard', 'not-cleared', 'banList', ['banList']],
    ['diego-marchetti', 'standard', 'unsure', 'banList', ['banList']],
    ['edgar-morrow', 'standard', 'not-cleared', 'walletControl', ['banList', 'walletControl']],
    ['priscilla-vance', 'standard', 'not-cleared', 'region', ['banList', 'walletControl', 'region']],
    ['harold-quist', 'standard', 'not-cleared', 'identity', ['banList', 'walletControl', 'region', 'identity']],
    ['amos-fairweather', 'standard', 'not-cleared', 'education', ['banList', 'walletControl', 'region', 'identity', 'education']],
    ['bonnie-lachance', 'enhanced', 'not-cleared', 'identity', ['banList', 'walletControl', 'region', 'identity']],
    ['marcus-reid', 'enhanced', 'not-cleared', 'education', ['banList', 'walletControl', 'region', 'identity', 'education']]
  ];
  for (const [subjectId, profile, status, stoppedAt, ranChecks] of CASES) {
    test(`${subjectId} for "${profile}": ${status}${stoppedAt ? ` (stops at ${stoppedAt})` : ''}`, async () => {
      const program = await freshProgram();
      const { holder, result } = await clear(program, mockProviders(), subjectId, profile);
      assert.equal(result.status, status);
      assert.equal(result.stoppedAt, stoppedAt);
      assert.deepEqual(stepNames(result), ranChecks);
      assert.equal(readClearance(program, holder.ticket, profile).clear, status === 'clear');
    });
  }

  test('a refusal carries an opaque reference and never a reason', async () => {
    const program = await freshProgram();
    const { result } = await clear(program, mockProviders(), 'priscilla-vance', 'standard');
    const refusal = result.steps.at(-1).detail;
    assert.match(refusal, /ref mock-ref-[0-9a-f]{12}/);
    assert.doesNotMatch(JSON.stringify(result), /REGION-Z/);
  });

  test('a provider that is never asked is never called', async () => {
    const program = await freshProgram();
    const providers = mockProviders();
    let educationCalls = 0;
    const original = providers.education.certify;
    providers.education.certify = async (request) => { educationCalls += 1; return original(request); };
    await clear(program, providers, 'priscilla-vance', 'standard');   // stops at region
    await clear(program, providers, 'anya-petrova', 'basic');         // basic does not need education
    assert.equal(educationCalls, 0);
  });

  test('the order of checks can be changed, and the first failure in that order wins', async () => {
    const program = await freshProgram();
    const { holder, walletSigner } = holderFor(program, 'amos-fairweather');   // only education fails
    const result = await clearWallet(program, mockProviders(), holder, 'standard', { walletSigner, checkOrder: ['education', 'banList', 'walletControl', 'region', 'identity'] });
    assert.equal(result.stoppedAt, 'education');
    assert.deepEqual(stepNames(result), ['education']);
  });

  test('unknown profiles and unknown checks are errors, not silent passes', async () => {
    const program = await freshProgram();
    const { holder, walletSigner } = holderFor(program, 'bonnie-lachance');
    await assert.rejects(clearWallet(program, mockProviders(), holder, 'no-such-profile', { walletSigner }), /no profile/);
    await assert.rejects(clearWallet(program, mockProviders(), holder, 'basic', { walletSigner, checkOrder: ['banList', 'horoscope'] }), /unknown check/);
    assert.throws(() => minLevelsVector(program.slots, { horoscope: 1 }), /Unknown check/);
  });
});

describe('shelf life: passes are reused while good, and re-done when stale', () => {
  test('a second clearance reuses current passes and asks no provider again', async () => {
    const program = await freshProgram();
    const providers = mockProviders();
    const { holder, walletSigner } = holderFor(program, 'mei-lin-zhao');
    await clearWallet(program, providers, holder, 'enhanced', { walletSigner });
    const again = await clearWallet(program, providers, holder, 'standard', { walletSigner });
    assert.equal(again.status, 'clear');
    assert.equal(again.steps.filter((step) => step.reused).length, 5);
  });

  test('a day later only the ban list is asked again; the slower checks are still good', async () => {
    const program = await freshProgram();
    const providers = mockProviders();
    const { holder, walletSigner } = holderFor(program, 'mei-lin-zhao');
    const first = await clearWallet(program, providers, holder, 'enhanced', { walletSigner });
    assert.equal(first.validUntil, program.chain.now + ONE_DAY);
    program.chain.advanceTime(ONE_DAY + 60);
    assert.equal(readClearance(program, holder.ticket, 'enhanced').clear, false);
    const renewed = await clearWallet(program, providers, holder, 'enhanced', { walletSigner });
    assert.equal(renewed.status, 'clear');
    assert.deepEqual(renewed.steps.filter((step) => step.reused === false).map((step) => step.check), ['banList']);
  });

  test('a wallet that lands on the ban list cannot renew its clearance', async () => {
    const program = await freshProgram();
    const { holder, walletSigner, subject } = holderFor(program, 'mei-lin-zhao');
    await clearWallet(program, mockProviders(), holder, 'basic', { walletSigner });
    program.chain.advanceTime(ONE_DAY + 60);
    const nowListed = createMockProviders({ ...MOCK_FIXTURE, listedWallets: [...MOCK_FIXTURE.listedWallets, subject.wallet] });
    const renewed = await clearWallet(program, nowListed, holder, 'basic', { walletSigner });
    assert.equal(renewed.status, 'not-cleared');
    assert.equal(renewed.stoppedAt, 'banList');
  });
});

describe('pair check: advice about a sender and a receiver', () => {
  async function programWithTwoClearWallets() {
    const program = await freshProgram();
    const providers = mockProviders();
    const directory = new ClearanceDirectory();
    await clear(program, providers, 'mei-lin-zhao', 'basic', directory);
    await clear(program, providers, 'theo-brandt', 'basic', directory);
    return { program, providers, directory };
  }
  const wallet = (subjectId) => SUBJECTS[subjectId].wallet;

  test('both clear: proceed, with a dated on-chain receipt', async () => {
    const { program, providers, directory } = await programWithTwoClearWallets();
    const outcome = await checkPair(program, providers, directory, { sender: wallet('mei-lin-zhao'), receiver: wallet('theo-brandt') });
    assert.equal(outcome.advice, 'proceed');
    assert.match(outcome.receiptId, /^[0-9a-f]{64}$/);
    assert.equal(outcome.receiptValidUntil, program.chain.now + 900);
    assert.equal(Number(program.chain.publicLedger(program.addresses.PairReceipt).receiptCount), 1);
  });

  test('a wallet cleared only for a STRICTER profile still counts as clear', async () => {
    const program = await freshProgram();
    const providers = mockProviders();
    const directory = new ClearanceDirectory();
    await clear(program, providers, 'mei-lin-zhao', 'enhanced', directory);
    await clear(program, providers, 'bonnie-lachance', 'standard', directory);
    const outcome = await checkPair(program, providers, directory, { sender: wallet('mei-lin-zhao'), receiver: wallet('bonnie-lachance') });
    assert.deepEqual([outcome.sender.status, outcome.receiver.status, outcome.advice], ['clear', 'clear', 'proceed']);
    assert.match(outcome.receiptId, /^[0-9a-f]{64}$/);
  });

  test('receiver never cleared: caution, and no receipt', async () => {
    const { program, providers, directory } = await programWithTwoClearWallets();
    const outcome = await checkPair(program, providers, directory, { sender: wallet('mei-lin-zhao'), receiver: wallet('anya-petrova') });
    assert.deepEqual([outcome.sender.status, outcome.receiver.status, outcome.advice, outcome.receiptId], ['clear', 'unsure', 'caution', null]);
  });

  test('receiver on the ban list: stop', async () => {
    const { program, providers, directory } = await programWithTwoClearWallets();
    const outcome = await checkPair(program, providers, directory, { sender: wallet('mei-lin-zhao'), receiver: wallet('colin-mcbride') });
    assert.deepEqual([outcome.receiver.status, outcome.advice, outcome.receiptId], ['not-cleared', 'stop', null]);
  });

  test('a cleared wallet that is listed LATER turns to stop at once, before its clearance expires', async () => {
    const { program, directory } = await programWithTwoClearWallets();
    const nowListed = createMockProviders({ ...MOCK_FIXTURE, listedWallets: [...MOCK_FIXTURE.listedWallets, wallet('theo-brandt')] });
    const outcome = await checkPair(program, nowListed, directory, { sender: wallet('mei-lin-zhao'), receiver: wallet('theo-brandt') });
    assert.deepEqual([outcome.receiver.status, outcome.advice], ['not-cleared', 'stop']);
  });

  test('an expired clearance turns to caution', async () => {
    const { program, providers, directory } = await programWithTwoClearWallets();
    program.chain.advanceTime(ONE_DAY + 60);
    const outcome = await checkPair(program, providers, directory, { sender: wallet('mei-lin-zhao'), receiver: wallet('theo-brandt') });
    assert.deepEqual([outcome.sender.status, outcome.receiver.status, outcome.advice], ['unsure', 'unsure', 'caution']);
  });

  test('the answer never contains a ticket or a reason', async () => {
    const { program, providers, directory } = await programWithTwoClearWallets();
    const outcome = await checkPair(program, providers, directory, { sender: wallet('mei-lin-zhao'), receiver: wallet('colin-mcbride') });
    assert.deepEqual(Object.keys(outcome.sender).sort(), ['clearedUntil', 'referenceId', 'status']);
    assert.deepEqual(Object.keys(outcome.receiver).sort(), ['clearedUntil', 'referenceId', 'status']);
  });

  test('the directory keeps a dated history per wallet, including failed attempts', async () => {
    const program = await freshProgram();
    const providers = mockProviders();
    const directory = new ClearanceDirectory();
    await clear(program, providers, 'bonnie-lachance', 'enhanced', directory);   // fails at identity
    program.chain.advanceTime(3600);
    await clear(program, providers, 'bonnie-lachance', 'standard', directory);   // clears
    const history = directory.historyFor(wallet('bonnie-lachance'));
    assert.deepEqual(history.map((entry) => [entry.profile, entry.status]), [['enhanced', 'not-cleared'], ['standard', 'clear']]);
    assert.equal(history[1].at - history[0].at, 3600);
    assert.deepEqual(directory.historyFor(wallet('anya-petrova')), []);
  });
});

describe('binding a policy', () => {
  const TERMS = { summary: 'demo terms', limit: 'placeholder' };

  test('a cleared holder signs the acknowledgment and the policy binds', async () => {
    const program = await freshProgram();
    const providers = mockProviders();
    const { holder, walletSigner } = await clear(program, providers, 'mei-lin-zhao', 'enhanced');
    const outcome = await bindPolicy(program, providers, holder, { coverClass: 'cover-enhanced', policyTerms: TERMS, walletSigner });
    assert.equal(outcome.bound, true);
    assert.deepEqual(outcome.steps.map((step) => step.step), ['acknowledge-agreement', 'bind-policy', 'prove-binding']);
    assert.equal(outcome.receipt.totalBindingsOnLedger, 1);
    assert.equal(outcome.holderRecord.policyDocument.acknowledgment.statement, buildAcknowledgmentStatement({ coverClass: 'cover-enhanced', policyTerms: TERMS, wallet: holder.wallet }));
  });

  test('declining to sign stops before anything reaches a contract', async () => {
    const program = await freshProgram();
    const providers = mockProviders();
    const { holder } = await clear(program, providers, 'fern-whitaker', 'enhanced');
    const outcome = await bindPolicy(program, providers, holder, { coverClass: 'cover-enhanced', policyTerms: TERMS, walletSigner: null });
    assert.deepEqual([outcome.bound, outcome.stoppedAt], [false, 'acknowledge-agreement']);
    assert.equal(Number(program.chain.publicLedger(program.addresses.PolicyBinder).bindingCount), 0);
  });

  test('an acknowledgment signed by a different key is refused', async () => {
    const program = await freshProgram();
    const providers = mockProviders();
    const { holder } = await clear(program, providers, 'mei-lin-zhao', 'enhanced');
    const wrongSigner = createDemoWalletSigner(holder.wallet, { signWithSomeoneElsesKey: true });
    const outcome = await bindPolicy(program, providers, holder, { coverClass: 'cover-enhanced', policyTerms: TERMS, walletSigner: wrongSigner });
    assert.deepEqual([outcome.bound, outcome.stoppedAt], [false, 'acknowledge-agreement']);
  });

  test('the contract, not our software, refuses a policy the clearance does not support', async () => {
    const program = await freshProgram();
    const providers = mockProviders();
    const { holder, walletSigner } = await clear(program, providers, 'bonnie-lachance', 'standard');
    const outcome = await bindPolicy(program, providers, holder, { coverClass: 'cover-enhanced', policyTerms: TERMS, walletSigner });
    assert.deepEqual([outcome.bound, outcome.stoppedAt], [false, 'bind-policy']);
    assert.match(outcome.steps.at(-1).detail, /not cleared for this profile/);
  });

  test('a holder who was never cleared cannot bind', async () => {
    const program = await freshProgram();
    const { holder, walletSigner } = holderFor(program, 'anya-petrova');
    const outcome = await bindPolicy(program, mockProviders(), holder, { coverClass: 'cover-standard', policyTerms: TERMS, walletSigner });
    assert.deepEqual([outcome.bound, outcome.stoppedAt], [false, 'bind-policy']);
  });

  test('different terms give a different policy reference', async () => {
    const program = await freshProgram();
    const providers = mockProviders();
    const first = await clear(program, providers, 'mei-lin-zhao', 'enhanced');
    const second = await clear(program, providers, 'theo-brandt', 'enhanced');
    const a = await bindPolicy(program, providers, first.holder, { coverClass: 'cover-enhanced', policyTerms: TERMS, walletSigner: first.walletSigner });
    const b = await bindPolicy(program, providers, second.holder, { coverClass: 'cover-enhanced', policyTerms: { ...TERMS, limit: 'other' }, walletSigner: second.walletSigner });
    assert.notEqual(a.receipt.policyRef, b.receipt.policyRef);
  });
});

describe('small building blocks', () => {
  test('the wallet hash depends on the program key, the chain and the address', () => {
    const keyA = deriveDemoSecretKey('key-a');
    const keyB = deriveDemoSecretKey('key-b');
    const wallet = { chain: 'midnight-preprod', address: 'mn_addr_preprod1example' };
    const hash = (key, w) => Buffer.from(deriveWalletHash(key, w)).toString('hex');
    assert.equal(hash(keyA, wallet), hash(keyA, { ...wallet }));
    assert.notEqual(hash(keyA, wallet), hash(keyB, wallet));
    assert.notEqual(hash(keyA, wallet), hash(keyA, { ...wallet, chain: 'other' }));
    assert.throws(() => deriveWalletHash(new Uint8Array(5), wallet), /32-byte/);
    assert.throws(() => deriveWalletHash(keyA, { chain: '', address: 'x' }), /non-empty/);
  });

  test('two tickets for the same person and wallet are unlinkable', async () => {
    const program = await freshProgram();
    const wallet = SUBJECTS['bonnie-lachance'].wallet;
    const first = createHolder(program, { subjectId: 'bonnie-lachance', wallet });
    const second = createHolder(program, { subjectId: 'bonnie-lachance', wallet });
    assert.notDeepEqual(first.ticket, second.ticket);
    assert.deepEqual(first.holderPublicKey, second.holderPublicKey);
  });

  test('names longer than 32 bytes are rejected, not truncated', () => {
    assert.throws(() => padTo32Bytes('x'.repeat(33)), /longer than 32 bytes/);
  });

  test('every mock provider insists on being told the time', async () => {
    const providers = mockProviders();
    await assert.rejects(providers.banList.screen({ wallet: SUBJECTS['bonnie-lachance'].wallet }), /unix seconds/);
    await assert.rejects(providers.identity.verify({ subjectId: 'bonnie-lachance', now: -1 }), /unix seconds/);
  });

  test('the mock providers answer "unknown" for a subject they have never heard of', async () => {
    const providers = mockProviders();
    const now = 1_800_000_000;
    for (const answer of [
      await providers.region.attest({ subjectId: 'nobody', allowedRegions: ['REGION-A'], now }),
      await providers.identity.verify({ subjectId: 'nobody', now }),
      await providers.education.certify({ subjectId: 'nobody', now }),
      await providers.banList.screen({ wallet: { chain: 'x', address: 'never-seen' }, now })
    ]) {
      assert.equal(answer.outcome, 'unknown');
    }
  });
});
