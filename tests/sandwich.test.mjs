// ============================================================================
// End-to-end tests for the binding flow.
// ============================================================================
// Run:  npm test      (needs `npm run compile:fast` once, and the KYCz + GeoZ
//                      repos checked out next to this one)
//
// Four groups:
//   A. Every synthetic persona ends at the step it is expected to, and each
//      of the five policies binds for an applicant who meets its prerequisites.
//   B. The black-box rule: a refusal from KYCz / GeoZ carries no reason.
//   C. The CONTRACT enforces the gate by itself. These tests skip the
//      off-chain checks on purpose and show the circuit still says no.
//   D. CryptoSureEdu grading and the wallet-signed acknowledgment.
// ============================================================================

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { bindPolicyToWallet, createInsuranceProgram, findPolicyTerms } from '../sandwich/bind-policy.mjs';
import { buildAcknowledgmentStatement, signAcknowledgment, verifyAcknowledgment } from '../sandwich/acknowledgment.mjs';
import { deriveDemoWalletKeyPair } from '../sandwich/wallet-control.mjs';
import { buildTestForPolicy, gradeTest, simulateAnswerSheet } from '../edu/cryptosure-edu.mjs';
import { ContractRejectedError, pureCircuits } from '../sandwich/chain.mjs';
import { commitToCredential, derivePolicyRef, deriveWalletHash, padTo32Bytes } from '../sandwich/encoding.mjs';
import { requestKycCredential } from '../oracles/kycz-client.mjs';
import { checkRegion } from '../oracles/geoz-client.mjs';
import { missingOracleRepositories, startOracles } from '../scripts/oracle-processes.mjs';

const readJson = (relativePath) => JSON.parse(readFileSync(new URL(relativePath, import.meta.url), 'utf8'));
const policyCatalog = readJson('../policies/policy-catalog.json');
const policyTemplate = findPolicyTerms(policyCatalog, 'CS-WALLET-2500');
const { personas } = readJson('../sandwich/personas.json');
const personaById = Object.fromEntries(personas.map((persona) => [persona.id, persona]));

const missingRepositories = missingOracleRepositories();
const skipReason = missingRepositories.length > 0
  ? `oracle repositories not checked out next to this repo: ${missingRepositories.join(', ')}`
  : false;

let stopOracles = () => {};
before(async () => {
  // Ports differ from the defaults so a test run never collides with `npm run oracles`.
  if (!skipReason) stopOracles = await startOracles({ kyczPort: 4111, geozPort: 4112, quiet: true });
});
after(() => stopOracles());

const expectContractRejection = (promise, contractMessage) =>
  assert.rejects(promise, (error) => {
    assert.ok(error instanceof ContractRejectedError, `expected a contract rejection, got: ${error}`);
    assert.equal(error.message, contractMessage);
    return true;
  });

// ---------------------------------------------------------------------------
// A. Persona matrix
// ---------------------------------------------------------------------------

for (const persona of personas) {
  const expectation = persona.expectedStop === null ? 'binds the policy' : `stops at ${persona.expectedStop}`;
  test(`${persona.id} ${expectation}`, { skip: skipReason }, async () => {
    const program = await createInsuranceProgram(policyCatalog);
    const result = await bindPolicyToWallet(program, persona);

    assert.equal(result.stoppedAt, persona.expectedStop);
    assert.equal(result.bound, persona.expectedStop === null);
    assert.equal(program.chain.publicLedger().bindingCount, result.bound ? 1n : 0n);
  });
}

// persona-01-avery is KYC level 2 and persona-03-casey is KYC level 1; both
// are in region with clean wallets. Used to try each policy in turn.
const LEVEL_2_APPLICANT = 'persona-01-avery';
const LEVEL_1_APPLICANT = 'persona-03-casey';

for (const policy of policyCatalog.policies) {
  test(`${policy.policyId}: an applicant who meets its prerequisites is bound`, { skip: skipReason }, async () => {
    const program = await createInsuranceProgram(policyCatalog);
    const applicant = { ...personaById[LEVEL_2_APPLICANT], appliesFor: policy.policyId, eduCorrectAnswers: 'all' };
    const result = await bindPolicyToWallet(program, applicant);

    assert.equal(result.bound, true, `stopped at ${result.stoppedAt}`);
    assert.equal(result.receipt.coverLimitUsd, policy.coverage.limitUsd);
    assert.deepEqual(result.policyDocument.educationCertificate.modulesPassed, policy.education.requiredModules);
  });

  const level1Qualifies = policy.eligibility.minKycLevel <= 1;
  test(`${policy.policyId}: a KYC level 1 applicant is ${level1Qualifies ? 'bound' : 'refused by the contract'}`, { skip: skipReason }, async () => {
    const program = await createInsuranceProgram(policyCatalog);
    const applicant = { ...personaById[LEVEL_1_APPLICANT], appliesFor: policy.policyId, eduCorrectAnswers: 'all' };
    const result = await bindPolicyToWallet(program, applicant);

    assert.equal(result.bound, level1Qualifies);
    assert.equal(result.stoppedAt, level1Qualifies ? null : 'bind-policy');
  });
}

