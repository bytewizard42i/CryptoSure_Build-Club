// ============================================================================
// Tests for src/connector-wallet-signer.mjs, against a FAKE wallet
// ============================================================================
// The fake below stands in for a browser wallet's DApp Connector API. It
// signs the way the specification says a wallet must (prefix + data, with
// the unshielded key). This proves the ADAPTER is wired correctly. It does
// NOT prove a real wallet behaves the same: UNTESTED-IN-BROWSER.
// ============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import { createConnectorWalletSigner } from '../src/connector-wallet-signer.mjs';
import { createMidnightWalletSigner, verifyMidnightWalletSignature } from '../src/midnight-wallet-signer.mjs';

// FIXED THROWAWAY TEST SEED (not a secret).
const TEST_SEED = `${'0'.repeat(63)}1`;
const NETWORK = 'preview';

// A fake ConnectedAPI with only the two methods the adapter uses.
function createFakeConnectedApi({ dropScheme = false, uppercaseHex = false } = {}) {
  const headless = createMidnightWalletSigner({ seedHex: TEST_SEED, networkId: NETWORK });
  const calls = [];
  return {
    calls,
    address: headless.address,
    async getUnshieldedAddress() {
      return { unshieldedAddress: headless.address };
    },
    async signData(data, options) {
      calls.push({ data, options });
      const signed = await headless.sign(data);
      if (dropScheme) delete signed.scheme;
      if (uppercaseHex) {
        signed.signature = signed.signature.toUpperCase();
        signed.verifyingKey = signed.verifyingKey.toUpperCase();
      }
      return signed;
    }
  };
}

test('the adapter asks the wallet for a text signature with the unshielded key', async () => {
  const fakeApi = createFakeConnectedApi();
  const signer = await createConnectorWalletSigner(fakeApi);
  assert.equal(signer.address, fakeApi.address);
  await signer.sign('hello wallet');
  assert.deepEqual(fakeApi.calls, [{ data: 'hello wallet', options: { encoding: 'text', keyType: 'unshielded' } }]);
});

test('a signature obtained through the adapter verifies against the wallet address', async () => {
  const signer = await createConnectorWalletSigner(createFakeConnectedApi());
  const signed = await signer.sign('hello wallet');
  assert.equal(verifyMidnightWalletSignature({ address: signer.address, networkId: NETWORK, messageText: 'hello wallet', signed }), true);
  assert.equal(verifyMidnightWalletSignature({ address: signer.address, networkId: NETWORK, messageText: 'hello walle', signed }), false);
});

test('a wallet that omits `scheme` or returns uppercase hex is normalised', async () => {
  const signer = await createConnectorWalletSigner(createFakeConnectedApi({ dropScheme: true, uppercaseHex: true }));
  const signed = await signer.sign('hello wallet');
  assert.equal(signed.scheme, 'schnorr_bip340');
  assert.equal(verifyMidnightWalletSignature({ address: signer.address, networkId: NETWORK, messageText: 'hello wallet', signed }), true);
});

test('the adapter fails loudly on something that is not a connected wallet', async () => {
  await assert.rejects(() => createConnectorWalletSigner(null), TypeError);
  await assert.rejects(() => createConnectorWalletSigner({ signData() {} }), TypeError);
  await assert.rejects(
    () => createConnectorWalletSigner({ signData: async () => ({}), getUnshieldedAddress: async () => ({ unshieldedAddress: 'mn_shield-addr_preview1xyz' }) }),
    /did not return an unshielded address/
  );
});

test('the adapter fails loudly when the wallet returns no signature, and passes on a user refusal', async () => {
  const noSignature = await createConnectorWalletSigner({ ...createFakeConnectedApi(), signData: async () => ({ data: 'x' }) });
  await assert.rejects(() => noSignature.sign('hello'), /not a signature/);
  await assert.rejects(() => noSignature.sign(42), TypeError);

  const refusing = await createConnectorWalletSigner({ ...createFakeConnectedApi(), signData: async () => { throw new Error('User rejected the request'); } });
  await assert.rejects(() => refusing.sign('hello'), /User rejected/);
});
