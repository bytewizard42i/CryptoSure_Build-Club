// ============================================================================
// providers.mjs — the set of helpers Midnight.js needs to build a transaction
// ============================================================================
// Midnight.js does not talk to anything directly. It is handed a set of
// "providers", each doing one job:
//
//   privateStateProvider    keeps the caller's private inputs (encrypted, in a
//                           local database) and each contract's maintenance key
//   publicDataProvider      reads the chain through the INDEXER
//   zkConfigProvider        reads ONE contract's proving/verifier keys from disk
//   proofProvider           sends private inputs to the local PROOF SERVER and
//                           gets zero-knowledge proofs back
//   walletProvider          adds the fee payment and signs (our headless wallet)
//   midnightProvider        submits the finished transaction to the NODE
//   contractModuleProvider  for cross-contract calls: "which compiled code is
//                           deployed at address X?"
//   config                  { networkId, ttlSeconds } — Midnight.js 5 has no
//                           global setNetworkId(); the network is named here.
//
// CROSS-CONTRACT CALLS NEED TWO EXTRA THINGS (Midnight.js 5.0.0 release notes)
//   1. A transaction that calls through several contracts carries one proof
//      per contract, so the proof provider must find keys for ALL of them.
//      nodeZkConfigRegistry(build/) discovers every build/<Name> bundle and
//      matches each deployed contract to its bundle by verifier key.
//   2. The chain stores no code, so only we know which compiled module lives
//      at which address: bundledContractModuleProvider(address -> module).
//
// REFERENCES (installed type definitions and READMEs)
//   @midnight-ntwrk/midnight-js-types  MidnightProviders, MidnightConfig,
//       createLedger9WalletProvider, createLedger9MidnightProvider
//   @midnight-ntwrk/midnight-js-node-zk-config-provider  NodeZkConfigProvider,
//       nodeZkConfigRegistry
//   @midnight-ntwrk/midnight-js-bundled-contract-module-provider  README
//   @midnight-ntwrk/midnight-js-http-client-proof-provider
//   @midnight-ntwrk/midnight-js-level-private-state-provider
// ============================================================================

import { createHmac } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createLedger9MidnightProvider, createLedger9WalletProvider } from '@midnight-ntwrk/midnight-js-types';
import { NodeZkConfigProvider, nodeZkConfigRegistry } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { bundledContractModuleProvider } from '@midnight-ntwrk/midnight-js-bundled-contract-module-provider';
import { BUILD_FOLDER, LOCAL_STATE_FOLDER, TRANSACTION_TIME_TO_LIVE_SECONDS } from './config.mjs';

// Proving one transaction can take minutes on a laptop (several circuits for
// a cross-contract call). The library default is 5 minutes; allow 15.
const PROOF_TIMEOUT_MILLISECONDS = 15 * 60 * 1000;

// The local private-state database is encrypted with a password. Rather than
// invent a second secret to look after, derive one from the wallet seed with
// a one-way function (HMAC-SHA256 under a fixed label). Whoever can read the
// seed can already do everything the database protects, and the password
// itself is never stored or printed.
function derivePrivateStatePassword(seedHex) {
  return createHmac('sha256', Buffer.from(seedHex, 'hex')).update('cryptosure:deploy:private-state-password:v1').digest('base64');
}