test('the five policies are the five cover limits, each asking at least as much as the one below', () => {
  assert.deepEqual(policyCatalog.policies.map((policy) => policy.coverage.limitUsd), [500, 1000, 2500, 5000, 10000]);
  for (let index = 1; index < policyCatalog.policies.length; index += 1) {
    const lower = policyCatalog.policies[index - 1];
    const higher = policyCatalog.policies[index];
    assert.ok(higher.eligibility.minKycLevel >= lower.eligibility.minKycLevel);
    assert.ok(higher.education.passMarkPercent >= lower.education.passMarkPercent);
    assert.ok(lower.education.requiredModules.every((module) => higher.education.requiredModules.includes(module)));
    assert.ok(higher.education.requiredModules.length > lower.education.requiredModules.length);
  }
});

test('two applicants on the same policy get different on-chain policy references', { skip: skipReason }, async () => {
  const program = await createInsuranceProgram(policyCatalog);
  const first = await bindPolicyToWallet(program, { ...personaById[LEVEL_2_APPLICANT], appliesFor: 'CS-WALLET-500' });
  const second = await bindPolicyToWallet(program, { ...personaById[LEVEL_1_APPLICANT], appliesFor: 'CS-WALLET-500' });
  assert.equal(first.bound && second.bound, true);
  assert.notEqual(first.receipt.policyRef, second.receipt.policyRef);
});

test('a successful binding returns a receipt and the holder can prove it', { skip: skipReason }, async () => {
  const program = await createInsuranceProgram(policyCatalog);
  const result = await bindPolicyToWallet(program, personaById['persona-01-avery']);

  assert.equal(result.receipt.bindingProven, true);
  assert.equal(result.receipt.totalBindingsOnLedger, 1n);
  assert.match(result.receipt.policyRef, /^[0-9a-f]{64}$/);
  assert.match(result.receipt.bindingCommitment, /^[0-9a-f]{64}$/);
});

test('the policy reference is stable for the same policy and changes with any edit', () => {
  const reordered = Object.fromEntries(Object.entries(policyTemplate).reverse());
  assert.deepEqual(derivePolicyRef(reordered), derivePolicyRef(policyTemplate));

  const edited = structuredClone(policyTemplate);
  edited.coverage.limitUsd += 1;
  assert.notDeepEqual(derivePolicyRef(edited), derivePolicyRef(policyTemplate));
});

// ---------------------------------------------------------------------------
// B. Black-box rule
// ---------------------------------------------------------------------------

test('a KYCz refusal tells CryptoSure nothing but a reference id', { skip: skipReason }, async () => {
  const answer = await requestKycCredential({
    syntheticPersonaId: 'persona-02-blake',
    presenterPublicKeyHex: 'ab'.repeat(32),
    verifierNonceHex: randomBytes(32).toString('hex')
  });
  assert.deepEqual(Object.keys(answer).sort(), ['referenceId', 'verified']);
  assert.equal(answer.verified, false);
});

test('a GeoZ refusal does not reveal where the applicant is', { skip: skipReason }, async () => {
  const answer = await checkRegion({ syntheticPersonaId: 'persona-04-devon', allowedRegions: ['US-PA'] });
  assert.deepEqual(Object.keys(answer).sort(), ['inRegion', 'referenceId']);
  assert.equal(answer.inRegion, false);
});

// ---------------------------------------------------------------------------
// C. The contract enforces the gate on its own
// ---------------------------------------------------------------------------

