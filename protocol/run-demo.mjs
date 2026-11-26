// ============================================================================
// run-demo.mjs — the whole protocol, start to finish, in your terminal
// ============================================================================
//   npm run compile     (once, about a minute: builds the contracts with keys)
//   npm run demo
//
// It deploys the eight contracts on a local stand-in for a chain, then:
//   PART 1  clears a cast of wallets, showing where each one stops
//   PART 2  checks pairs of wallets (sender and receiver) and advises
//   PART 3  binds a policy to cleared wallets
//   PART 4  lets a day pass and shows a clearance expire and renew
//
// The people are fictional residents of TestTown, a public test population.
// Whether each one passes is decided by the MOCK providers' fixture.
// Nothing here touches a network and no proofs are generated.
// ============================================================================

import { readFileSync } from 'node:fs';
import { deployProgram } from './program.mjs';
import { createMockProviders } from './providers/mock-providers.mjs';
import { clearWallet, createHolder } from './clearance.mjs';
import { ClearanceDirectory, checkPair } from './pair-check.mjs';
import { bindPolicy } from './bind-policy.mjs';
import { createDemoWalletSigner } from './wallet-signatures.mjs';
import { ContractsNotCompiledError } from './local-chain.mjs';

const readJson = (relativePath) => JSON.parse(readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8'));
const shortAddress = (wallet) => `${wallet.address.slice(0, 20)}…${wallet.address.slice(-6)}`;
const asDate = (unixSeconds) => new Date(unixSeconds * 1000).toISOString().replace('.000Z', 'Z');
const heading = (text) => console.log(`\n${'='.repeat(78)}\n${text}\n${'='.repeat(78)}`);

// Who tries for what. The profile names come from config/program.json.
const CLEARANCE_CAST = [
  ['mei-lin-zhao', 'enhanced'], ['theo-brandt', 'enhanced'], ['bonnie-lachance', 'standard'], ['fern-whitaker', 'enhanced'],
  ['anya-petrova', 'basic'], ['marcus-reid', 'enhanced'], ['harold-quist', 'standard'], ['amos-fairweather', 'standard'],
  ['priscilla-vance', 'standard'], ['edgar-morrow', 'basic'], ['colin-mcbride', 'basic'], ['diego-marchetti', 'basic']
];
const PAIRS = [['mei-lin-zhao', 'theo-brandt'], ['mei-lin-zhao', 'raj-patel'], ['mei-lin-zhao', 'colin-mcbride']];
const BINDINGS = [['mei-lin-zhao', 'cover-enhanced'], ['bonnie-lachance', 'cover-standard'], ['bonnie-lachance', 'cover-enhanced'], ['fern-whitaker', 'cover-enhanced']];
const DEMO_POLICY_TERMS = { note: 'Placeholder terms for the demo. Not an offer of insurance.' };

async function main() {
  const config = readJson('config/program.json');
  const fixture = readJson('fixtures/mock-subjects.json');
  const subjects = Object.fromEntries(fixture.subjects.map((subject) => [subject.id, subject]));
  const providers = createMockProviders(fixture);
  const directory = new ClearanceDirectory();

  heading('SET-UP: deploying eight separate contracts and wiring them together');
  const program = await deployProgram(config);
  for (const [name, address] of Object.entries(program.addresses)) console.log(`  ${name.padEnd(20)} at ${address.slice(0, 16)}…`);
  console.log(`\n  Profiles: ${Object.keys(config.profiles).filter((name) => !name.startsWith('_')).join(', ')}   (MOCK providers, local chain, no proofs)`);

  // People keep their holder record (ticket and private inputs) between parts.
  const people = {};
  const person = (subjectId) => {
    const subject = subjects[subjectId];
    people[subjectId] ??= {
      subject,
      holder: createHolder(program, { subjectId, wallet: subject.wallet }),
      walletSigner: createDemoWalletSigner(subject.wallet, { signWithSomeoneElsesKey: Boolean(subject.signWithSomeoneElsesKey) })
    };
    return people[subjectId];
  };

  heading('PART 1: clearing wallets  (stops at the first check that does not pass)');
  for (const [subjectId, profile] of CLEARANCE_CAST) {
    const { holder, walletSigner, subject } = person(subjectId);
    const result = await clearWallet(program, providers, holder, profile, { walletSigner });
    directory.record(holder, result, program.chain.now);
    const trail = result.steps.map((step) => `${step.passed ? '✓' : '✗'} ${step.check}`).join('  ');
    console.log(`\n  ${subjectId.padEnd(17)} ${shortAddress(subject.wallet)}   wants "${profile}"`);
    console.log(`    ${trail}`);
    console.log(`    → ${result.status.toUpperCase()}${result.validUntil ? ` until ${asDate(result.validUntil)}` : ''}${result.stoppedAt ? `   (${result.steps.at(-1).detail})` : ''}`);
  }

  heading('PART 2: pair checks  (advice only; nothing is held or blocked)');
  for (const [senderId, receiverId] of PAIRS) {
    const outcome = await checkPair(program, providers, directory, { sender: subjects[senderId].wallet, receiver: subjects[receiverId].wallet });
    console.log(`\n  ${senderId} → ${receiverId}`);
    console.log(`    sender ${outcome.sender.status}, receiver ${outcome.receiver.status}   → advice: ${outcome.advice.toUpperCase()}`);
    if (outcome.receiptId) console.log(`    receipt ${outcome.receiptId.slice(0, 24)}… recorded on-chain, good until ${asDate(outcome.receiptValidUntil)}`);
  }

  heading('PART 3: binding a policy to a cleared wallet');
  for (const [subjectId, coverClass] of BINDINGS) {
    const { holder, walletSigner, subject } = person(subjectId);
    const outcome = await bindPolicy(program, providers, holder, { coverClass, policyTerms: DEMO_POLICY_TERMS, walletSigner: subject.declinesToAcknowledge ? null : walletSigner });
    console.log(`\n  ${subjectId.padEnd(17)} asks for "${coverClass}" (needs the "${config.coverClasses[coverClass]}" clearance)`);
    console.log(`    → ${outcome.bound ? `BOUND. policy reference ${outcome.receipt.policyRef.slice(0, 24)}…, bindings on ledger: ${outcome.receipt.totalBindingsOnLedger}` : `NOT BOUND at ${outcome.stoppedAt}: ${outcome.steps.at(-1).detail}`}`);
  }

  heading('PART 4: a day passes');
  program.chain.advanceTime(86_400 + 60);
  const mei = person('mei-lin-zhao');
  const stale = await checkPair(program, providers, directory, { sender: mei.subject.wallet, receiver: subjects['theo-brandt'].wallet });
  console.log(`\n  mei-lin-zhao → theo-brandt, one day later: sender ${stale.sender.status}, receiver ${stale.receiver.status} → ${stale.advice.toUpperCase()}`);
  const renewed = await clearWallet(program, providers, mei.holder, 'enhanced', { walletSigner: mei.walletSigner });
  console.log(`  mei-lin-zhao renews: asked again → ${renewed.steps.filter((step) => step.reused === false).map((step) => step.check).join(', ')};  reused → ${renewed.steps.filter((step) => step.reused).map((step) => step.check).join(', ')}`);
  console.log(`    → ${renewed.status.toUpperCase()} until ${asDate(renewed.validUntil)}`);

  heading('WHAT AN OBSERVER OF THE CHAIN SAW');
  const registry = program.chain.publicLedger(program.addresses.ClearanceRegistry);
  console.log(`  clearances granted: ${registry.clearanceCount}   receipts: ${program.chain.publicLedger(program.addresses.PairReceipt).receiptCount}   policies bound: ${program.chain.publicLedger(program.addresses.PolicyBinder).bindingCount}`);
  console.log('  Tickets, passes, profile names and expiry times. No names, no addresses, no reasons, no policy text.\n');
}

main().catch((error) => {
  if (error instanceof ContractsNotCompiledError) {
    console.error(`\n${error.message}\n`);
    process.exit(1);
  }
  throw error;
});
