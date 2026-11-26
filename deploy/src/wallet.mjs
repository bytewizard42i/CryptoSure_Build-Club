// ============================================================================
// wallet.mjs — a "headless" Midnight wallet built from a seed
// ============================================================================
// WHAT THIS IS
//   A wallet with no window and no browser extension: a program that holds
//   the keys in memory, follows the chain, and can pay fees and sign. It is
//   what lets a script deploy contracts without a person clicking "approve".
//
// A MIDNIGHT WALLET IS REALLY THREE WALLETS
//   unshielded  holds NIGHT (the public token) and signs with a normal key.
//               Its address starts mn_addr_<network>1...
//   shielded    holds private coins (unused by CryptoSure, but the SDK and
//               Midnight.js need its public keys).
//   dust        holds DUST, the resource that pays transaction fees. DUST is
//               not sent to you: it is GENERATED over time by NIGHT that has
//               been "registered for dust generation".
//   The Wallet SDK's WalletFacade drives all three together.
//
// HOW KEYS COME FROM THE SEED ("HD derivation")
//   WalletSeeds.fromMasterSeed(seed) walks a BIP32 tree, account 0, address
//   index 0, and returns one sub-seed per wallet. The unshielded sub-seed
//   comes from the role "NightExternal" and is used as a BIP-340 Schnorr key.
//   This is the same place Wallet SDK 1.2.0 derived from, which is why the
//   address matches the one derived with the old SDK (npm run check-address).
//
// WHERE THE FACTS CAME FROM
//   Read from the INSTALLED packages' type definitions, not from memory:
//   - @midnightntwrk/wallet-sdk-hd            dist/WalletSeeds.d.ts
//   - @midnightntwrk/wallet-sdk-unshielded-wallet  dist/UnshieldedWallet.d.ts
//                                              (createKeystore, PublicKey)
//   - @midnightntwrk/wallet-sdk-facade        dist/index.d.ts (WalletFacade)
//   - Shape of WalletFacade.init: the ledger-9 counter example in
//     utils_midskills/templates/counter-dapp/counter-cli/src/api.ts, checked
//     against the type definitions above.
//
// SECRETS
//   The seed and keys stay in memory. Nothing here prints or stores them.
//
// IDEAS, NOT BUILT
//   IDEA: save the wallet's sync state between runs so start-up is faster
//         (the facade's wallets expose serializeState(); it would go in the
//         git-ignored .local-state folder, encrypted).
//   IDEA: an out-of-process signer (hardware key / HSM) by passing a
//         different `signSegment` function instead of the in-memory keystore.
// ============================================================================

import {
  WalletFacade,
  WalletEntrySchema,
  WalletSeeds,
  ShieldedWallet,
  UnshieldedWallet,
  DustWallet,
  PublicKey,
  createKeystore,
  InMemoryTransactionHistoryStorage,
  MidnightBech32m
} from '@midnightntwrk/wallet-sdk';
import { nativeToken } from '@midnightntwrk/ledger-v9';
import { looksLikeSeedHex } from './seed-file.mjs';

// NIGHT is counted on-chain in its smallest unit (a millionth of a NIGHT) and
// DUST in its smallest unit (10^-15 of a DUST). These are only for display.
const NIGHT_DECIMAL_PLACES = 6;
const DUST_DECIMAL_PLACES = 15;

/** Turn a whole-number amount of smallest units into "12.345" for people to read. */
export function formatTokenAmount(smallestUnits, decimalPlaces) {
  const digits = smallestUnits.toString().padStart(decimalPlaces + 1, '0');
  const wholePart = digits.slice(0, -decimalPlaces);
  const fractionPart = digits.slice(-decimalPlaces).replace(/0+$/, '');
  return fractionPart === '' ? wholePart : `${wholePart}.${fractionPart}`;
}
export const formatNight = (amount) => formatTokenAmount(amount, NIGHT_DECIMAL_PLACES);
export const formatDust = (amount) => formatTokenAmount(amount, DUST_DECIMAL_PLACES);

