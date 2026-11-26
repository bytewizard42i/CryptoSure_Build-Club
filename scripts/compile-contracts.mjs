// ============================================================================
// compile-contracts.mjs — compile every CryptoSure contract, one after another
// ============================================================================
// WHAT IT DOES
//   Runs the Compact compiler on each contract listed below and writes the
//   result to build/<ContractName>/ :
//       contract/   the JavaScript the tests and demo run
//       keys/       prover and verifier keys (only in a full compile)
//       zkir/       the circuits in the compiler's intermediate form
//
// TWO SPEEDS
//   npm run compile        full: generates the zero-knowledge keys. Slow, and
//                          REQUIRED before running the tests or the demo,
//                          because one contract can only call another if the
//                          callee carries a verifier key.
//   npm run compile:fast   passes --skip-zk: checks the code compiles and
//                          regenerates the JavaScript, in seconds. Use it
//                          while editing. Not enough to run cross-contract
//                          calls.
//
// WHICH COMPILER
//   Whatever `compact compile --version` reports. It must match Midnight's
//   support matrix: https://docs.midnight.network/relnotes/support-matrix
// ============================================================================

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// name -> source file. The name is also the build folder and the name the
// JavaScript code uses to find the compiled module.
export const CONTRACT_SOURCES = {
  BanListCheck: 'contracts/checks/BanListCheck.compact',
  RegionCheck: 'contracts/checks/RegionCheck.compact',
  IdentityCheck: 'contracts/checks/IdentityCheck.compact',
  EducationCheck: 'contracts/checks/EducationCheck.compact',
  WalletControlCheck: 'contracts/checks/WalletControlCheck.compact',
  ClearanceRegistry: 'contracts/ClearanceRegistry.compact',
  PairReceipt: 'contracts/PairReceipt.compact',
  PolicyBinder: 'contracts/PolicyBinder.compact'
};

function compileOne(contractName, sourceFile, skipZeroKnowledgeKeys) {
  const compilerArguments = ['compile', ...(skipZeroKnowledgeKeys ? ['--skip-zk'] : []), sourceFile, `build/${contractName}`];
  console.log(`\n=== ${contractName}  (compact ${compilerArguments.join(' ')})`);
  const result = spawnSync('compact', compilerArguments, { cwd: REPOSITORY_ROOT, stdio: 'inherit' });
  if (result.error) {
    throw new Error(`Could not run the Compact compiler. Is "compact" installed and on your PATH? (${result.error.message})`);
  }
  if (result.status !== 0) {
    throw new Error(`${contractName} did not compile. Fix the error printed above and run this again.`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const skipZeroKnowledgeKeys = process.argv.includes('--skip-zk');
  const startedAt = Date.now();
  for (const [contractName, sourceFile] of Object.entries(CONTRACT_SOURCES)) {
    compileOne(contractName, sourceFile, skipZeroKnowledgeKeys);
  }
  const seconds = Math.round((Date.now() - startedAt) / 1000);
  console.log(`\nCompiled ${Object.keys(CONTRACT_SOURCES).length} contracts in ${seconds}s${skipZeroKnowledgeKeys ? ' (no keys: fast mode)' : ' with keys'}.`);
}
