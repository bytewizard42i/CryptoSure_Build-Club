// ============================================================================
// encoding.mjs — turning everyday values into the exact bytes contracts use
// ============================================================================
// The contracts only work with fixed-size byte strings (Bytes<32>). These
// helpers are the off-chain half of values the contracts store or compare,
// so the bytes must match exactly.
// ============================================================================

import { createHash, createHmac, randomBytes } from 'node:crypto';

const HEX_PATTERN = /^[0-9a-f]*$/;

export function hexToBytes(hex) {
  if (typeof hex !== 'string' || hex.length % 2 !== 0 || !HEX_PATTERN.test(hex)) {
    throw new TypeError('Expected an even-length lowercase hex string.');
  }
  return Uint8Array.from(Buffer.from(hex, 'hex'));
}

export function bytesToHex(bytes) {
  return Buffer.from(bytes).toString('hex');
}

export function random32Bytes() {
  return Uint8Array.from(randomBytes(32));
}

// Same as Compact's pad(32, "..."): the text's UTF-8 bytes, then zeros.
// Used for short names that live on-chain as ids (profiles, cover classes,
// region codes).
export function padTo32Bytes(text) {
  const textBytes = Buffer.from(text, 'utf8');
  if (textBytes.length > 32) throw new RangeError(`"${text}" is longer than 32 bytes.`);
  const padded = new Uint8Array(32);
  padded.set(textBytes);
  return padded;
}

// ---------------------------------------------------------------------------
// THE WALLET HASH IS KEYED, ON PURPOSE.
// A wallet appears on-chain only as walletHash (and values derived from it).
// If it were a plain hash of the address, anyone could hash a known address
// and search the chain for it. Mixing in a secret that only the program's
// operators hold (an HMAC) makes that impossible for outsiders.
// Trade-off, stated plainly: the operators CAN recompute it. They already see
// the address when they screen it, so nothing new is revealed to them.
// ---------------------------------------------------------------------------
export function deriveWalletHash(programWalletHashKey, { chain, address }) {
  if (!(programWalletHashKey instanceof Uint8Array) || programWalletHashKey.length !== 32) {
    throw new TypeError('deriveWalletHash needs the program\'s 32-byte wallet-hash key.');
  }
  if (typeof chain !== 'string' || typeof address !== 'string' || chain === '' || address === '') {
    throw new TypeError('deriveWalletHash needs { chain, address } as non-empty strings.');
  }
  return Uint8Array.from(createHmac('sha256', programWalletHashKey).update(`cryptosure:wallet:${chain}:${address}`, 'utf8').digest());
}

// JSON with object keys in sorted order, so the same document always gives
// the same text (and therefore the same hash) however it was typed.
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

// The ONLY thing about a policy that ever reaches a contract: a 32-byte
// fingerprint of the completed agreement. The agreement stays private.
export function derivePolicyRef(policyDocument) {
  return Uint8Array.from(createHash('sha256').update(`cryptosure:policy:${canonicalJson(policyDocument)}`, 'utf8').digest());
}

// DEMO ONLY: a secret key derived from a label so runs are repeatable. A real
// key is generated on the owner's device and never leaves it.
export function deriveDemoSecretKey(label) {
  return Uint8Array.from(createHash('sha256').update(`cryptosure:demo-secret-key:${label}`, 'utf8').digest());
}