/**
 * OFFLINE: derive the wallet's keys and unshielded address from a seed.
 * Touches no network, so it is safe and instant. Used for the address check
 * and by the headless wallet below.
 *
 * @param {{seedHex: string, networkId: string}} input
 * @returns {{seeds: object, unshieldedKeystore: object, unshieldedAddress: string}}
 */
export function deriveWalletKeys({ seedHex, networkId }) {
  if (!looksLikeSeedHex(seedHex)) throw new TypeError('deriveWalletKeys needs seedHex: exactly 64 hexadecimal characters.');
  if (typeof networkId !== 'string' || networkId === '') throw new TypeError('deriveWalletKeys needs a networkId such as "preview".');

  // account 0, address index 0, unshielded role NightExternal: the defaults.
  const seeds = WalletSeeds.fromMasterSeed(Buffer.from(seedHex, 'hex'));
  // 'schnorr' = BIP-340 Schnorr, the scheme every Midnight network accepts.
  const unshieldedKeystore = createKeystore({ kind: 'schnorr', secret: seeds.unshielded }, networkId);
  return {
    seeds,
    unshieldedKeystore,
    unshieldedAddress: unshieldedKeystore.getBech32Address().asString()
  };
}

// Reject after `milliseconds` so a script never hangs silently.
function withTimeout(promise, milliseconds, whatWeWereWaitingFor) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${Math.round(milliseconds / 1000)}s waiting for: ${whatWeWereWaitingFor}`)), milliseconds);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

/**
 * Open a headless wallet on a network and start following the chain.
 *
 * @param {{seedHex: string, network: object, proofServerUrl: string, log?: (line: string) => void}} input
 *        `network` comes from config.mjs getNetworkConfig().
 * @returns an object with the wallet's address and the few operations the
 *          deploy scripts need. ALWAYS call close() when finished.
 */
export async function openHeadlessWallet({ seedHex, network, proofServerUrl, log = () => {} }) {
  const { seeds, unshieldedKeystore, unshieldedAddress } = deriveWalletKeys({ seedHex, networkId: network.networkId });

  // One configuration object serves all three wallets.
  // Field names: @midnightntwrk/wallet-sdk-facade DefaultConfiguration.
  const configuration = {
    networkId: network.networkId,
    indexerClientConnection: { indexerHttpUrl: network.indexerHttpUrl, indexerWsUrl: network.indexerWebSocketUrl },
    // The wallet proves its own fee payment (a small DUST-spend proof).
    provingServerUrl: new URL(proofServerUrl),
    // The node that transactions are submitted to, over WebSocket.
    relayURL: new URL(network.nodeRpcWebSocketUrl),
    // Fee safety margins; the values the official ledger-9 counter example uses.
    costParameters: { additionalFeeOverhead: 300_000_000_000_000n, feeBlocksMargin: 5 },
    txHistoryStorage: new InMemoryTransactionHistoryStorage(WalletEntrySchema)
  };

  const facade = await WalletFacade.init({
    configuration,
    shielded: (resolved) => ShieldedWallet(resolved).startWithSeed(seeds.shielded),
    // The unshielded wallet is started with the PUBLIC key only; signing is
    // done by our keystore when a transaction needs it.
    unshielded: (resolved) => UnshieldedWallet(resolved).startWithPublicKey(PublicKey.fromKeyStore(unshieldedKeystore)),
    dust: (resolved) => DustWallet(resolved).startWithSeed(seeds.dust)
  });
  await facade.start(seeds);
  log(`Wallet started for ${unshieldedAddress}; following the ${network.name} chain...`);

  let closed = false;

  /** Wait until all three wallets have caught up with the chain. */
  async function waitUntilSynced(timeoutMilliseconds = 15 * 60 * 1000) {
    return withTimeout(facade.waitForSyncedState(), timeoutMilliseconds, `the wallet to finish syncing with ${network.name}`);
  }

  /** Read balances from an already-synced state. Pure: no network. */
  function balancesOf(state) {
    const nightBalance = state.unshielded.balances[nativeToken().raw] ?? 0n;
    const nightCoins = state.unshielded.availableCoins;
    return {
      night: nightBalance,
      nightCoinCount: nightCoins.length,
      nightCoinsRegisteredForDust: nightCoins.filter((coin) => coin.meta.registeredForDustGeneration === true).length,
      // DUST grows with time, so the balance is "as of now".
      dust: state.dust.balance(new Date()),
      dustCoinCount: state.dust.availableCoins.length,
      dustAddress: MidnightBech32m.encode(network.networkId, state.dust.address).toString()
    };
  }

  /** Sync, then report balances. */
  async function readBalances() {
    return balancesOf(await waitUntilSynced());
  }

  /**
   * Make sure the wallet has DUST to pay fees with.
   *
   * - Already has DUST: nothing to do.
   * - Has NIGHT that is not registered: submit ONE registration transaction
   *   (signed by the unshielded key), then wait for DUST to appear.
   * - Has no NIGHT at all: cannot proceed; the wallet must be funded first.
   *
   * @returns {{status: 'already-had-dust'|'registered-and-generated'|'pending'|'no-night',
   *            registrationTransactionId?: string, waitedSeconds?: number}}
   */
  async function ensureDustForFees({ waitMilliseconds = 10 * 60 * 1000 } = {}) {
    const state = await waitUntilSynced();
    const balances = balancesOf(state);
    if (balances.dust > 0n) return { status: 'already-had-dust' };
    if (balances.night === 0n) return { status: 'no-night' };

    const startedAt = Date.now();
    let registrationTransactionId;
    const unregisteredCoins = state.unshielded.availableCoins.filter((coin) => coin.meta.registeredForDustGeneration !== true);
    if (unregisteredCoins.length > 0) {
      log(`Registering ${unregisteredCoins.length} NIGHT coin(s) for DUST generation...`);
      // Reference: WalletFacade.registerNightUtxosForDustGeneration in
      // @midnightntwrk/wallet-sdk-facade. The registration is authorised by a
      // signature from the key that owns the NIGHT.
      const recipe = await facade.registerNightUtxosForDustGeneration(unregisteredCoins, unshieldedKeystore.getPublicKey(), unshieldedKeystore.signDataAsync);
      const finalized = await facade.finalizeRecipe(recipe);
      registrationTransactionId = await facade.submitTransaction(finalized);
      log(`Registration submitted: ${registrationTransactionId}`);
    }

    // Poll until some DUST has been generated, or give up and say "pending".
    while (Date.now() - startedAt < waitMilliseconds) {
      await sleep(10_000);
      const latest = balancesOf(await waitUntilSynced());
      if (latest.dust > 0n) {
        return { status: 'registered-and-generated', registrationTransactionId, waitedSeconds: Math.round((Date.now() - startedAt) / 1000) };
      }
    }
    return { status: 'pending', registrationTransactionId, waitedSeconds: Math.round((Date.now() - startedAt) / 1000) };
  }

  /** Stop following the chain and release connections. Safe to call twice. */
  async function close() {
    if (closed) return;
    closed = true;
    try {
      await withTimeout(facade.stop(), 30_000, 'the wallet to shut down');
    } catch (error) {
      log(`The wallet did not shut down cleanly: ${error.message}`);
    }
  }

  return {
    networkName: network.name,
    networkId: network.networkId,
    unshieldedAddress,
    // Exposed for providers.mjs, which needs to balance, sign and submit.
    facade,
    unshieldedKeystore,
    waitUntilSynced,
    balancesOf,
    readBalances,
    ensureDustForFees,
    close
  };
}
