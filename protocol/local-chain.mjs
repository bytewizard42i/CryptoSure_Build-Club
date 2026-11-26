// ============================================================================
// local-chain.mjs — the compiled CryptoSure contracts, run on this computer
// ============================================================================
// WHAT THIS IS
//   A tiny stand-in for a blockchain. It holds the public state of each
//   deployed contract in memory and runs the REAL compiled contract code
//   against it (the JavaScript the Compact compiler produced in build/).
//   Every `assert` in every contract runs for real: a call the network would
//   reject throws here, with the contract's own message.
//
// WHAT THIS IS NOT
//   A network. Nothing is submitted anywhere, no zero-knowledge proof is
//   generated, and no fee is paid. It answers one question: "would the
//   contracts accept this?" Deploying to a Midnight test network is a
//   separate step (see README, "What is real and what is simulated").
//
// HOW ONE CONTRACT CALLS ANOTHER HERE
//   When a circuit calls a circuit in a different contract, the Compact
//   runtime asks two things of us:
//     stateProvider   "what is the public state of the contract at address X?"
//     moduleProvider  "which compiled code is deployed at address X?"
//   We answer both from the tables below. The runtime also insists that the
//   called contract carries a VERIFIER KEY for the circuit being called,
//   which is why the contracts must be compiled with keys (npm run compile),
//   not in fast mode.
//   Reference: @midnight-ntwrk/compact-runtime, createCircuitContext
//   (`crossContract` option) and crossContractCall.
//
// TIME
//   Contracts compare against the block time but cannot read a clock. Here
//   the "block time" is `chain.now`, in unix seconds, and tests move it
//   forward with advanceTime() to watch passes and clearances expire.
//
// IDEAS, NOT BUILT
//   - a second implementation of this same class that talks to a real
//     network through Midnight.js, so the protocol code above it does not
//     change (this file is the seam)
//   - recording every call as a transcript for a block-explorer style view
// ============================================================================

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  ChargedState,
  ContractOperation,
  createCircuitContext,
  createConstructorContext,
  encodeContractAddress,
  sampleContractAddress
} from '@midnight-ntwrk/compact-runtime';

const BUILD_FOLDER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'build');

// Unused by these contracts (they move no shielded coins) but the runtime
// requires a value.
const PLACEHOLDER_COIN_PUBLIC_KEY = '0'.repeat(64);
// Any constant will do locally; on a network this is the latest block's hash.
const PLACEHOLDER_PARENT_BLOCK_HASH = '0'.repeat(64);

export class ContractRejectedError extends Error {}

export class ContractsNotCompiledError extends Error {}

// A Merkle path proves "this leaf is in the tree". If the leaf is NOT there,
// an honest device has nothing to offer. Rather than fail in JavaScript, we
// hand the circuit a made-up path. It hashes to a root the ledger has never
// seen, so the CONTRACT is what says no. That keeps the refusal where it
// belongs and lets tests prove the contract enforces it.
function findPathOrDecoy(tree, leaf, treeDepth) {
  return tree.findPathForLeaf(leaf) ?? {
    leaf,
    path: Array.from({ length: treeDepth }, () => ({ sibling: { field: 0n }, goes_left: false }))
  };
}

