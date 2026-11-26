// ============================================================================
// compiled-contracts.mjs — load the compiled contracts for use with Midnight.js
// ============================================================================
// WHAT THIS DOES
//   For a contract name such as "BanListCheck" it returns:
//     module            the JavaScript the Compact compiler produced
//                       (Contract class, ledger(), pureCircuits)
//     compiledContract  that module wrapped the way Midnight.js 5 wants it:
//                       with our witnesses attached and told where the
//                       proving keys are
//     assetsFolder      build/<Name>, holding keys/, zkir/ and compiler/
//
// WHY THE COMPILED JAVASCRIPT IS COPIED INTO deploy/ BEFORE LOADING
//   build/<Name>/contract/index.js starts with
//       import ... from '@midnight-ntwrk/compact-runtime'
//   Node resolves that from the file's own location, i.e. the REPOSITORY
//   ROOT's node_modules. Midnight.js, installed in deploy/node_modules, uses
//   deploy's copy of the same package. Two copies mean two separate
//   WebAssembly instances, and an object made by one is rejected by the
//   other. Copying the (small) generated file into deploy/.compiled-contracts
//   makes it resolve the SAME runtime Midnight.js uses. The copy is refreshed
//   whenever the original changes, and is git-ignored.
//   The big files (proving keys, zkir) are NOT copied; they are read in place.
//
// REFERENCES
//   @midnight-ntwrk/compact-js  dist/dts/effect/CompiledContract.d.ts
//     (make, withWitnesses, withCompiledFileAssets)
//
// IDEAS, NOT BUILT
//   IDEA: make the root package a workspace so there is one node_modules and
//         no copy is needed.
// ============================================================================

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import { BUILD_FOLDER, COMPILED_CONTRACT_COPIES_FOLDER } from './config.mjs';
import { WITNESSES } from './witnesses.mjs';

// The eight contracts, in the order protocol/program.mjs deploys them:
// the five checks, then the registry, then the two consumers of clearance.
export const CONTRACT_NAMES_IN_DEPLOY_ORDER = [
  'BanListCheck',
  'RegionCheck',
  'IdentityCheck',
  'EducationCheck',
  'WalletControlCheck',
  'ClearanceRegistry',
  'PairReceipt',
  'PolicyBinder'
];

const loadedContracts = new Map();

function assertContractIsCompiledWithKeys(contractName) {
  const assetsFolder = path.join(BUILD_FOLDER, contractName);
  const required = [path.join(assetsFolder, 'contract', 'index.js'), path.join(assetsFolder, 'keys'), path.join(assetsFolder, 'zkir')];
  const missing = required.filter((requiredPath) => !existsSync(requiredPath));
  if (missing.length > 0) {
    throw new Error(
      `The contract "${contractName}" has not been compiled with proving keys (missing: ${missing.join(', ')}).\n` +
      'Next step: in the repository root run "npm run compile" (about a minute), then try again.'
    );
  }
  return assetsFolder;
}

// Copy build/<Name>/contract/index.js into deploy/.compiled-contracts/<Name>/contract/
// unless an identical copy is already there. Returns the copy's path.
function refreshLocalCopyOfContractModule(contractName, assetsFolder) {
  const originalPath = path.join(assetsFolder, 'contract', 'index.js');
  const copyFolder = path.join(COMPILED_CONTRACT_COPIES_FOLDER, contractName, 'contract');
  const copyPath = path.join(copyFolder, 'index.js');
  const upToDate = existsSync(copyPath) && readFileSync(copyPath).equals(readFileSync(originalPath));
  if (!upToDate) {
    mkdirSync(copyFolder, { recursive: true });
    copyFileSync(originalPath, copyPath);
  }
  return copyPath;
}

/**
 * Load one compiled contract (cached after the first call).
 * @param {string} contractName  one of CONTRACT_NAMES_IN_DEPLOY_ORDER
 */
export async function loadCompiledContract(contractName) {
  if (!CONTRACT_NAMES_IN_DEPLOY_ORDER.includes(contractName)) {
    throw new TypeError(`"${contractName}" is not a CryptoSure contract. Known: ${CONTRACT_NAMES_IN_DEPLOY_ORDER.join(', ')}.`);
  }
  if (loadedContracts.has(contractName)) return loadedContracts.get(contractName);

  const assetsFolder = assertContractIsCompiledWithKeys(contractName);
  const module = await import(pathToFileURL(refreshLocalCopyOfContractModule(contractName, assetsFolder)).href);

  // Midnight.js 5 takes a "CompiledContract": the class, plus witnesses, plus
  // where its keys and zkir live.
  const compiledContract = CompiledContract.make(contractName, module.Contract).pipe(
    CompiledContract.withWitnesses(WITNESSES),
    CompiledContract.withCompiledFileAssets(assetsFolder)
  );

  const loaded = { name: contractName, module, compiledContract, assetsFolder };
  loadedContracts.set(contractName, loaded);
  return loaded;
}

/** The names of the circuits a contract has proving keys for (from build/<Name>/keys). */
export function provableCircuitNames(contractName) {
  const keysFolder = path.join(assertContractIsCompiledWithKeys(contractName), 'keys');
  return readdirSync(keysFolder).filter((fileName) => fileName.endsWith('.prover')).map((fileName) => fileName.replace(/\.prover$/, ''));
}
