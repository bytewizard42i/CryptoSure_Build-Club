// ============================================================================
// wallet-signatures.mjs — "sign this with the wallet's own key"
// ============================================================================
// Two moments in the protocol need a signature made by the wallet itself:
//   1. WALLET CONTROL  the holder signs a fresh random challenge, which shows
//                      they hold the wallet's key right now.
//   2. ACKNOWLEDGMENT  the holder signs "I understand this agreement" before
//                      a policy is bound.
//
// A WALLET SIGNER is anything with this shape:
//       { sign(messageText) -> Promise<signatureHex> }
// In a browser it wraps the wallet's own "sign message" feature (on Midnight,
// `signData` in the DApp Connector API). Here it is a stand-in.
//
// SIMULATED KEYS
//   The demo wallets are public test addresses whose keys we do not hold, so
//   each wallet is given a stand-in Ed25519 key pair derived from its
//   address. That makes the signatures real signatures, checked for real,
//   but NOT signatures by the actual wallet. A real integration verifies the
//   wallet's native signature and recovers or checks the address from it.
//
// IDEAS, NOT BUILT
//   - an adapter around the DApp Connector `signData` call
//   - per-chain verifiers (EIP-191 for Ethereum, BIP-322 for Bitcoin)
// ============================================================================

import { createHash, createPrivateKey, createPublicKey, randomBytes, sign, verify } from 'node:crypto';

// Fixed header that wraps a raw 32-byte seed into the PKCS#8 container
// Node's crypto module expects for an Ed25519 private key.
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function deriveDemoKeyPair(seedText) {
  const seed = createHash('sha256').update(`cryptosure:demo-wallet-key:${seedText}`, 'utf8').digest();
  const privateKey = createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' });
  return { privateKey, publicKey: createPublicKey(privateKey) };
}

// The stand-in public key "on file" for a wallet.
export function demoWalletPublicKey({ chain, address }) {
  return deriveDemoKeyPair(`${chain}:${address}`).publicKey;
}

/**
 * DEMO wallet signer.
 * @param {{chain: string, address: string}} wallet
 * @param {{signWithSomeoneElsesKey?: boolean}} [behaviour]  simulate a person
 *        who does not actually hold the wallet's key
 */
export function createDemoWalletSigner(wallet, behaviour = {}) {
  const seedText = behaviour.signWithSomeoneElsesKey ? `not-the-owner:${wallet.chain}:${wallet.address}` : `${wallet.chain}:${wallet.address}`;
  const { privateKey } = deriveDemoKeyPair(seedText);
  return {
    async sign(messageText) {
      return sign(null, Buffer.from(messageText, 'utf8'), privateKey).toString('hex');
    }
  };
}

// The challenge names the wallet and the purpose, so a signature for one
// wallet or one purpose is useless anywhere else. The random nonce means an
// old signature cannot be replayed.
export function createWalletControlChallenge({ chain, address }) {
  return `CryptoSure wallet control check\nwallet: ${chain}:${address}\nnonce: ${randomBytes(32).toString('hex')}`;
}

export function verifyWalletSignature({ walletPublicKey, messageText, signatureHex }) {
  if (typeof signatureHex !== 'string' || !/^[0-9a-f]{128}$/.test(signatureHex)) return false;
  return verify(null, Buffer.from(messageText, 'utf8'), walletPublicKey, Buffer.from(signatureHex, 'hex'));
}
