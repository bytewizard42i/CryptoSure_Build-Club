// ============================================================================
// LocalWalletBinderChain — the compiled WalletBinder contract, run locally.
// ============================================================================
// WHAT THIS IS
//   The real contract code (compiled from contracts/WalletBinder.compact),
//   executed in this process against an in-memory copy of its ledger. Every
//   assert in the contract runs for real: a call that would be rejected
//   on-chain throws here with the contract's own message.
//
// WHAT THIS IS NOT
//   A network. No transaction is submitted, no ZK proof is generated, and no
//   tokens are spent. It answers "does the contract accept this?", which is
//   the question the MVP needs. Deploying to Midnight Preview is a later step.
//
// HOW CALLERS ARE TOLD APART
//   The contract identifies a caller by a public key derived from a secret
//   key that only the caller's device holds (the local_secret_key witness).
//   So "acting as the issuer" just means running a circuit with the issuer's
//   private state. One ledger, many actors.
// ============================================================================

import {
  createConstructorContext,
  createCircuitContext,
  dummyContractAddress
} from '@midnight-ntwrk/compact-runtime';
import { Contract, ledger, pureCircuits } from '../build/walletbinder/contract/index.js';

export { pureCircuits };

// Unused for this contract (it moves no shielded coins) but required by the runtime.
const PLACEHOLDER_COIN_PUBLIC_KEY = '0'.repeat(64);

// A Merkle path proves "this leaf is in the tree". If the leaf is NOT there,
// an honest wallet has nothing to offer. Rather than fail in JavaScript, we
// hand the circuit a made-up path (all-zero siblings). It hashes to a root
// the ledger has never seen, so the CONTRACT is what says no.
function findPathOrDecoy(tree, leaf, treeDepth) {
  return tree.findPathForLeaf(leaf) ?? {
    leaf,
    path: Array.from({ length: treeDepth }, () => ({ sibling: { field: 0n }, goes_left: false }))
  };
}

// Tree depths, as declared in WalletBinder.compact.
const CREDENTIAL_TREE_DEPTH = 16;
const JURISDICTION_TREE_DEPTH = 8;
const CLEARANCE_TREE_DEPTH = 16;
const BINDING_TREE_DEPTH = 16;

// Witnesses: private inputs the contract asks the caller's device for. Each
// one receives the caller's private state and returns [privateState, value].
const WITNESSES = {
  local_secret_key: ({ privateState }) => [privateState, privateState.secretKey],
  get_randomness: ({ privateState }) => [privateState, privateState.bindingSalt],
  get_credential: ({ privateState }) => [privateState, privateState.credential],
  get_credential_salt: ({ privateState }) => [privateState, privateState.credentialSalt],
  get_credential_path: ({ privateState, ledger: view }, leaf) => [privateState, findPathOrDecoy(view.kycCredentials, leaf, CREDENTIAL_TREE_DEPTH)],
  get_jurisdiction_path: ({ privateState, ledger: view }, leaf) => [privateState, findPathOrDecoy(view.allowedJurisdictions, leaf, JURISDICTION_TREE_DEPTH)],
  get_wallet_hash: ({ privateState }) => [privateState, privateState.walletHash],
  get_clearance_list_version: ({ privateState }) => [privateState, privateState.clearanceListVersion],
  get_clearance_path: ({ privateState, ledger: view }, leaf) => [privateState, findPathOrDecoy(view.screeningClearances, leaf, CLEARANCE_TREE_DEPTH)],
  get_binding_salt: ({ privateState }) => [privateState, privateState.bindingSalt],
  get_binding_path: ({ privateState, ledger: view }, leaf) => [privateState, findPathOrDecoy(view.walletBindings, leaf, BINDING_TREE_DEPTH)]
};

// The contract's assert messages arrive prefixed by the runtime; keep only
// the human sentence the contract author wrote.
function contractRejectionMessage(error) {
  return String(error?.message ?? error).replace(/^failed assert:\s*/i, '');
}

export class ContractRejectedError extends Error {}

export class LocalWalletBinderChain {
  #contract = new Contract(WITNESSES);
  #contractAddress = dummyContractAddress();
  #contractState;

  static async deploy() {
    const chain = new LocalWalletBinderChain();
    const initial = await chain.#contract.initialState(
      createConstructorContext({}, PLACEHOLDER_COIN_PUBLIC_KEY)
    );
    chain.#contractState = initial.currentContractState;
    return chain;
  }

  /**
   * Run one circuit as one actor. On success the ledger advances and the
   * circuit's return value comes back. On a contract assert, the ledger is
   * left untouched and ContractRejectedError carries the contract's message.
   */
  async call(actorPrivateState, circuitName, ...circuitArguments) {
    const circuit = this.#contract.impureCircuits[circuitName];
    if (circuit === undefined) throw new TypeError(`WalletBinder has no circuit named "${circuitName}".`);

    const context = createCircuitContext({
      circuitId: circuitName,
      contractAddress: this.#contractAddress,
      coinPublicKeyOrZswapState: PLACEHOLDER_COIN_PUBLIC_KEY,
      contractState: this.#contractState,
      privateState: actorPrivateState
    });

    let outcome;
    try {
      outcome = await circuit(context, ...circuitArguments);
    } catch (error) {
      throw new ContractRejectedError(contractRejectionMessage(error));
    }
    this.#contractState = outcome.context.queryContexts[this.#contractAddress].state;
    return outcome.result;
  }

  // Read-only view of the public ledger (what anyone watching the chain sees).
  publicLedger() {
    return ledger(this.#contractState);
  }
}
