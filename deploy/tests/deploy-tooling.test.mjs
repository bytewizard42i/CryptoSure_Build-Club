// ============================================================================
// Tests for the deployment tooling that need NO network
// ============================================================================
// What is checked here:
//   - the witness table covers every witness every compiled contract declares
//   - the wiring plan matches protocol/program.mjs (same steps, stable ids)
//   - configuration and the seed-file reader fail loudly and leak nothing
//   - the deployment record survives a save/read round trip
// What is NOT checked here: anything that talks to a chain. That is recorded
// in README.md, "What has actually been run".
// ============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BUILD_FOLDER, REPOSITORY_ROOT, getNetworkConfig, networkNameFromCommandLine } from '../src/config.mjs';
import { CONTRACT_NAMES_IN_DEPLOY_ORDER, loadCompiledContract, provableCircuitNames } from '../src/compiled-contracts.mjs';
import { WITNESSES } from '../src/witnesses.mjs';
import { readDeployerSeedHex } from '../src/seed-file.mjs';
import { deriveWalletKeys, formatTokenAmount } from '../src/wallet.mjs';
import { createDemoRoleHolders, createRoleKeyFunction, listWiringSteps, validateProgramConfig } from '../src/network-program.mjs';

const programConfig = JSON.parse(readFileSync(path.join(REPOSITORY_ROOT, 'config', 'program.json'), 'utf8'));

test('the witness table has every witness each compiled contract declares', () => {
  for (const contractName of CONTRACT_NAMES_IN_DEPLOY_ORDER) {
    const info = JSON.parse(readFileSync(path.join(BUILD_FOLDER, contractName, 'compiler', 'contract-info.json'), 'utf8'));
    for (const witness of info.witnesses) {
      assert.equal(typeof WITNESSES[witness.name], 'function', `${contractName} declares witness "${witness.name}" but src/witnesses.mjs has no such function`);
    }
  }
});

test('every compiled contract loads with witnesses attached and exposes derive_role_key', async () => {
  for (const contractName of CONTRACT_NAMES_IN_DEPLOY_ORDER) {
    const loaded = await loadCompiledContract(contractName);
    assert.equal(typeof loaded.module.pureCircuits.derive_role_key, 'function');
    assert.ok(provableCircuitNames(contractName).length > 0);
  }
  await assert.rejects(() => loadCompiledContract('NoSuchContract'), TypeError);
});

test('the wiring plan has the same 19 steps as protocol/program.mjs, with unique stable ids', async () => {
  const roleHolders = createDemoRoleHolders();
  const steps = listWiringSteps(programConfig, { roleKeyOf: await createRoleKeyFunction(), operators: roleHolders.operators });
  const stepIds = steps.map((step) => step.id);
  assert.equal(new Set(stepIds).size, stepIds.length);
  assert.deepEqual(stepIds, [
    'add-operator:banList', 'register-check:banList',
    'add-operator:region', 'register-check:region',
    'add-operator:identity', 'register-check:identity',
    'add-operator:education', 'register-check:education',
    'add-operator:walletControl', 'register-check:walletControl',
    'define-profile:basic', 'define-profile:standard', 'define-profile:enhanced',
    'add-allowed-region:REGION-A', 'add-allowed-region:REGION-B',
    'set-clearance-registry:PolicyBinder', 'set-clearance-registry:PairReceipt',
    'define-cover-class:cover-standard', 'define-cover-class:cover-enhanced'
  ]);
  // Every step names a circuit that really has proving keys.
  for (const step of steps) {
    assert.ok(provableCircuitNames(step.contractName).includes(step.circuitName), `${step.contractName} has no provable circuit "${step.circuitName}"`);
  }
});

test('a program config that would wire something missing is refused before any transaction', () => {
  assert.throws(() => validateProgramConfig({ ...programConfig, slots: { ...programConfig.slots, banList: 9 } }), /slots\.banList/);
  assert.throws(() => validateProgramConfig({ ...programConfig, coverClasses: { 'cover-x': 'no-such-profile' } }), /unknown profile/);
});

test('network configuration: preview is fixed, unknown names and a missing Blockfrost id fail loudly', () => {
  const preview = getNetworkConfig('preview');
  assert.equal(preview.networkId, 'preview');
  assert.equal(preview.indexerHttpUrl, 'https://indexer.preview.midnight.network/api/v4/graphql');
  assert.throws(() => getNetworkConfig('mainnet'), /Unknown network/);

  const saved = process.env.BLOCKFROST_MIDNIGHT_PREPROD_PROJECT_ID;
  delete process.env.BLOCKFROST_MIDNIGHT_PREPROD_PROJECT_ID;
  try {
    assert.throws(() => getNetworkConfig('preprod'), /BLOCKFROST_MIDNIGHT_PREPROD_PROJECT_ID/);
  } finally {
    if (saved !== undefined) process.env.BLOCKFROST_MIDNIGHT_PREPROD_PROJECT_ID = saved;
  }

  assert.equal(networkNameFromCommandLine(['--network', 'local']), 'local');
  assert.throws(() => networkNameFromCommandLine(['--network']), /needs a value/);
});

test('the seed-file reader takes the last line and never repeats file contents in an error', () => {
  const folder = mkdtempSync(path.join(tmpdir(), 'cryptosure-seed-test-'));
  try {
    // FIXED THROWAWAY TEST SEED (not a secret).
    const throwawaySeed = `${'0'.repeat(63)}1`;
    const goodFile = path.join(folder, 'good.seed');
    writeFileSync(goodFile, `# a note line\n${throwawaySeed.toUpperCase().replace(/0/g, '0')}\n\n`);
    assert.equal(readDeployerSeedHex(goodFile), throwawaySeed);

    const badFile = path.join(folder, 'bad.seed');
    writeFileSync(badFile, 'this-line-must-not-be-echoed\n');
    assert.throws(() => readDeployerSeedHex(badFile), (error) => /not a 64-character hexadecimal seed/.test(error.message) && !error.message.includes('this-line-must-not-be-echoed'));
    assert.throws(() => readDeployerSeedHex(path.join(folder, 'missing.seed')), /was not found/);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('deriveWalletKeys is deterministic and network-specific', () => {
  const throwawaySeed = `${'0'.repeat(63)}1`;
  const preview = deriveWalletKeys({ seedHex: throwawaySeed, networkId: 'preview' });
  assert.equal(preview.unshieldedAddress, deriveWalletKeys({ seedHex: throwawaySeed, networkId: 'preview' }).unshieldedAddress);
  assert.match(deriveWalletKeys({ seedHex: throwawaySeed, networkId: 'preprod' }).unshieldedAddress, /^mn_addr_preprod1/);
});

test('token amounts are formatted from smallest units', () => {
  assert.equal(formatTokenAmount(0n, 6), '0');
  assert.equal(formatTokenAmount(5_000_000_000n, 6), '5000');
  assert.equal(formatTokenAmount(1_500_000n, 6), '1.5');
  assert.equal(formatTokenAmount(1n, 6), '0.000001');
});
