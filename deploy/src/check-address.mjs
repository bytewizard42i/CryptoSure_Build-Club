// ============================================================================
// check-address.mjs — does the new Wallet SDK give the same address as before?
// ============================================================================
// WHY
//   The deployer seed was first used with Wallet SDK 1.2.0 (ledger 8). The
//   networks now run ledger 9 and need Wallet SDK 2.x. If 2.x derived keys
//   from a different place in the key tree, the same seed would open a
//   DIFFERENT wallet and any funds would appear to have vanished. This script
//   proves they are the same wallet, without using the network.
//
// RUN
//   npm run check-address
//
// It prints addresses (public) and never the seed.
// ============================================================================

import { readDeployerSeedHex } from './seed-file.mjs';
import { deriveWalletKeys } from './wallet.mjs';

// Derived on an earlier date with Wallet SDK 1.2.0 for the same seed.
const PREPROD_ADDRESS_FROM_OLD_SDK = 'mn_addr_preprod17jsz4gpr2t3qsw3nmw2hert4tc0ltu84d86lnc45rjgv4cp8muwsxplsm2';

const seedHex = readDeployerSeedHex();
const preprodAddress = deriveWalletKeys({ seedHex, networkId: 'preprod' }).unshieldedAddress;
const previewAddress = deriveWalletKeys({ seedHex, networkId: 'preview' }).unshieldedAddress;

console.log('Unshielded address, network "preprod":');
console.log(`  Wallet SDK 2.x (now): ${preprodAddress}`);
console.log(`  Wallet SDK 1.2.0    : ${PREPROD_ADDRESS_FROM_OLD_SDK}`);

if (preprodAddress !== PREPROD_ADDRESS_FROM_OLD_SDK) {
  console.log('RESULT: MISMATCH');
  console.log('The two SDKs derive different keys from this seed. Likely causes: a different');
  console.log('account/role/index in the key tree, or a different signature scheme. Do not send');
  console.log('funds until this is understood.');
  process.exitCode = 1;
} else {
  console.log('RESULT: MATCH (same wallet under both SDK versions)');
}

console.log('\nUnshielded address, network "preview" (the same key, encoded for Preview):');
console.log(`  ${previewAddress}`);
