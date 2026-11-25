// ============================================================================
// Wallet screening — "is this wallet address on a denylist?"
// ============================================================================
// This one is CryptoSure's own job (the "screener" role in WalletBinder), so
// it lives in this repo. List-based screening has to see the address, the
// same as any compliance vendor today.
//
// SIMULATED: answers come from demo/mock-screening-fixture.json, where every
// address is fictional. A real deployment swaps that file for live denylist
// feeds (OFAC SDN, EU, UK OFSI, UN) or an aggregator.
//
// Fail closed: an address we have never seen is NOT cleared.
// ============================================================================

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const FIXTURE_PATH = fileURLToPath(new URL('../demo/mock-screening-fixture.json', import.meta.url));
const SCREENING_FIXTURE = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));

const SCREENED_ADDRESSES = new Map(
  SCREENING_FIXTURE.addresses.map((entry) => [`${entry.chain}:${entry.address}`, entry])
);

/**
 * @returns {{cleared: true, listVersion: number} | {cleared: false, reasonCode: string}}
 */
export function screenWallet({ chain, address }) {
  if (typeof chain !== 'string' || typeof address !== 'string') {
    throw new TypeError('screenWallet needs { chain, address } as strings.');
  }
  const entry = SCREENED_ADDRESSES.get(`${chain}:${address}`);
  if (entry === undefined) return { cleared: false, reasonCode: 'WALLET_NOT_SCREENED' };
  if (entry.banned) return { cleared: false, reasonCode: 'WALLET_LISTED' };
  return { cleared: true, listVersion: SCREENING_FIXTURE.listVersion };
}
