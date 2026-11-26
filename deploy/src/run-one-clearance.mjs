// ============================================================================
// run-one-clearance.mjs — clear one holder on a deployed program, for real
// ============================================================================
// WHAT IT DOES (against a program already deployed by deploy-program.mjs)
//   1. "basic" profile for one holder: ban list + wallet control.
//        per check:  operator RECORDS the provider's answer   (1 transaction)
//                    holder PROVES it and collects a pass     (1 transaction)
//        then:       grant_clearance on ClearanceRegistry     (1 transaction)
//      grant_clearance is the CROSS-CONTRACT call: inside that one
//      transaction the registry calls require_pass on each check contract,
//      and the transaction carries one proof per contract touched.
//   2. With --standard: the "standard" profile too (adds region, identity,
//      education; the two passes from step 1 are reused, not repeated).
//   3. With --bind-policy (implies --standard): bind_policy and prove_binding
//      on PolicyBinder, which calls the registry, another cross-contract call.
//
// THE PROTOCOL CODE IS NOT REWRITTEN HERE
//   protocol/clearance.mjs clearWallet() and protocol/bind-policy.mjs
//   bindPolicy() run unchanged. They were written against the local
//   stand-in; network-chain.mjs offers the same operations over a network.
//
// WHAT IS STILL MOCK
//   The OFF-CHAIN answers: protocol/providers/mock-providers.mjs looks them
//   up in fixtures/mock-subjects.json. The wallet-control signature is made
//   with the demo stand-in key (protocol/wallet-signatures.mjs). The
//   contracts, proofs and transactions are real.
//
// RUN
//   npm run clearance                              basic, on Preview
//   npm run clearance -- --standard --bind-policy  everything
//   npm run clearance -- --subject mei-lin-zhao    another fixture person
//   npm run clearance -- --network local           on the rehearsal chain
//
// IDEAS, NOT BUILT
//   IDEA: use src/midnight-wallet-signer.mjs for the wallet-control signature
//         once the wallet-control provider verifies real Midnight signatures.
//   IDEA: save the holder's private record (salts, evidence) so a later run
//         can reuse the same ticket instead of making a new one each time.
// ============================================================================

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { REPOSITORY_ROOT } from './config.mjs';
import { readDeploymentRecord } from './deployment-record.mjs';
import { loadDeployedProgram } from './network-program.mjs';
import { openNetworkSession, runAsScript } from './session.mjs';
import { clearWallet, createHolder } from '../../protocol/clearance.mjs';
import { bindPolicy } from '../../protocol/bind-policy.mjs';
import { createMockProviders } from '../../protocol/providers/mock-providers.mjs';
import { createDemoWalletSigner } from '../../protocol/wallet-signatures.mjs';

const DEMO_POLICY_TERMS = { note: 'Placeholder terms for the demo. Not an offer of insurance.' };
const COVER_CLASS_TO_BIND = 'cover-standard';

const readJson = (relativePath) => JSON.parse(readFileSync(path.join(REPOSITORY_ROOT, relativePath), 'utf8'));
const asDate = (unixSeconds) => new Date(unixSeconds * 1000).toISOString().replace('.000Z', 'Z');

// The value after a flag such as `--subject mei-lin-zhao`, or a default.
function commandLineValue(flagName, defaultValue) {
  const position = process.argv.indexOf(flagName);
  if (position === -1) return defaultValue;
  const value = process.argv[position + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${flagName} needs a value.`);
  return value;
}

function printTransaction(entry) {
  const what = entry.kind === 'deploy' ? `deploy ${entry.contract}` : `${entry.contract}.${entry.circuit}`;
  console.log(`    tx ${entry.transactionId}  block ${entry.blockHeight}  ${what}`);
}

function printClearanceOutcome(outcome) {
  for (const step of outcome.steps) console.log(`    ${step.passed ? 'ok ' : 'NO '} ${step.check}: ${step.detail}`);
  const ending = outcome.validUntil === null ? '' : `, valid until ${asDate(outcome.validUntil)}`;
  console.log(`  RESULT for profile "${outcome.profile}": ${outcome.status.toUpperCase()}${ending}  (ticket ${outcome.ticketHex})`);
}

async function clearForProfile({ program, providers, holder, walletSigner, profileName }) {
  console.log(`\nClearing ${holder.subjectId} for the "${profileName}" profile:`);
  const outcome = await clearWallet(program, providers, holder, profileName, { walletSigner });
  printClearanceOutcome(outcome);
  return outcome;
}

async function main() {
  const alsoBindPolicy = process.argv.includes('--bind-policy');
  const alsoStandard = process.argv.includes('--standard') || alsoBindPolicy;
  const subjectId = commandLineValue('--subject', 'bonnie-lachance');

  const fixture = readJson('fixtures/mock-subjects.json');
  const subject = fixture.subjects.find((candidate) => candidate.id === subjectId);
  if (subject === undefined) {
    throw new Error(`There is no subject "${subjectId}" in fixtures/mock-subjects.json. Known: ${fixture.subjects.map((candidate) => candidate.id).join(', ')}.`);
  }
  const providers = createMockProviders(fixture);

  const session = await openNetworkSession({ onTransaction: printTransaction });
  try {
    const record = readDeploymentRecord(session.network.name);
    if (record === null) throw new Error(`Nothing is deployed on "${session.network.name}" yet. Next step: npm run deploy`);
    const program = await loadDeployedProgram({ chain: session.chain, record, programConfig: readJson('config/program.json') });
    console.log(`Program found on ${session.network.name}: ClearanceRegistry at ${program.addresses.ClearanceRegistry}`);

    const holder = createHolder(program, { subjectId: subject.id, wallet: subject.wallet });
    const walletSigner = createDemoWalletSigner(subject.wallet, { signWithSomeoneElsesKey: Boolean(subject.signWithSomeoneElsesKey) });

    const basic = await clearForProfile({ program, providers, holder, walletSigner, profileName: 'basic' });
    if (basic.status !== 'clear') {
      process.exitCode = 1;
      return;
    }

    if (alsoStandard) {
      const standard = await clearForProfile({ program, providers, holder, walletSigner, profileName: 'standard' });
      if (standard.status !== 'clear') {
        process.exitCode = 1;
        return;
      }
    }

    if (alsoBindPolicy) {
      console.log(`\nBinding a "${COVER_CLASS_TO_BIND}" policy to ${holder.subjectId}:`);
      const binding = await bindPolicy(program, providers, holder, { coverClass: COVER_CLASS_TO_BIND, policyTerms: DEMO_POLICY_TERMS, walletSigner });
      for (const step of binding.steps) console.log(`    ${step.passed ? 'ok ' : 'NO '} ${step.step}: ${step.detail}`);
      console.log(`  RESULT: ${binding.bound ? `BOUND (policy reference ${binding.receipt.policyRef}, bindings on ledger: ${binding.receipt.totalBindingsOnLedger})` : `NOT BOUND, stopped at ${binding.stoppedAt}`}`);
      if (!binding.bound) process.exitCode = 1;
    }

    console.log(`\n${session.chain.transcript.length} transaction(s) sent and confirmed by the indexer.`);
  } finally {
    await session.close();
  }
}

runAsScript(main);
