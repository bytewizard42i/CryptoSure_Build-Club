// ============================================================================
// Demo: run every synthetic persona through the binding flow.
// ============================================================================
// Run:  npm run demo
//
// Starts the KYCz and GeoZ test-wired oracles from their own repos (unless
// KYCZ_ORACLE_URL / GEOZ_ORACLE_URL already point at running ones), deploys
// WalletBinder locally, then walks each persona through the seven steps and
// prints where each one ended.
// ============================================================================

import { readFileSync } from 'node:fs';
import { bindPolicyToWallet, createInsuranceProgram } from './bind-policy.mjs';
import { startOracles } from '../scripts/oracle-processes.mjs';

const readJson = (relativePath) => JSON.parse(readFileSync(new URL(relativePath, import.meta.url), 'utf8'));
const policyCatalog = readJson('../policies/policy-catalog.json');
const { personas } = readJson('./personas.json');

const oraclesAlreadyRunning = process.env.KYCZ_ORACLE_URL && process.env.GEOZ_ORACLE_URL;
const stopOracles = oraclesAlreadyRunning ? () => {} : await startOracles({ quiet: true });

try {
  const program = await createInsuranceProgram(policyCatalog);
  console.log(`\n${policyCatalog.sharedTerms.program}`);
  console.log('Policies on offer (each with its own prerequisites):');
  for (const policy of policyCatalog.policies) {
    const limit = `$${policy.coverage.limitUsd.toLocaleString('en-US')}`.padStart(7);
    console.log(`    ${policy.policyId.padEnd(16)} ${limit}   KYC level >= ${policy.eligibility.minKycLevel}   ` +
      `${policy.education.requiredModules.length} edu modules, pass mark ${policy.education.passMarkPercent}%`);
  }
  console.log('Oracles: KYCz + GeoZ are external black boxes, TEST-WIRED (synthetic answers).');
  console.log('Chain:   WalletBinder running locally (contract logic is real; no network, no proofs generated).\n');

  for (const persona of personas) {
    const result = await bindPolicyToWallet(program, persona);
    console.log(`${result.bound ? 'BOUND   ' : 'DECLINED'}  ${persona.id}  applied for ${persona.appliesFor}  (${persona.wallet.chain} wallet)`);
    for (const step of result.steps) {
      console.log(`    ${step.passed ? 'ok  ' : 'STOP'}  ${step.step.padEnd(22)} ${step.detail}`);
    }
    if (result.bound) {
      console.log(`    receipt: $${result.receipt.coverLimitUsd.toLocaleString('en-US')} cover  policyRef ${result.receipt.policyRef.slice(0, 16)}…  binding ${result.receipt.bindingCommitment.slice(0, 16)}…`);
    }
    console.log('');
  }

  const publicLedger = program.chain.publicLedger();
  console.log('What the public ledger shows after all of that:');
  console.log(`    credentials issued: ${publicLedger.credentialCount}   clearances recorded: ${publicLedger.clearanceCount}   wallets bound: ${publicLedger.bindingCount}`);
  console.log('    (counts and hidden commitments only: no identity, no address, no region, no policy text)\n');
} finally {
  stopOracles();
}
