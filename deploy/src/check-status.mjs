// ============================================================================
// check-status.mjs — "where are we?" in one screen
// ============================================================================
// Prints, for one network:
//   - the deployer wallet's address (public)
//   - whether the local proof server answers
//   - the wallet's NIGHT and DUST balances (this needs a chain sync)
//   - what deployments/<network>.json says is deployed
//
// RUN
//   npm run status                      (Preview)
//   npm run status -- --offline         (skip the chain sync: address, proof
//                                        server and deployment record only)
//
// It changes nothing: no transaction is sent, no file is written.
// ============================================================================

import { getNetworkConfig, networkNameFromCommandLine, proofServerUrl } from './config.mjs';
import { readSeedHexForNetwork } from './seed-file.mjs';
import { deriveWalletKeys, formatDust, formatNight, openHeadlessWallet } from './wallet.mjs';
import { readDeploymentRecord } from './deployment-record.mjs';

/** Ask the proof server's /health and /version pages. Never throws. */
export async function readProofServerHealth(baseUrl = proofServerUrl()) {
  try {
    const health = await fetch(new URL('/health', baseUrl), { signal: AbortSignal.timeout(5000) });
    const version = await fetch(new URL('/version', baseUrl), { signal: AbortSignal.timeout(5000) });
    return { reachable: health.ok, healthText: (await health.text()).trim(), version: (await version.text()).trim() };
  } catch (error) {
    return { reachable: false, healthText: `not reachable (${error.cause?.code ?? error.message})`, version: null };
  }
}

function printDeploymentRecord(networkName) {
  const record = readDeploymentRecord(networkName);
  if (record === null) {
    console.log(`  Nothing recorded: deployments/${networkName}.json does not exist yet.`);
    return;
  }
  console.log(`  Record last updated ${record.updatedAt}, deployer ${record.deployerAddress}`);
  for (const [contractName, entry] of Object.entries(record.contracts)) {
    console.log(`  contract  ${contractName.padEnd(20)} ${entry.address}  (tx ${entry.deployTransactionId})`);
  }
  const wiringStepIds = Object.keys(record.wiringSteps);
  console.log(`  wiring steps completed: ${wiringStepIds.length}`);
  for (const stepId of wiringStepIds) console.log(`    ${stepId.padEnd(44)} tx ${record.wiringSteps[stepId].transactionId}`);
}

async function main() {
  const offline = process.argv.includes('--offline');
  const network = getNetworkConfig(networkNameFromCommandLine());
  const seedHex = readSeedHexForNetwork(network);

  console.log(`Network: ${network.name}`);
  console.log(`Deployer address: ${deriveWalletKeys({ seedHex, networkId: network.networkId }).unshieldedAddress}`);

  const proofServer = await readProofServerHealth();
  console.log(`\nProof server at ${proofServerUrl()}: ${proofServer.reachable ? `healthy, version ${proofServer.version}` : proofServer.healthText}`);
  if (!proofServer.reachable) {
    console.log('  Next step: docker start cryptosure-proof-server   (or see README, "Start the proof server")');
  }

  console.log('\nDeployed:');
  printDeploymentRecord(network.name);

  if (offline) return;

  console.log('\nBalances (syncing the wallet with the chain; this can take a minute or more)...');
  const wallet = await openHeadlessWallet({ seedHex, network, proofServerUrl: proofServerUrl(), log: (line) => console.log(`  ${line}`) });
  try {
    const balances = await wallet.readBalances();
    console.log(`  NIGHT: ${formatNight(balances.night)}  (${balances.nightCoinCount} coin(s), ${balances.nightCoinsRegisteredForDust} registered for DUST generation)`);
    console.log(`  DUST : ${formatDust(balances.dust)}  (${balances.dustCoinCount} coin(s))`);
    if (balances.night === 0n) {
      console.log(`\n  This wallet has no NIGHT on ${network.name}. Fund it at ${network.faucetWebPage ?? '(no faucet for this network)'}`);
      console.log(`  Address to fund: ${wallet.unshieldedAddress}`);
    } else if (balances.dust === 0n) {
      console.log('\n  The wallet has NIGHT but no DUST yet. "npm run deploy" registers it for DUST generation and waits.');
    }
  } finally {
    await wallet.close();
  }
}

// Only run when started directly (other scripts import readProofServerHealth).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(
    () => process.exit(process.exitCode ?? 0),
    (error) => {
      console.error(`\ncheck-status failed: ${error.message}`);
      process.exit(1);
    }
  );
}