// Build a holder by hand, skipping every off-chain check, so that only the
// contract stands between this applicant and a binding.
async function enrolWithoutOffChainChecks(program, { regionCode = 'US-PA', level = 2n, recordClearance = true, issueCredential = true } = {}) {
  const secretKey = Uint8Array.from(randomBytes(32));
  const walletHash = deriveWalletHash({ chain: 'ETH', address: `0x${randomBytes(20).toString('hex')}` });
  const credential = {
    holderPk: pureCircuits.derive_public_key(secretKey),
    level,
    jurisdictionLeaf: pureCircuits.derive_jurisdiction_leaf(padTo32Bytes(regionCode)),
    credentialId: Uint8Array.from(randomBytes(32)),
    expiresAt: BigInt(Math.floor(Date.now() / 1000) + 86_400)
  };
  const credentialSalt = Uint8Array.from(randomBytes(32));

  if (issueCredential) await program.chain.call(program.issuer, 'issue_credential', commitToCredential(credential, credentialSalt));
  if (recordClearance) await program.chain.call(program.screener, 'record_clearance', { walletHash, listVersion: 1n });

  return { secretKey, credential, credentialSalt, walletHash, clearanceListVersion: 1n, bindingSalt: Uint8Array.from(randomBytes(32)) };
}

const somePolicyRef = derivePolicyRef({ ...policyTemplate, policyId: 'CS-TEST' });

test('contract: a correctly enrolled holder binds (control case for the rejections below)', async () => {
  const program = await createInsuranceProgram(policyCatalog);
  const holder = await enrolWithoutOffChainChecks(program);
  await program.chain.call(holder, 'bind_wallet', somePolicyRef, 2n);
  assert.equal(program.chain.publicLedger().bindingCount, 1n);
});

test('contract: rejects a credential for a region that is not licensed', async () => {
  const program = await createInsuranceProgram(policyCatalog);
  const holder = await enrolWithoutOffChainChecks(program, { regionCode: 'US-NY' });
  await expectContractRejection(program.chain.call(holder, 'bind_wallet', somePolicyRef, 2n), 'Jurisdiction not eligible');
});

test('contract: rejects a KYC level below the policy requirement', async () => {
  const program = await createInsuranceProgram(policyCatalog);
  const holder = await enrolWithoutOffChainChecks(program, { level: 1n });
  await expectContractRejection(program.chain.call(holder, 'bind_wallet', somePolicyRef, 2n), 'KYC level below requirement');
});

test('contract: rejects a wallet that was never cleared by screening', async () => {
  const program = await createInsuranceProgram(policyCatalog);
  const holder = await enrolWithoutOffChainChecks(program, { recordClearance: false });
  await expectContractRejection(program.chain.call(holder, 'bind_wallet', somePolicyRef, 2n), 'Wallet not cleared by screening');
});

test('contract: rejects a credential the issuer never issued', async () => {
  const program = await createInsuranceProgram(policyCatalog);
  const holder = await enrolWithoutOffChainChecks(program, { issueCredential: false });
  await expectContractRejection(program.chain.call(holder, 'bind_wallet', somePolicyRef, 2n), 'KYC credential not found');
});

test('contract: rejects an expired credential', async () => {
  const program = await createInsuranceProgram(policyCatalog);
  const holder = await enrolWithoutOffChainChecks(program, { issueCredential: false });
  holder.credential.expiresAt = BigInt(Math.floor(Date.now() / 1000) - 86_400);
  await program.chain.call(program.issuer, 'issue_credential', commitToCredential(holder.credential, holder.credentialSalt));
  await expectContractRejection(program.chain.call(holder, 'bind_wallet', somePolicyRef, 2n), 'KYC credential expired');
});

test('contract: rejects someone presenting another holder\'s credential', async () => {
  const program = await createInsuranceProgram(policyCatalog);
  const holder = await enrolWithoutOffChainChecks(program);
  const thief = { ...holder, secretKey: Uint8Array.from(randomBytes(32)) };
  await expectContractRejection(program.chain.call(thief, 'bind_wallet', somePolicyRef, 2n), 'Credential does not belong to caller');
});

test('contract: one wallet cannot be bound twice', async () => {
  const program = await createInsuranceProgram(policyCatalog);
  const holder = await enrolWithoutOffChainChecks(program);
  await program.chain.call(holder, 'bind_wallet', somePolicyRef, 2n);
  await expectContractRejection(program.chain.call(holder, 'bind_wallet', somePolicyRef, 2n), 'Wallet already bound to a policy');
  assert.equal(program.chain.publicLedger().bindingCount, 1n);
});

test('contract: a binding cannot be proven against a different policy', async () => {
  const program = await createInsuranceProgram(policyCatalog);
  const holder = await enrolWithoutOffChainChecks(program);
  await program.chain.call(holder, 'bind_wallet', somePolicyRef, 2n);

  assert.equal(await program.chain.call(holder, 'prove_binding', somePolicyRef), true);
  const otherPolicyRef = derivePolicyRef({ ...policyTemplate, policyId: 'CS-OTHER' });
  await expectContractRejection(program.chain.call(holder, 'prove_binding', otherPolicyRef), 'No such binding');
});