// Adapt our headless wallet to the two interfaces Midnight.js expects.
// Transactions cross between Midnight.js and the wallet as BYTES because each
// library carries its own copy of the ledger code.
async function createWalletAndSubmissionProviders(wallet) {
  const syncedState = await wallet.waitUntilSynced();
  const { facade, unshieldedKeystore } = wallet;

  const walletProvider = createLedger9WalletProvider({
    getCoinPublicKey: () => syncedState.shielded.coinPublicKey.toHexString(),
    getEncryptionPublicKey: () => syncedState.shielded.encryptionPublicKey.toHexString(),
    // "Balance" = add inputs that pay the fee (DUST), then sign and finalize.
    async balanceTx(transaction, timeToLive) {
      const adopted = facade.adoptTransaction(transaction.serialize(), 'Unbound');
      const recipe = await facade.balanceUnboundTransaction(adopted, {
        ttl: timeToLive ?? new Date(Date.now() + TRANSACTION_TIME_TO_LIVE_SECONDS * 1000)
      });
      const signedRecipe = await facade.signRecipe(recipe, unshieldedKeystore.signDataAsync);
      return facade.finalizeRecipe(signedRecipe);
    }
  });

  const midnightProvider = createLedger9MidnightProvider((transaction) =>
    facade.submitTransaction(facade.adoptTransaction(transaction.serialize(), 'Finalized'))
  );

  return { walletProvider, midnightProvider, coinPublicKeyHex: walletProvider.getCoinPublicKey() };
}

/**
 * Build the providers shared by every contract on one network.
 *
 * @param {{wallet: object, network: object, proofServerUrl: string, seedHex: string}} input
 *        `wallet` from wallet.mjs openHeadlessWallet(); `network` from config.mjs.
 * @returns {{shared: object, forContract(loadedContract): object,
 *            withContractModules(providers, modulesByAddress): object}}
 */
export async function createProviderFactory({ wallet, network, proofServerUrl, seedHex }) {
  const { walletProvider, midnightProvider, coinPublicKeyHex } = await createWalletAndSubmissionProviders(wallet);

  // One database folder per network, so preview and a local test chain never mix.
  const databaseFolder = path.join(LOCAL_STATE_FOLDER, network.name);
  mkdirSync(databaseFolder, { recursive: true });
  const privateStatePassword = derivePrivateStatePassword(seedHex);
  const privateStateProvider = levelPrivateStateProvider({
    midnightDbName: path.join(databaseFolder, 'midnight-level-db'),
    privateStateStoreName: 'cryptosure-private-states',
    signingKeyStoreName: 'cryptosure-signing-keys',
    // Scopes the stored data to this wallet (a public value).
    accountId: coinPublicKeyHex,
    privateStoragePasswordProvider: () => privateStatePassword
  });

  // Keys for EVERY contract under build/, matched to deployed contracts by
  // verifier key. This is what lets a cross-contract transaction be proven.
  const zkConfigRegistry = await nodeZkConfigRegistry(BUILD_FOLDER);

  const shared = {
    privateStateProvider,
    publicDataProvider: indexerPublicDataProvider({ queryURL: network.indexerHttpUrl, subscriptionURL: network.indexerWebSocketUrl }),
    proofProvider: httpClientProofProvider({ url: proofServerUrl, zkConfigProvider: zkConfigRegistry, timeout: PROOF_TIMEOUT_MILLISECONDS }),
    walletProvider,
    midnightProvider,
    config: { networkId: network.networkId, ttlSeconds: TRANSACTION_TIME_TO_LIVE_SECONDS }
  };

  const zkConfigProvidersByContract = new Map();

  return {
    shared,

    /** Providers for calls TO one contract: the shared set plus that contract's own keys. */
    forContract(loadedContract) {
      if (!zkConfigProvidersByContract.has(loadedContract.name)) {
        zkConfigProvidersByContract.set(loadedContract.name, new NodeZkConfigProvider(loadedContract.assetsFolder));
      }
      return { ...shared, zkConfigProvider: zkConfigProvidersByContract.get(loadedContract.name) };
    },

    /**
     * Add the "which code is at which address" table needed for cross-contract calls.
     * @param {object} providers                 from forContract()
     * @param {Map<string, object>} modulesByAddress  contract address -> compiled module
     */
    withContractModules(providers, modulesByAddress) {
      if (modulesByAddress.size === 0) return providers;
      const thunksByAddress = new Map([...modulesByAddress].map(([address, module]) => [address, async () => module]));
      return { ...providers, contractModuleProvider: bundledContractModuleProvider(thunksByAddress) };
    }
  };
}
