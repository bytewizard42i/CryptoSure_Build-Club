// ============================================================================
// Encoding helpers: turning everyday values into the exact bytes the
// WalletBinder contract works with.
// ============================================================================
// The contract only ever sees fixed-size byte strings (Bytes<32>). Everything
// here is the off-chain half of a hash or commitment the contract re-computes
// or checks in-circuit, so the bytes must match exactly.
// ============================================================================

import { createHash } from 'node:crypto';
import {
  CompactTypeBytes,
  CompactTypeUnsignedInteger,
  persistentCommit
} from '@midnight-ntwrk/compact-runtime';

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

function sha256(text) {
  return Uint8Array.from(createHash('sha256').update(text, 'utf8').digest());
}

// Same as Compact's pad(32, "..."): the text's UTF-8 bytes, then zeros.
export function padTo32Bytes(text) {
  const textBytes = Buffer.from(text, 'utf8');
  if (textBytes.length > 32) throw new RangeError(`"${text}" is longer than 32 bytes.`);
  const padded = new Uint8Array(32);
  padded.set(textBytes);
  return padded;
}

// A wallet is referred to on-chain only by this hash, never by its address.
export function deriveWalletHash({ chain, address }) {
  return sha256(`cryptosure:wallet:${chain}:${address}`);
}

// JSON with object keys in sorted order, so the same policy always produces
// the same text (and therefore the same hash) no matter how it was typed.
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const sortedKeys = Object.keys(value).sort();
    return `{${sortedKeys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

// The ONLY thing about the policy that goes on-chain: a 32-byte fingerprint
// of the document. The document itself stays off-chain and private.
export function derivePolicyRef(policyDocument) {
  return sha256(`cryptosure:policy:${canonicalJson(policyDocument)}`);
}

// ---------------------------------------------------------------------------
// CredentialBody, laid out exactly as the contract's struct:
//   holderPk: Bytes<32>, level: Uint<8>, jurisdictionLeaf: Bytes<32>,
//   credentialId: Bytes<32>, expiresAt: Uint<64>
// The compiler generates this same descriptor inside the contract module but
// does not export it, so it is mirrored here. If the struct ever changes, the
// end-to-end test fails (the contract will not find the credential).
// ---------------------------------------------------------------------------
const BYTES_32 = new CompactTypeBytes(32);
const UINT_8 = new CompactTypeUnsignedInteger(255n, 1);
const UINT_64 = new CompactTypeUnsignedInteger(18446744073709551615n, 8);

const CREDENTIAL_BODY_TYPE = {
  alignment() {
    return [BYTES_32, UINT_8, BYTES_32, BYTES_32, UINT_64].flatMap((fieldType) => fieldType.alignment());
  },
  toValue(body) {
    return [
      ...BYTES_32.toValue(body.holderPk),
      ...UINT_8.toValue(body.level),
      ...BYTES_32.toValue(body.jurisdictionLeaf),
      ...BYTES_32.toValue(body.credentialId),
      ...UINT_64.toValue(body.expiresAt)
    ];
  },
  fromValue(value) {
    return {
      holderPk: BYTES_32.fromValue(value),
      level: UINT_8.fromValue(value),
      jurisdictionLeaf: BYTES_32.fromValue(value),
      credentialId: BYTES_32.fromValue(value),
      expiresAt: UINT_64.fromValue(value)
    };
  }
};

// What the issuer inserts into the kycCredentials tree: a sealed commitment.
// Only someone holding body + salt can open it, and only inside a ZK proof.
export function commitToCredential(credentialBody, saltBytes) {
  return persistentCommit(CREDENTIAL_BODY_TYPE, credentialBody, saltBytes);
}
