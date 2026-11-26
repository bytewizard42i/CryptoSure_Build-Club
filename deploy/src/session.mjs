// ============================================================================
// session.mjs — open everything a network script needs, and close it again
// ============================================================================
// Both deploy-program.mjs and run-one-clearance.mjs need the same things in
// the same order: network settings, the seed, a healthy proof server, a
// synced wallet that can pay fees, the Midnight.js providers and a
// NetworkChain. This file does that once, with clear messages at each point
// a person might get stuck.
//
// It STOPS (with instructions) rather than guessing when:
//   - the proof server is not reachable
//   - the wallet has no NIGHT (it must be funded by a person at the faucet)
//   - the wallet has NIGHT but DUST has not been generated yet
// ============================================================================

import { getNetworkConfig, networkNameFromCommandLine, proofServerUrl } from './config.mjs';
import { readSeedHexForNetwork } from './seed-file.mjs';
import { formatDust, formatNight, openHeadlessWallet } from './wallet.mjs';
import { readProofServerHealth } from './check-status.mjs';
import { createProviderFactory } from './providers.mjs';
import { NetworkChain } from './network-chain.mjs';

/** Raised when the script cannot continue until a PERSON does something. */
export class NeedsHumanActionError extends Error {}

/**
 * @param {{log?: (line: string) => void, onTransaction?: (entry: object) => void}} [options]
 * @returns {{network, wallet, chain, close(): Promise<void>}}
 */
export async function openNetworkSession({ log = console.log, onTransaction } = {}) {
  const network = getNetworkConfig(networkNameFromCommandLine());
  const seedHex = readSeedHexForNetwork(network);

  const proofServer = await readProofServerHealth();
  if (!proofServer.reachable) {
    throw new NeedsHumanActionError(
      `The proof server at ${proofServerUrl()} is not answering (${proofServer.healthText}).\n` +
      'Next step: docker start cryptosure-proof-server   (first time: see README, "Start the proof server")'
    );
  }
  log(`Network: ${network.name} (network id "${network.networkId}"). Proof server: healthy, version ${proofServer.version}.`);

  const wallet = await openHeadlessWallet({ seedHex, network, proofServerUrl: proofServerUrl(), log });
  try {
    log('Syncing the wallet with the chain...');
    const balances = await wallet.readBalances();
    log(`Deployer ${wallet.unshieldedAddress}: ${formatNight(balances.night)} NIGHT, ${formatDust(balances.dust)} DUST.`);

    if (balances.night === 0n && balances.dust === 0n) {
      throw new NeedsHumanActionError(
        `The deployer wallet has no NIGHT on ${network.name}, so it cannot pay for transactions.\n` +
        `Next step: open ${network.faucetWebPage ?? 'the faucet for this network'} in a browser, paste this address, complete the captcha:\n` +
        `  ${wallet.unshieldedAddress}\n` +
        'Then run this command again. Nothing has been sent.'
      );
    }

    if (balances.dust === 0n) {
      log('The wallet has NIGHT but no DUST. Registering for DUST generation and waiting (up to 10 minutes)...');
      const outcome = await wallet.ensureDustForFees();
      if (outcome.status !== 'registered-and-generated' && outcome.status !== 'already-had-dust') {
        throw new NeedsHumanActionError(
          `DUST has not been generated yet (status: ${outcome.status}, waited ${outcome.waitedSeconds ?? 0}s` +
          `${outcome.registrationTransactionId ? `, registration tx ${outcome.registrationTransactionId}` : ''}).\n` +
          'Next step: wait a few minutes and run this command again; "npm run status" shows the DUST balance.'
        );
      }
      log(`DUST is available (waited ${outcome.waitedSeconds ?? 0}s${outcome.registrationTransactionId ? `, registration tx ${outcome.registrationTransactionId}` : ''}).`);
    }

    const providerFactory = await createProviderFactory({ wallet, network, proofServerUrl: proofServerUrl(), seedHex });
    const chain = new NetworkChain({ providerFactory, onTransaction });
    return { network, wallet, chain, close: () => wallet.close() };
  } catch (error) {
    await wallet.close();
    throw error;
  }
}

/**
 * Run a script's main function and exit with a clear message.
 * Exit code 2 means "a person needs to do something first"; 1 means failure.
 */
export function runAsScript(main) {
  main().then(
    () => process.exit(process.exitCode ?? 0),
    (error) => {
      if (error instanceof NeedsHumanActionError) {
        console.error(`\nSTOPPED: ${error.message}`);
        process.exit(2);
      }
      console.error(`\nFAILED: ${error.message}`);
      for (let cause = error.cause, depth = 0; cause != null && depth < 5; cause = cause.cause, depth += 1) {
        console.error(`  caused by: ${cause.message ?? cause}`);
      }
      process.exit(1);
    }
  );
}
