// ============================================================================
// The sandwich — binding one insurance policy to one wallet.
// ============================================================================
//
//   1. validate the user            KYCz oracle + GeoZ oracle  (black boxes)
//   2. prove they have this wallet  signed challenge
//   3. validate the wallet          denylist screening
//   4. pass the CryptoSureEdu test  modules and pass mark set by the policy
//   5. acknowledge the agreement    wallet-signed "I understand this policy"
//   6. bind the policy              WalletBinder.bind_wallet   (one ZK-checked call)
//   7. prove the binding            WalletBinder.prove_binding
//
// The applicant picks one of the policies in policies/policy-catalog.json.
// Each has its own prerequisites: a minimum KYC level (enforced by the
// contract), required education modules, and a pass mark.
//
// Steps 1 to 5 happen off-chain and privately. Step 6 is the only moment
// anything lands on the ledger, and what lands is: hidden commitments, a
// nullifier, and a counter going up by one. No name, no address, no location,
// no policy text.
//
// Each step either passes or stops the flow. The result lists every step
// that ran, so a demo can show exactly where an applicant was turned away.
// ============================================================================

import { createHash, randomBytes } from 'node:crypto';
import { LocalWalletBinderChain, ContractRejectedError, pureCircuits } from './chain.mjs';
import {
  bytesToHex,
  commitToCredential,
  derivePolicyRef,
  deriveWalletHash,
  hexToBytes,
  padTo32Bytes
} from './encoding.mjs';
import {
  createWalletControlChallenge,
  deriveDemoWalletKeyPair,
  signWalletControlChallenge,
  verifyWalletControl
} from './wallet-control.mjs';
import { buildAcknowledgmentStatement, signAcknowledgment, verifyAcknowledgment } from './acknowledgment.mjs';
import { buildTestForPolicy, gradeTest, simulateAnswerSheet } from '../edu/cryptosure-edu.mjs';
import { requestKycCredential } from '../oracles/kycz-client.mjs';
import { checkRegion } from '../oracles/geoz-client.mjs';
import { screenWallet } from '../oracles/wallet-screening.mjs';

// DEMO ONLY: secret keys derived from a label so runs are repeatable. A real
// key comes from the holder's wallet and never leaves their device.
function deriveDemoSecretKey(label) {
  return Uint8Array.from(createHash('sha256').update(`cryptosure:demo-secret-key:${label}`, 'utf8').digest());
}

/**
 * Stand up an insurance program: deploy WalletBinder locally, hand out the
 * admin / issuer / screener roles, and publish every region any policy in
 * the catalog is licensed for.
 */
export async function createInsuranceProgram(policyCatalog) {
  const chain = await LocalWalletBinderChain.deploy();

  const admin = { secretKey: deriveDemoSecretKey('program-admin') };
  const issuer = { secretKey: deriveDemoSecretKey('kyc-issuer') };
  const screener = { secretKey: deriveDemoSecretKey('wallet-screener') };

  await chain.call(admin, 'claim_admin');
  await chain.call(admin, 'add_issuer', pureCircuits.derive_public_key(issuer.secretKey));
  await chain.call(admin, 'add_screener', pureCircuits.derive_public_key(screener.secretKey));

  const licensedRegions = new Set(policyCatalog.policies.flatMap((policy) => policy.eligibility.allowedRegions));
  for (const regionCode of licensedRegions) {
    await chain.call(admin, 'add_allowed_jurisdiction', padTo32Bytes(regionCode));
  }

  return { chain, issuer, screener, policyCatalog };
}

// The full terms of one policy: the shared program terms plus that policy's
// own limit, premium and prerequisites.
export function findPolicyTerms(policyCatalog, policyId) {
  const policy = policyCatalog.policies.find((candidate) => candidate.policyId === policyId);
  if (policy === undefined) {
    const available = policyCatalog.policies.map((candidate) => candidate.policyId).join(', ');
    throw new Error(`There is no policy "${policyId}". Available policies: ${available}.`);
  }
  return { ...policyCatalog.sharedTerms, ...policy };
}

