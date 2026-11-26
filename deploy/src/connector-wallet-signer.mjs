// ============================================================================
// connector-wallet-signer.mjs — the same signer, for a BROWSER wallet
// ============================================================================
// !! UNTESTED-IN-BROWSER !!
//   This adapter has only been run against a FAKE wallet in a unit test
//   (tests/connector-wallet-signer.test.mjs). It has never been connected to
//   a real wallet extension. Before relying on it, sign one message with a
//   real wallet (for example Lace) and confirm verifyMidnightWalletSignature
//   accepts it. The open question is whether the wallet signs byte-for-byte
//   what the specification says ("midnight_signed_message:<size>:" + data).
//
// WHAT IT IS
//   In a browser, a DApp does not hold keys. It asks the wallet through the
//   DApp Connector: `connectedApi.signData(text, { encoding: 'text',
//   keyType: 'unshielded' })`, and the wallet (after asking its user) returns
//   { data, signature, verifyingKey, scheme? }.
//   This file wraps that call in the same shape as the headless signer in
//   midnight-wallet-signer.mjs: { address, sign(messageText) }, so the rest
//   of the code does not care which kind of wallet it is talking to.
//
// REFERENCES
//   @midnightntwrk/dapp-connector-api 4.1.0, dist/api.d.ts:
//     signData(data: string, options: SignDataOptions): Promise<Signature>
//     SignDataOptions = { encoding: 'hex' | 'base64' | 'text', keyType: 'unshielded' }
//     getUnshieldedAddress(): Promise<{ unshieldedAddress: string }>
//
// IDEAS, NOT BUILT
//   IDEA: a small browser page that connects to window.midnight.<wallet>,
//         signs a challenge and shows whether it verifies; that page would
//         turn UNTESTED-IN-BROWSER into tested.
// ============================================================================

/**
 * @param {object} connectedApi  a DApp Connector ConnectedAPI (what
 *        `await window.midnight.<wallet>.connect(networkId)` resolves to)
 * @returns {Promise<{address: string, sign(messageText: string): Promise<object>}>}
 */
export async function createConnectorWalletSigner(connectedApi) {
  if (connectedApi === null || typeof connectedApi !== 'object' || typeof connectedApi.signData !== 'function' || typeof connectedApi.getUnshieldedAddress !== 'function') {
    throw new TypeError('createConnectorWalletSigner needs a connected DApp Connector API (with signData and getUnshieldedAddress).');
  }

  const { unshieldedAddress } = await connectedApi.getUnshieldedAddress();
  if (typeof unshieldedAddress !== 'string' || !unshieldedAddress.startsWith('mn_addr_')) {
    throw new Error('The wallet did not return an unshielded address (expected text starting with "mn_addr_").');
  }

  return {
    address: unshieldedAddress,
    async sign(messageText) {
      if (typeof messageText !== 'string') throw new TypeError('The message to sign must be a string.');
      // 'text' = sign the string as UTF-8; the wallet adds the prefix itself.
      const signed = await connectedApi.signData(messageText, { encoding: 'text', keyType: 'unshielded' });
      if (signed === null || typeof signed !== 'object' || typeof signed.signature !== 'string' || typeof signed.verifyingKey !== 'string') {
        throw new Error('The wallet returned something that is not a signature (expected { signature, verifyingKey, ... }).');
      }
      // Hand back only the fields a verifier uses, normalised to lowercase hex.
      return {
        scheme: signed.scheme ?? 'schnorr_bip340',
        data: signed.data,
        signature: signed.signature.toLowerCase(),
        verifyingKey: signed.verifyingKey.toLowerCase()
      };
    }
  };
}
