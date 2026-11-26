// ============================================================================
// Tests for src/midnight-wallet-signer.mjs
// ============================================================================
// These need NO network and NO real seed. The seeds below are throwaway
// values written here on purpose; they control nothing.
//
// Run:  npm test     (from the deploy/ folder)
// ============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { sampleSigningKey, signData, signatureVerifyingKey, addressFromKey } from '@midnightntwrk/ledger-v9';
import { MidnightBech32m, UnshieldedAddress } from '@midnightntwrk/wallet-sdk';
import { buildSignedMessageBytes, createMidnightWalletSigner, verifyMidnightWalletSignature } from '../src/midnight-wallet-signer.mjs';

// FIXED THROWAWAY TEST SEEDS (not secrets).
const TEST_SEED = `${'0'.repeat(63)}1`;
const OTHER_TEST_SEED = `${'0'.repeat(63)}2`;
const NETWORK = 'preview';
const MESSAGE = 'CryptoSure wallet control check\nwallet: midnight-preview:example\nnonce: 0123456789abcdef';

const signer = createMidnightWalletSigner({ seedHex: TEST_SEED, networkId: NETWORK });
const otherSigner = createMidnightWalletSigner({ seedHex: OTHER_TEST_SEED, networkId: NETWORK });

test('the signer reports a Preview unshielded address and never exposes the seed', () => {
  assert.match(signer.address, /^mn_addr_preview1[0-9a-z]+$/);
  assert.notEqual(signer.address, otherSigner.address);
  assert.equal(JSON.stringify(signer).includes(TEST_SEED), false);
});

test('a valid signature verifies against the signer\'s address', async () => {
  const signed = await signer.sign(MESSAGE);
  assert.equal(signed.scheme, 'schnorr_bip340');
  assert.match(signed.signature, /^[0-9a-f]{128}$/);
  assert.match(signed.verifyingKey, /^[0-9a-f]{64}$/);
  assert.equal(verifyMidnightWalletSignature({ address: signer.address, networkId: NETWORK, messageText: MESSAGE, signed }), true);
});

test('a signature with no scheme field is treated as schnorr_bip340, as the connector specifies', async () => {
  const { scheme: _dropped, ...signedWithoutScheme } = await signer.sign(MESSAGE);
  assert.equal(verifyMidnightWalletSignature({ address: signer.address, networkId: NETWORK, messageText: MESSAGE, signed: signedWithoutScheme }), true);
});

test('a different message fails', async () => {
  const signed = await signer.sign(MESSAGE);
  assert.equal(verifyMidnightWalletSignature({ address: signer.address, networkId: NETWORK, messageText: `${MESSAGE}!`, signed }), false);
  assert.equal(verifyMidnightWalletSignature({ address: signer.address, networkId: NETWORK, messageText: '', signed }), false);
});

test('the verifier ignores the `data` field that travels with a signature', async () => {
  const signed = await signer.sign(MESSAGE);
  // An attacker relabels an old signature as being for another message.
  const relabelled = { ...signed, data: 'I agree to something else' };
  assert.equal(verifyMidnightWalletSignature({ address: signer.address, networkId: NETWORK, messageText: 'I agree to something else', signed: relabelled }), false);
  // The label does not matter when the expected message is the real one.
  assert.equal(verifyMidnightWalletSignature({ address: signer.address, networkId: NETWORK, messageText: MESSAGE, signed: relabelled }), true);
});

test('a signature from a different seed fails against the first address', async () => {
  const signedByOther = await otherSigner.sign(MESSAGE);
  assert.equal(verifyMidnightWalletSignature({ address: signer.address, networkId: NETWORK, messageText: MESSAGE, signed: signedByOther }), false);
});

test('a correct signature paired with someone else\'s address fails', async () => {
  const signed = await signer.sign(MESSAGE);
  assert.equal(verifyMidnightWalletSignature({ address: otherSigner.address, networkId: NETWORK, messageText: MESSAGE, signed }), false);
});

test('someone else\'s signature with the victim\'s verifying key swapped in fails', async () => {
  const mine = await signer.sign(MESSAGE);
  const theirs = await otherSigner.sign(MESSAGE);
  const forged = { ...theirs, verifyingKey: mine.verifyingKey };
  assert.equal(verifyMidnightWalletSignature({ address: signer.address, networkId: NETWORK, messageText: MESSAGE, signed: forged }), false);
});

test('the same key on another network is a different address and does not verify across networks', async () => {
  const preprodSigner = createMidnightWalletSigner({ seedHex: TEST_SEED, networkId: 'preprod' });
  const signed = await signer.sign(MESSAGE);
  assert.notEqual(preprodSigner.address, signer.address);
  // Preprod-encoded address presented as a Preview wallet: refused.
  assert.equal(verifyMidnightWalletSignature({ address: preprodSigner.address, networkId: NETWORK, messageText: MESSAGE, signed }), false);
  // Checked consistently on preprod it is the same key, so it verifies.
  assert.equal(verifyMidnightWalletSignature({ address: preprodSigner.address, networkId: 'preprod', messageText: MESSAGE, signed }), true);
});