test('contract: only the issuer role can issue and only the screener role can clear', async () => {
  const program = await createInsuranceProgram(policyCatalog);
  const outsider = { secretKey: Uint8Array.from(randomBytes(32)) };
  await expectContractRejection(program.chain.call(outsider, 'issue_credential', new Uint8Array(32)), 'Caller is not an approved issuer');
  await expectContractRejection(
    program.chain.call(outsider, 'record_clearance', { walletHash: new Uint8Array(32), listVersion: 1n }),
    'Caller is not an approved screener'
  );
});

// ---------------------------------------------------------------------------
// D. CryptoSureEdu and the signed acknowledgment
// ---------------------------------------------------------------------------

test('edu: the test handed to an applicant contains no answers', () => {
  for (const policy of policyCatalog.policies) {
    const eduTest = buildTestForPolicy(policy);
    assert.equal(eduTest.questions.length, policy.education.requiredModules.length * 3);
    assert.ok(!JSON.stringify(eduTest).includes('correctOption'));
  }
});

for (const policy of policyCatalog.policies) {
  test(`edu: ${policy.policyId} passes exactly at its pass mark and not one answer below`, () => {
    const questionCount = buildTestForPolicy(policy).questions.length;
    const fewestCorrectToPass = Math.ceil((policy.education.passMarkPercent * questionCount) / 100);

    const justPassing = gradeTest(policy, simulateAnswerSheet(policy, fewestCorrectToPass));
    assert.equal(justPassing.passed, true);
    assert.equal(justPassing.certificate.policyId, policy.policyId);

    const oneShort = gradeTest(policy, simulateAnswerSheet(policy, fewestCorrectToPass - 1));
    assert.equal(oneShort.passed, false);
    assert.equal(oneShort.certificate, undefined, 'a failed test must not produce a certificate');
  });
}

test('edu: unanswered and malformed answers count as wrong', () => {
  const policy = policyCatalog.policies[0];
  assert.equal(gradeTest(policy, {}).correctCount, 0);
  assert.equal(gradeTest(policy, { 'wh-1': '1', 'wh-2': null, 'not-a-question': 0 }).correctCount, 0);
  assert.throws(() => gradeTest(policy, null), TypeError);
});

test('edu: a certificate for a smaller policy does not cover the modules of a larger one', () => {
  const smallCertificate = gradeTest(policyCatalog.policies[0], simulateAnswerSheet(policyCatalog.policies[0], 6)).certificate;
  const largePolicy = policyCatalog.policies[4];
  assert.ok(!largePolicy.education.requiredModules.every((module) => smallCertificate.modulesPassed.includes(module)));
});

const acknowledgmentWallet = { chain: 'ETH', address: '0x3a1f9c04e7b2d85f6a0c91e4d7b3f28a6c5e0d11' };
const walletKeys = deriveDemoWalletKeyPair('acknowledgment-test-wallet');
const signFor = (policyTerms, wallet = acknowledgmentWallet, keys = walletKeys) =>
  signAcknowledgment(keys.privateKey, buildAcknowledgmentStatement({ policyTerms, wallet }));

test('acknowledgment: a signature from the insured wallet over this policy verifies', () => {
  const policyTerms = findPolicyTerms(policyCatalog, 'CS-WALLET-5000');
  assert.equal(verifyAcknowledgment({ policyTerms, wallet: acknowledgmentWallet, walletPublicKey: walletKeys.publicKey, signatureHex: signFor(policyTerms) }), true);
});

test('acknowledgment: a signature cannot be reused for another policy, edited terms, another wallet, or another key', () => {
  const policyTerms = findPolicyTerms(policyCatalog, 'CS-WALLET-500');
  const signatureHex = signFor(policyTerms);
  const check = (overrides) => verifyAcknowledgment({ policyTerms, wallet: acknowledgmentWallet, walletPublicKey: walletKeys.publicKey, signatureHex, ...overrides });

  assert.equal(check({ policyTerms: findPolicyTerms(policyCatalog, 'CS-WALLET-10000') }), false, 'different policy');
  const editedTerms = structuredClone(policyTerms);
  editedTerms.coverage.deductibleUsd += 1;
  assert.equal(check({ policyTerms: editedTerms }), false, 'edited terms');
  assert.equal(check({ wallet: { chain: 'ETH', address: '0x91d4b7a3e2c05f68d1b9e4a7c3f20d5e6a8b1c33' } }), false, 'different wallet');
  assert.equal(check({ walletPublicKey: deriveDemoWalletKeyPair('someone-else').publicKey }), false, 'different key');
  assert.equal(check({ signatureHex: 'not-a-signature' }), false, 'malformed signature');
});
