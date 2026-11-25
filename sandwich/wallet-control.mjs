// ============================================================================
// Wallet control — "prove this wallet is yours."
// ============================================================================
// Before a wallet can be insured, the applicant must show they hold its key.
// The standard way: we send a random challenge, the wallet signs it, we check
// the signature against the wallet's public key. Only the key holder can
// produce that signature, and a fresh challenge each time means an old
// signature cannot be replayed.
//
// SIMULATED: the demo wallets are fictional addresses with no real keys, so
// each one is given a stand-in Ed25519 key pair derived from a seed. A real
// integration verifies the wallet's native signature instead (for example an
// EIP-191 personal_sign for Ethereum) and recovers the address from it.
// ============================================================================

import { createHash, createPrivateKey, createPublicKey, randomBytes, sign, verify } from 'node:crypto';

// Fixed header that wraps a raw 32-byte seed into the PKCS#8 container
// Node's crypto module expects for an Ed25519 private key.
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export function deriveDemoWalletKeyPair(seedText) {
  const seed = createHash('sha256').update(`cryptosure:demo-wallet-key:${seedText}`, 'utf8').digest();
  const privateKey = createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' });
  return { privateKey, publicKey: createPublicKey(privateKey) };
}

// The message names the wallet and the purpose, so a signature for one
// wallet or one purpose is useless anywhere else.
export function createWalletControlChallenge({ chain, address }) {
  const nonce = randomBytes(32).toString('hex');
  return `CryptoSure wallet control check\nwallet: ${chain}:${address}\nnonce: ${nonce}`;
}

export function signWalletControlChallenge(walletPrivateKey, challenge) {
  return sign(null, Buffer.from(challenge, 'utf8'), walletPrivateKey);
}

export function verifyWalletControl({ walletPublicKey, challenge, signature }) {
  return verify(null, Buffer.from(challenge, 'utf8'), walletPublicKey, signature);
}