test('malformed input fails and never throws', async () => {
  const signed = await signer.sign(MESSAGE);
  const good = { address: signer.address, networkId: NETWORK, messageText: MESSAGE, signed };
  const malformedInputs = [
    undefined,
    {},
    { ...good, signed: null },
    { ...good, signed: 'not an object' },
    { ...good, signed: { ...signed, signature: 'zz' } },
    { ...good, signed: { ...signed, signature: signed.signature.slice(2) } },
    { ...good, signed: { ...signed, signature: signed.signature.toUpperCase() } },
    { ...good, signed: { ...signed, signature: 'f'.repeat(128) } },
    { ...good, signed: { ...signed, verifyingKey: '' } },
    { ...good, signed: { ...signed, verifyingKey: 'f'.repeat(64) } },
    { ...good, signed: { ...signed, verifyingKey: 12345 } },
    { ...good, signed: { ...signed, scheme: 'ed25519' } },
    { ...good, signed: { ...signed, scheme: 'constructor' } },
    { ...good, signed: { ...signed, scheme: 'ecdsa_secp256k1_sha256' } },
    { ...good, address: 'not-an-address' },
    { ...good, address: '' },
    { ...good, address: null },
    { ...good, address: `${signer.address.slice(0, -1)}q` },
    { ...good, networkId: '' },
    { ...good, networkId: 'mainnet-typo' },
    { ...good, messageText: null },
    { ...good, messageText: Buffer.from(MESSAGE) }
  ];
  for (const input of malformedInputs) {
    assert.equal(verifyMidnightWalletSignature(input), false);
  }
});

test('a shielded or DUST address is not accepted in place of an unshielded one', async () => {
  const signed = await signer.sign(MESSAGE);
  const sameBytesAsDustStyle = signer.address.replace('mn_addr_', 'mn_dust_');
  assert.equal(verifyMidnightWalletSignature({ address: sameBytesAsDustStyle, networkId: NETWORK, messageText: MESSAGE, signed }), false);
});

test('the signed bytes follow the DApp Connector prefix rule, counting BYTES not characters', () => {
  assert.equal(buildSignedMessageBytes('hello').toString('utf8'), 'midnight_signed_message:5:hello');
  // "é" is one character but two bytes in UTF-8.
  assert.equal(buildSignedMessageBytes('é').toString('utf8'), 'midnight_signed_message:2:é');
  assert.throws(() => buildSignedMessageBytes(42), TypeError);
});

test('independent check: the signature is BIP-340 Schnorr over SHA-256 of the prefixed bytes', async () => {
  // @noble/curves knows nothing about Midnight. If it accepts the signature,
  // the format is standard BIP-340, as the connector documents.
  const signed = await signer.sign(MESSAGE);
  const digest = createHash('sha256').update(buildSignedMessageBytes(MESSAGE)).digest();
  assert.equal(schnorr.verify(Buffer.from(signed.signature, 'hex'), digest, Buffer.from(signed.verifyingKey, 'hex')), true);
});

test('an ECDSA signature (the connector\'s other scheme) verifies against its own address', () => {
  // The headless signer only makes Schnorr signatures, but a browser wallet
  // may return ECDSA, so the verifier must handle both. Random throwaway key.
  const signingKey = sampleSigningKey('ecdsa');
  const verifyingKey = signatureVerifyingKey(signingKey);
  const address = MidnightBech32m.encode(NETWORK, new UnshieldedAddress(Buffer.from(addressFromKey(verifyingKey), 'hex'))).asString();
  const signed = { scheme: 'ecdsa_secp256k1_sha256', signature: signData(signingKey, buildSignedMessageBytes(MESSAGE)).value, verifyingKey: verifyingKey.value };
  assert.equal(verifyMidnightWalletSignature({ address, networkId: NETWORK, messageText: MESSAGE, signed }), true);
  assert.equal(verifyMidnightWalletSignature({ address, networkId: NETWORK, messageText: 'other', signed }), false);
  assert.equal(verifyMidnightWalletSignature({ address: signer.address, networkId: NETWORK, messageText: MESSAGE, signed }), false);
});

test('the signer refuses a seed that is not 64 hex characters, without echoing it', () => {
  assert.throws(() => createMidnightWalletSigner({ seedHex: 'abc', networkId: NETWORK }), (error) => error instanceof TypeError && !error.message.includes('abc'));
  assert.throws(() => createMidnightWalletSigner({ seedHex: TEST_SEED, networkId: '' }), TypeError);
});
