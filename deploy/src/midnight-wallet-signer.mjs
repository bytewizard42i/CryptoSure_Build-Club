// ============================================================================
// midnight-wallet-signer.mjs — sign a text message with a REAL Midnight
// wallet key, and check such a signature against the wallet's ADDRESS
// ============================================================================
// WHY
//   Two moments in CryptoSure need "sign this with the wallet's own key":
//   proving control of a wallet, and acknowledging a policy. Today those use
//   stand-in Ed25519 keys (protocol/wallet-signatures.mjs). This file does it
//   with the wallet's real UNSHIELDED key, the one behind its
//   mn_addr_<network>1... address.
//
// WHAT THE INSTALLED SDK OFFERS (looked at, not assumed)
//   @midnightntwrk/ledger-v9 (ledger-v9.d.ts):
//     signData(key, bytes)                 sign arbitrary bytes
//     verifySignature(vk, bytes, sig)      check a signature
//     signatureVerifyingKey(key)           public key of a signing key
//     addressFromKey(vk)                   the address a public key owns
//   @midnightntwrk/wallet-sdk-unshielded-wallet (UnshieldedWallet.d.ts):
//     createKeystore({kind, secret}, networkId) -> signData, getPublicKey,
//     getBech32Address. This is the same keystore the headless wallet signs
//     transactions with.
//   So: YES, a headless wallet built from a seed can sign any text, and YES,
//   anyone can check that the verifying key belongs to an address, because
//   an unshielded address IS a one-way function of the verifying key.
//
// THE MESSAGE FORMAT: THE SAME AS A BROWSER WALLET'S signData
//   The DApp Connector specification (github.com/midnightntwrk/
//   midnight-dapp-connector-api, SPECIFICATION.md v4.1.0, section "Signing")
//   says a wallet must prefix the data with
//       midnight_signed_message:<data_size>:
//   where <data_size> is the size of the data in bytes, "to make it
//   impossible to sign transactions by accident". We sign exactly that, so a
//   signature made here and one made by a browser wallet through the
//   connector are meant to be checkable by the same function.
//   (Whether a real browser wallet matches byte-for-byte has NOT been tested;
//   see connector-wallet-signer.mjs.)
//
// WHAT IS ACTUALLY SIGNED, CRYPTOGRAPHICALLY
//   For the 'schnorr' scheme the ledger computes a BIP-340 Schnorr signature
//   over SHA-256(bytes). Confirmed independently in the tests with the
//   @noble/curves library. The signature is 64 bytes (r then s) and the
//   verifying key is 32 bytes (x-only), as the connector's Signature type
//   describes for `schnorr_bip340`.
//
// THE RULE THE VERIFIER KEEPS
//   It rebuilds the signed bytes from the message WE expect. It never
//   trusts the `data` field that arrives with a signature. And it returns
//   true only if BOTH hold:
//     1. the verifying key hashes to the given address, on the given network
//     2. the signature is valid for that key over the expected bytes
//   Without 1, anyone could sign with their own key and claim your address.
//
// SECRETS
//   The seed is used in memory to make the key and is never printed or kept
//   in the returned object's visible fields.
//
// IDEAS, NOT BUILT
//   IDEA: plug this into the wallet-control provider: verify with
//         verifyMidnightWalletSignature({ address: wallet.address, ... })
//         instead of the stand-in key lookup. The protocol's signer shape
//         returns one hex string today; it would carry this object instead.
//   IDEA: an ECDSA signer (Roles.EcdsaUnshielded); the verifier below already
//         accepts `ecdsa_secp256k1_sha256` signatures.
// ============================================================================

import { addressFromKey, verifySignature } from '@midnightntwrk/ledger-v9';
import { MidnightBech32m, UnshieldedAddress } from '@midnightntwrk/wallet-sdk';
import { deriveWalletKeys } from './wallet.mjs';