// ---------------------------------------------------------------------------
// WITNESSES: the private inputs a contract asks the caller's device for.
// Each receives the caller's private state and returns [privateState, value].
// One table serves every contract; a contract only ever calls the ones it
// declared. Nothing returned here is written on-chain unless the contract
// explicitly discloses it.
// ---------------------------------------------------------------------------
const WITNESSES = {
  // lib/Common
  local_secret_key: ({ privateState }) => [privateState, privateState.secretKey],
  // lib/Ticket
  get_wallet_hash: ({ privateState }) => [privateState, privateState.walletHash],
  get_ticket_salt: ({ privateState }) => [privateState, privateState.ticketSalt],
  // BanListCheck
  get_list_version: ({ privateState }) => [privateState, privateState.listVersion],
  get_screening_path: ({ privateState, ledger }, leaf) => [privateState, findPathOrDecoy(ledger.screenings, leaf, 16)],
  // RegionCheck
  get_region_attestation: ({ privateState }) => [privateState, privateState.regionAttestation],
  get_region_attestation_salt: ({ privateState }) => [privateState, privateState.regionAttestationSalt],
  get_region_attestation_path: ({ privateState, ledger }, leaf) => [privateState, findPathOrDecoy(ledger.attestations, leaf, 16)],
  get_allowed_region_path: ({ privateState, ledger }, leaf) => [privateState, findPathOrDecoy(ledger.allowedRegions, leaf, 8)],
  // IdentityCheck
  get_identity_credential: ({ privateState }) => [privateState, privateState.identityCredential],
  get_identity_credential_salt: ({ privateState }) => [privateState, privateState.identityCredentialSalt],
  get_identity_credential_path: ({ privateState, ledger }, leaf) => [privateState, findPathOrDecoy(ledger.credentials, leaf, 16)],
  // EducationCheck
  get_education_certificate: ({ privateState }) => [privateState, privateState.educationCertificate],
  get_education_certificate_salt: ({ privateState }) => [privateState, privateState.educationCertificateSalt],
  get_education_certificate_path: ({ privateState, ledger }, leaf) => [privateState, findPathOrDecoy(ledger.certificates, leaf, 16)],
  // WalletControlCheck
  get_control_attestation: ({ privateState }) => [privateState, privateState.controlAttestation],
  get_control_attestation_salt: ({ privateState }) => [privateState, privateState.controlAttestationSalt],
  get_control_attestation_path: ({ privateState, ledger }, leaf) => [privateState, findPathOrDecoy(ledger.attestations, leaf, 16)],
  // PolicyBinder
  get_binding_salt: ({ privateState }) => [privateState, privateState.bindingSalt],
  get_binding_path: ({ privateState, ledger }, leaf) => [privateState, findPathOrDecoy(ledger.bindings, leaf, 16)]
};

// The compiled module for a contract, loaded once and reused.
const loadedModules = new Map();

export async function loadContractModule(contractName) {
  if (loadedModules.has(contractName)) return loadedModules.get(contractName);
  const modulePath = path.join(BUILD_FOLDER, contractName, 'contract', 'index.js');
  const keysFolder = path.join(BUILD_FOLDER, contractName, 'keys');
  if (!existsSync(modulePath) || !existsSync(keysFolder)) {
    throw new ContractsNotCompiledError(
      `The contract "${contractName}" has not been compiled with keys. Run "npm run compile" (about a minute) and try again.`
    );
  }
  const compiled = await import(modulePath);
  loadedModules.set(contractName, compiled);
  return compiled;
}

// The contract's assert messages arrive wrapped by the runtime; keep only
// the sentence the contract author wrote.
function contractRejectionMessage(error) {
  return String(error?.message ?? error).replace(/^.*failed assert:\s*/is, '').trim();
}

export class LocalChain {
  // address -> { name, compiled module, ContractState }
  #deployed = new Map();

  /** The simulated block time, in unix seconds. */
  now;

  constructor({ startTime = Math.floor(Date.now() / 1000) } = {}) {
    this.now = startTime;
  }

  /** Move the simulated clock forward. */
  advanceTime(seconds) {
    if (!Number.isInteger(seconds) || seconds < 0) throw new RangeError('advanceTime needs a whole number of seconds, zero or more.');
    this.now += seconds;
  }

