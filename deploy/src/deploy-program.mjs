// ============================================================================
// deploy-program.mjs — deploy and wire one CryptoSure program on a network
// ============================================================================
// WHAT IT DOES
//   1. Deploys the eight contracts, in the order of protocol/program.mjs.
//   2. Sends the wiring transactions (operators, slots, profiles, regions,
//      registry references, cover classes).
//   3. After EVERY confirmed step, saves deployments/<network>.json.
//
// RESUMABLE
//   Run it again after any failure: contracts and wiring steps already in
//   the record are skipped. Nothing is ever deployed twice.
//
// "CONFIRMED" MEANS
//   Midnight.js returns from a deploy or a call only after the INDEXER has
//   reported the transaction in a block, with a status. A step is written to
//   the record only then, and only if the status is "SucceedEntirely".
//   Contract addresses are additionally re-read from the indexer.
//
// RUN
//   npm run deploy                         all of it, on Preview
//   npm run deploy -- --only-first         just the first contract (BanListCheck),
//                                          to confirm the pipeline before the rest
//   npm run deploy -- --network local      on the local rehearsal chain
//
// NEEDS
//   - build/ compiled with keys (npm run compile in the repository root)
//   - the proof server running (docker start cryptosure-proof-server)
//   - a deployer wallet with NIGHT (and it will register for DUST if needed)
//
// IDEAS, NOT BUILT
//   IDEA: `--dry-run` that lists the steps that WOULD be sent.
//   IDEA: swap one check for a new version (deploy, then register_check).
// ============================================================================

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { REPOSITORY_ROOT, compilerVersionsOfBuild, installedSdkVersions } from './config.mjs';
import { CONTRACT_NAMES_IN_DEPLOY_ORDER } from './compiled-contracts.mjs';
import { createDeploymentRecord, deploymentRecordPath, readDeploymentRecord, saveDeploymentRecord } from './deployment-record.mjs';
import { addressesFromRecord, createDemoRoleHolders, createRoleKeyFunction, listWiringSteps, validateProgramConfig } from './network-program.mjs';
import { openNetworkSession, runAsScript } from './session.mjs';
import { readProofServerHealth } from './check-status.mjs';

function readProgramConfig() {
  const configPath = process.env.CRYPTOSURE_PROGRAM_CONFIG || path.join(REPOSITORY_ROOT, 'config', 'program.json');
  const programConfig = JSON.parse(readFileSync(configPath, 'utf8'));
  validateProgramConfig(programConfig);
  return programConfig;
}

async function deployMissingContracts({ chain, record, adminRoleKey, contractNames }) {
  for (const contractName of contractNames) {
    const existing = record.contracts[contractName];
    if (existing !== undefined) {
      console.log(`  skip    ${contractName.padEnd(20)} already deployed at ${existing.address}`);
      await chain.attach(contractName, existing.address);
      continue;
    }
    console.log(`  deploy  ${contractName.padEnd(20)} proving and submitting...`);
    const deployed = await chain.deploy(contractName, adminRoleKey);
    record.contracts[contractName] = {
      address: deployed.address,
      deployTransactionId: deployed.transactionId,
      blockHeight: deployed.blockHeight,
      deployedAt: new Date().toISOString()
    };
    saveDeploymentRecord(record);
    console.log(`  done    ${contractName.padEnd(20)} address ${deployed.address}  tx ${deployed.transactionId}  block ${deployed.blockHeight}`);
  }
}

async function sendMissingWiringSteps({ chain, record, steps, admin }) {
  const addresses = addressesFromRecord(record);
  for (const step of steps) {
    const existing = record.wiringSteps[step.id];
    if (existing !== undefined) {
      console.log(`  skip    ${step.id.padEnd(44)} already done (tx ${existing.transactionId})`);
      continue;
    }
    console.log(`  send    ${step.id.padEnd(44)} ${step.contractName}.${step.circuitName} ...`);
    const outcome = await chain.call(addresses[step.contractName], admin, step.circuitName, ...step.buildArguments(addresses));
    record.wiringSteps[step.id] = {
      contract: step.contractName,
      circuit: step.circuitName,
      transactionId: outcome.transactionId,
      blockHeight: outcome.blockHeight,
      completedAt: new Date().toISOString()
    };
    saveDeploymentRecord(record);
    console.log(`  done    ${step.id.padEnd(44)} tx ${outcome.transactionId}  block ${outcome.blockHeight}`);
  }
}

async function main() {
  const onlyFirstContract = process.argv.includes('--only-first');
  const programConfig = readProgramConfig();
  const session = await openNetworkSession();
  try {
    const { network, wallet, chain } = session;

    const record = readDeploymentRecord(network.name) ?? createDeploymentRecord({
      networkName: network.name,
      deployerAddress: wallet.unshieldedAddress,
      versions: {
        ...compilerVersionsOfBuild(),
        proofServer: (await readProofServerHealth()).version,
        packages: installedSdkVersions()
      }
    });
    if (record.deployerAddress !== wallet.unshieldedAddress) {
      throw new Error(
        `${deploymentRecordPath(network.name)} was made by a different deployer (${record.deployerAddress}).\n` +
        'Next step: use the same seed file as before, or move the old record aside deliberately.'
      );
    }

    const roleHolders = createDemoRoleHolders();
    const roleKeyOf = await createRoleKeyFunction();

    console.log(`\nContracts${onlyFirstContract ? ' (--only-first: just the first one)' : ''}:`);
    await deployMissingContracts({
      chain,
      record,
      adminRoleKey: roleKeyOf(roleHolders.admin),
      contractNames: onlyFirstContract ? CONTRACT_NAMES_IN_DEPLOY_ORDER.slice(0, 1) : CONTRACT_NAMES_IN_DEPLOY_ORDER
    });
    if (onlyFirstContract) {
      console.log('\nStopped after the first contract, as asked. Run "npm run deploy" for the rest.');
      return;
    }

    console.log('\nWiring:');
    await sendMissingWiringSteps({
      chain,
      record,
      steps: listWiringSteps(programConfig, { roleKeyOf, operators: roleHolders.operators }),
      admin: roleHolders.admin
    });

    console.log(`\nThe program is deployed and wired on ${network.name}.`);
    console.log(`Record: ${deploymentRecordPath(network.name)}`);
  } finally {
    await session.close();
  }
}

runAsScript(main);