// Connector scheme name -> { the ledger's name for it, verifying key length in bytes }.
// Reference: @midnightntwrk/dapp-connector-api dist/api.d.ts, type Signature.
const SIGNATURE_SCHEMES = {
  schnorr_bip340: { ledgerTag: 'schnorr', verifyingKeyBytes: 32 },
  ecdsa_secp256k1_sha256: { ledgerTag: 'ecdsa', verifyingKeyBytes: 33 }
};
// The connector says: when `scheme` is missing, treat it as schnorr_bip340.
const DEFAULT_SCHEME = 'schnorr_bip340';
const SIGNATURE_BYTES = 64;

const isLowercaseHexOfLength = (value, byteLength) => typeof value === 'string' && value.length === byteLength * 2 && /^[0-9a-f]*$/.test(value);

/**
 * The exact bytes a Midnight wallet signs for a text message:
 * "midnight_signed_message:<size in bytes>:" followed by the message as UTF-8.
 */
export function buildSignedMessageBytes(messageText) {
  if (typeof messageText !== 'string') throw new TypeError('The message to sign must be a string.');
  const messageBytes = Buffer.from(messageText, 'utf8');
  return Buffer.concat([Buffer.from(`midnight_signed_message:${messageBytes.length}:`, 'utf8'), messageBytes]);
}

/**
 * A signer backed by a real Midnight unshielded key derived from a seed.
 *
 * @param {{seedHex: string, networkId: string}} input
 * @returns {{address: string, sign(messageText: string): Promise<{scheme: string, data: string, signature: string, verifyingKey: string}>}}
 *          `sign` resolves to everything a verifier needs, in the same shape
 *          a browser wallet returns from the DApp Connector's signData.
 */
export function createMidnightWalletSigner({ seedHex, networkId }) {
  const { unshieldedKeystore, unshieldedAddress } = deriveWalletKeys({ seedHex, networkId });
  const verifyingKey = unshieldedKeystore.getPublicKey();

  return {
    address: unshieldedAddress,
    async sign(messageText) {
      const signature = unshieldedKeystore.signData(buildSignedMessageBytes(messageText));
      return { scheme: DEFAULT_SCHEME, data: messageText, signature: signature.value, verifyingKey: verifyingKey.value };
    }
  };
}

// The 32-byte address inside a Bech32m unshielded address, as hex, or null
// if the text is not an unshielded address for exactly this network.
function unshieldedAddressHexOrNull(address, networkId) {
  try {
    const parsed = MidnightBech32m.parse(address);
    return parsed.decode(UnshieldedAddress, networkId).hexString.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Is `signed` a valid signature of `messageText` by the wallet at `address`?
 *
 * Returns true only if the signature verifies AND the verifying key is the
 * one that owns `address` on `networkId`. Returns false for anything else,
 * including malformed input; it never throws.
 *
 * @param {{address: string, networkId: string, messageText: string,
 *          signed: {scheme?: string, signature: string, verifyingKey: string, data?: string}}} input
 */
export function verifyMidnightWalletSignature({ address, networkId, messageText, signed } = {}) {
  if (typeof address !== 'string' || typeof networkId !== 'string' || networkId === '' || typeof messageText !== 'string') return false;
  if (signed === null || typeof signed !== 'object') return false;

  const schemeName = signed.scheme ?? DEFAULT_SCHEME;
  if (typeof schemeName !== 'string' || !Object.hasOwn(SIGNATURE_SCHEMES, schemeName)) return false;
  const scheme = SIGNATURE_SCHEMES[schemeName];
  if (!isLowercaseHexOfLength(signed.signature, SIGNATURE_BYTES)) return false;
  if (!isLowercaseHexOfLength(signed.verifyingKey, scheme.verifyingKeyBytes)) return false;

  const addressHex = unshieldedAddressHexOrNull(address, networkId);
  if (addressHex === null) return false;

  const verifyingKey = { tag: scheme.ledgerTag, value: signed.verifyingKey };
  try {
    // 1. Does this key own this address?
    if (addressFromKey(verifyingKey).toLowerCase() !== addressHex) return false;
    // 2. Did this key sign the bytes WE expect? (`signed.data` is ignored on purpose.)
    return verifySignature(verifyingKey, buildSignedMessageBytes(messageText), { tag: scheme.ledgerTag, value: signed.signature }) === true;
  } catch {
    // The ledger throws on keys or signatures it cannot parse.
    return false;
  }
}