  /**
   * Deploy one contract and return its address (a hex string).
   * Its verifier keys are attached, as a real deployment would attach them.
   */
  async deploy(contractName) {
    const compiled = await loadContractModule(contractName);
    const contract = new compiled.Contract(WITNESSES);
    const initial = await contract.initialState(createConstructorContext({}, PLACEHOLDER_COIN_PUBLIC_KEY));
    const contractState = initial.currentContractState;

    const keysFolder = path.join(BUILD_FOLDER, contractName, 'keys');
    for (const fileName of readdirSync(keysFolder).filter((name) => name.endsWith('.verifier'))) {
      const operation = new ContractOperation();
      operation.verifierKey = readFileSync(path.join(keysFolder, fileName));
      contractState.setOperation(fileName.replace(/\.verifier$/, ''), operation);
    }

    const address = sampleContractAddress();
    this.#deployed.set(address, { name: contractName, compiled, contract, contractState });
    return address;
  }

  /** The value a contract stores or receives when it refers to another contract. */
  static contractReference(address) {
    return { bytes: encodeContractAddress(address) };
  }

  #entry(address) {
    const entry = this.#deployed.get(address);
    if (entry === undefined) throw new TypeError(`Nothing is deployed at address ${address}.`);
    return entry;
  }

  /**
   * Run one circuit of one contract as one actor.
   *
   * On success every contract touched by the call (the one called, and any it
   * called in turn) moves to its new state, and the circuit's result is
   * returned. On a contract assert NOTHING changes anywhere and
   * ContractRejectedError carries the contract's message.
   *
   * @param {string} address        where the contract is deployed
   * @param {object} actorPrivateState  the caller's private inputs (see WITNESSES)
   * @param {string} circuitName    the exported circuit to run
   */
  async call(address, actorPrivateState, circuitName, ...circuitArguments) {
    const entry = this.#entry(address);
    const circuit = entry.contract.impureCircuits[circuitName];
    if (circuit === undefined) throw new TypeError(`${entry.name} has no circuit named "${circuitName}".`);

    const context = createCircuitContext({
      circuitId: circuitName,
      contractAddress: address,
      coinPublicKeyOrZswapState: PLACEHOLDER_COIN_PUBLIC_KEY,
      contractState: entry.contractState,
      privateState: actorPrivateState,
      time: this.now,
      parentBlockHash: PLACEHOLDER_PARENT_BLOCK_HASH,
      crossContract: {
        stateProvider: { getContractState: async (_blockHash, queried) => this.#deployed.get(queried)?.contractState },
        moduleProvider: {
          resolve: (queried) => {
            const callee = this.#deployed.get(queried);
            return callee === undefined ? undefined : async () => callee.compiled;
          }
        }
      }
    });

    let outcome;
    try {
      outcome = await circuit(context, ...circuitArguments);
    } catch (error) {
      throw new ContractRejectedError(contractRejectionMessage(error));
    }

    // Commit: every contract in the call tree advances together.
    for (const [touchedAddress, queryContext] of Object.entries(outcome.context.queryContexts)) {
      this.#entry(touchedAddress).contractState.data = new ChargedState(queryContext.state.state);
    }
    return {
      result: outcome.result,
      // Which circuits ran, in order, across all contracts. Handy for showing
      // that one transaction really did consult several contracts.
      callTrace: outcome.context.callProofDataTrace.map((step) => `${this.#deployed.get(step.contractAddress)?.name ?? '?'}.${step.circuitId}`)
    };
  }

  /** Read-only view of one contract's public ledger: what anyone watching the chain sees. */
  publicLedger(address) {
    const entry = this.#entry(address);
    return entry.compiled.ledger(entry.contractState.data);
  }

  /**
   * The raw bytes of one contract's whole public state, exactly as a node
   * would store them. Tests search these bytes to prove that something
   * private (an address, a wallet hash) is NOT on-chain.
   */
  serializedPublicState(address) {
    return Buffer.from(this.#entry(address).contractState.serialize());
  }

  /** The pure helper circuits a contract exports (hashes and commitments). */
  pureCircuits(address) {
    return this.#entry(address).compiled.pureCircuits;
  }
}