/**
 * Run the full flow for one applicant, one wallet, and the policy they chose
 * (persona.appliesFor).
 * @returns {Promise<{bound: boolean, stoppedAt: string|null, steps: object[], receipt?: object}>}
 */
export async function bindPolicyToWallet(program, persona) {
  const { chain, issuer, screener } = program;
  const policyTerms = findPolicyTerms(program.policyCatalog, persona.appliesFor);
  const { minKycLevel, allowedRegions } = policyTerms.eligibility;
  const steps = [];
  const stop = (step, detail) => {
    steps.push({ step, passed: false, detail });
    return { bound: false, stoppedAt: step, steps };
  };
  const pass = (step, detail) => steps.push({ step, passed: true, detail });

  // The holder's CryptoSure-scoped key pair. The public half is what the
  // credential is issued to; the secret half never leaves the holder.
  const holderSecretKey = deriveDemoSecretKey(`holder:${persona.id}`);
  const holderPublicKey = pureCircuits.derive_public_key(holderSecretKey);

  // ---- 1a. Validate the user: KYC (KYCz black box) -------------------------
  const kycAnswer = await requestKycCredential({
    syntheticPersonaId: persona.id,
    presenterPublicKeyHex: bytesToHex(holderPublicKey),
    verifierNonceHex: randomBytes(32).toString('hex')
  });
  if (!kycAnswer.verified) return stop('validate-user:kyc', `KYCz did not verify this applicant (ref ${kycAnswer.referenceId})`);
  pass('validate-user:kyc', `KYCz verified the applicant (ref ${kycAnswer.referenceId})`);

  // ---- 1b. Validate the user: region (GeoZ black box) ----------------------
  const geoAnswer = await checkRegion({ syntheticPersonaId: persona.id, allowedRegions });
  if (!geoAnswer.inRegion) return stop('validate-user:geo', `GeoZ did not place this applicant in a licensed region (ref ${geoAnswer.referenceId})`);
  pass('validate-user:geo', `GeoZ placed the applicant in a licensed region (ref ${geoAnswer.referenceId})`);

  // ---- 2. Prove they have this wallet --------------------------------------
  const walletOwnerKeys = deriveDemoWalletKeyPair(`${persona.wallet.chain}:${persona.wallet.address}`);
  const applicantKeys = persona.signsWithSomeoneElsesKey ? deriveDemoWalletKeyPair(`not-the-owner:${persona.id}`) : walletOwnerKeys;
  const challenge = createWalletControlChallenge(persona.wallet);
  const signature = signWalletControlChallenge(applicantKeys.privateKey, challenge);
  if (!verifyWalletControl({ walletPublicKey: walletOwnerKeys.publicKey, challenge, signature })) {
    return stop('prove-wallet-control', 'The signature does not match the wallet key (WALLET_CONTROL_NOT_PROVEN)');
  }
  pass('prove-wallet-control', 'The applicant signed a fresh challenge with the wallet key');

  // ---- 3. Validate the wallet ----------------------------------------------
  const screening = screenWallet(persona.wallet);
  if (!screening.cleared) return stop('validate-wallet', `Screening did not clear the wallet (${screening.reasonCode})`);
  pass('validate-wallet', `Wallet cleared against denylist version ${screening.listVersion}`);

  // ---- 4. Pass the CryptoSureEdu test --------------------------------------
  const eduTest = buildTestForPolicy(policyTerms);
  const correctAnswerCount = persona.eduCorrectAnswers === 'all' ? eduTest.questions.length : persona.eduCorrectAnswers;
  const eduResult = gradeTest(policyTerms, simulateAnswerSheet(policyTerms, correctAnswerCount));
  const eduSummary = `${eduResult.correctCount}/${eduResult.questionCount} correct (${eduResult.scorePercent}%, pass mark ${eduTest.passMarkPercent}%)`;
  if (!eduResult.passed) return stop('pass-edu-test', `CryptoSureEdu test not passed: ${eduSummary} (EDU_TEST_NOT_PASSED)`);
  pass('pass-edu-test', `CryptoSureEdu test passed: ${eduSummary}`);

  // ---- 5. Acknowledge the agreement, signed with the insured wallet ---------
  if (persona.declinesToAcknowledge) {
    return stop('acknowledge-agreement', 'The applicant did not sign the acknowledgment (AGREEMENT_NOT_ACKNOWLEDGED)');
  }
  const acknowledgmentStatement = buildAcknowledgmentStatement({ policyTerms, wallet: persona.wallet });
  const acknowledgmentSignature = signAcknowledgment(applicantKeys.privateKey, acknowledgmentStatement);
  const acknowledgmentIsValid = verifyAcknowledgment({
    policyTerms,
    wallet: persona.wallet,
    walletPublicKey: walletOwnerKeys.publicKey,
    signatureHex: acknowledgmentSignature
  });
  if (!acknowledgmentIsValid) {
    return stop('acknowledge-agreement', 'The acknowledgment signature does not match the wallet key (AGREEMENT_NOT_ACKNOWLEDGED)');
  }
  pass('acknowledge-agreement', `The applicant signed "I understand this agreement" for ${policyTerms.policyId} with the wallet key`);

  // ---- Record the two attestations on the ledger (as hidden leaves) --------
  const walletHash = deriveWalletHash(persona.wallet);
  const clearanceListVersion = BigInt(screening.listVersion);
  await chain.call(screener, 'record_clearance', { walletHash, listVersion: clearanceListVersion });

  const credential = {
    holderPk: holderPublicKey,
    level: BigInt(kycAnswer.level),
    jurisdictionLeaf: pureCircuits.derive_jurisdiction_leaf(padTo32Bytes(geoAnswer.regionCode)),
    credentialId: hexToBytes(kycAnswer.credentialId),
    expiresAt: BigInt(kycAnswer.expiresAt)
  };
  const credentialSalt = hexToBytes(kycAnswer.salt);
  await chain.call(issuer, 'issue_credential', commitToCredential(credential, credentialSalt));

  // ---- 6. Bind the policy ---------------------------------------------------
  // The completed private agreement: the terms, the proof the test was
  // passed, and the signed acknowledgment. Its hash is what goes on-chain.
  const policyDocument = {
    ...policyTerms,
    agreementId: `${policyTerms.policyId}:${persona.id}`,
    educationCertificate: eduResult.certificate,
    acknowledgment: { statement: acknowledgmentStatement, walletSignature: acknowledgmentSignature }
  };
  const policyRef = derivePolicyRef(policyDocument);
  const holder = {
    secretKey: holderSecretKey,
    credential,
    credentialSalt,
    walletHash,
    clearanceListVersion,
    bindingSalt: Uint8Array.from(randomBytes(32))
  };

  let bindingCommitment;
  try {
    bindingCommitment = await chain.call(holder, 'bind_wallet', policyRef, BigInt(minKycLevel));
  } catch (error) {
    if (error instanceof ContractRejectedError) return stop('bind-policy', `The contract refused the binding: ${error.message}`);
    throw error;
  }
  pass('bind-policy', 'WalletBinder accepted the proof and recorded the binding');

  // ---- 7. Prove the binding -------------------------------------------------
  const bindingProven = await chain.call(holder, 'prove_binding', policyRef);
  pass('prove-binding', 'The holder proved this wallet is bound to this policy');

  return {
    bound: true,
    stoppedAt: null,
    steps,
    receipt: {
      policyId: policyTerms.policyId,
      coverLimitUsd: policyTerms.coverage.limitUsd,
      policyRef: bytesToHex(policyRef),
      bindingCommitment: bytesToHex(bindingCommitment),
      bindingProven,
      totalBindingsOnLedger: chain.publicLedger().bindingCount
    },
    // Returned to the HOLDER only (their private opening). Used by tests.
    holderPrivateState: holder,
    policyDocument
  };
}
