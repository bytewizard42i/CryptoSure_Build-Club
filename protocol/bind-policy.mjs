// ============================================================================
// bind-policy.mjs — bind an insurance policy to a cleared wallet
// ============================================================================
// THE FLOW
//   1. ACKNOWLEDGE  the holder signs, with the insured wallet, a statement
//                   naming the cover class, the wallet and a fingerprint of
//                   the exact terms.
//   2. BIND         PolicyBinder looks up which clearance profile the cover
//                   class requires, asks the ClearanceRegistry whether this
//                   ticket holds it, and if so records the binding.
//   3. PROVE        the holder proves the binding exists (as they would
//                   when making a claim).
//
// WHAT IS PRIVATE
//   The policy document: its terms and the signed acknowledgment. It never
//   leaves the holder and the insurer. The contract receives only
//   `policyRef`, a fingerprint of the completed document, and seals even
//   that inside a commitment.
//
// WHAT THE CALLER CANNOT FAKE
//   The required profile is read from the ledger by the contract. A holder
//   cleared for an easy profile cannot bind a class that demands a strict
//   one by passing a friendlier number.
//
// IDEAS, NOT BUILT
//   - the underwriter counter-signing the agreement
//   - premium payment as part of binding
//   - ending a policy and releasing the wallet automatically at expiry
// ============================================================================

import { buildAcknowledgmentStatement } from './acknowledgment.mjs';
import { ContractRejectedError } from './local-chain.mjs';
import { bytesToHex, derivePolicyRef, padTo32Bytes, random32Bytes } from './encoding.mjs';

/**
 * @param {{coverClass: string, policyTerms: object, walletSigner: {sign(text): Promise<string>}|null}} request
 *        walletSigner null means the holder declined to sign.
 * @returns {Promise<{bound: boolean, stoppedAt: string|null, steps: object[], receipt?: object,
 *                    holderRecord?: object}>}
 */
export async function bindPolicy(program, providers, holder, { coverClass, policyTerms, walletSigner }) {
  if (!(coverClass in program.config.coverClasses) || coverClass.startsWith('_')) throw new TypeError(`There is no cover class "${coverClass}".`);
  const steps = [];
  const stop = (step, detail) => {
    steps.push({ step, passed: false, detail });
    return { bound: false, stoppedAt: step, steps };
  };

  // ---- 1. Acknowledge -------------------------------------------------------
  if (walletSigner === null) return stop('acknowledge-agreement', 'The holder did not sign the acknowledgment');
  const statement = buildAcknowledgmentStatement({ coverClass, policyTerms, wallet: holder.wallet });
  const walletSignature = await walletSigner.sign(statement);
  // Checked against the statement WE built, never text the holder supplied.
  if (!(await providers.walletControl.verifyMessage({ wallet: holder.wallet, messageText: statement, signatureHex: walletSignature }))) {
    return stop('acknowledge-agreement', 'The acknowledgment was not signed by the insured wallet');
  }
  steps.push({ step: 'acknowledge-agreement', passed: true, detail: 'The insured wallet signed "I understand this agreement"' });

  // ---- 2. Bind --------------------------------------------------------------
  const policyDocument = { coverClass, terms: policyTerms, acknowledgment: { statement, walletSignature } };
  const policyRef = derivePolicyRef(policyDocument);
  const bindingState = { ...holder.privateState, bindingSalt: random32Bytes() };
  const binder = program.addresses.PolicyBinder;

  // The holder's device works out its own binding commitment. The contract
  // computes the same value and stores it, but does not hand it back.
  const bindingCommitment = program.chain.pureCircuits(binder).commit_binding(
    { holderPk: holder.holderPublicKey, walletHash: holder.privateState.walletHash, policyRef, coverClass: padTo32Bytes(coverClass) },
    bindingState.bindingSalt
  );
  try {
    await program.chain.call(binder, bindingState, 'bind_policy', holder.ticket, padTo32Bytes(coverClass), policyRef);
  } catch (error) {
    if (!(error instanceof ContractRejectedError)) throw error;
    return stop('bind-policy', `The contract refused the binding: ${error.message}`);
  }
  steps.push({ step: 'bind-policy', passed: true, detail: `PolicyBinder confirmed the "${program.config.coverClasses[coverClass]}" clearance and recorded the binding` });

  // ---- 3. Prove -------------------------------------------------------------
  const proven = await program.chain.call(binder, bindingState, 'prove_binding', padTo32Bytes(coverClass), policyRef);
  steps.push({ step: 'prove-binding', passed: true, detail: 'The holder proved this wallet is bound to this policy' });

  return {
    bound: true,
    stoppedAt: null,
    steps,
    receipt: {
      coverClass,
      policyRef: bytesToHex(policyRef),
      bindingCommitment: bytesToHex(bindingCommitment),
      bindingProven: proven.result,
      totalBindingsOnLedger: Number(program.chain.publicLedger(binder).bindingCount)
    },
    // Kept by the HOLDER (and the insurer). Never on-chain.
    holderRecord: { policyDocument, policyRef, bindingState, bindingCommitment }
  };
}
