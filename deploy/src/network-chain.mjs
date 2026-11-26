// ============================================================================
// network-chain.mjs — the compiled contracts, run on a REAL Midnight network
// ============================================================================
// WHAT THIS IS
//   The network twin of protocol/local-chain.mjs. It offers the same small
//   set of operations (deploy, call, publicLedger, pureCircuits, now), so the
//   protocol code written for the local stand-in (protocol/clearance.mjs,
//   protocol/bind-policy.mjs) runs UNCHANGED against a network. That file's
//   header names this as the intended seam.
//
// WHAT IS DIFFERENT FROM THE LOCAL STAND-IN
//   - Every deploy and every call is a real transaction: the circuit is run
//     locally, a zero-knowledge proof is produced by the proof server, the
//     wallet pays the fee in DUST, the node receives it, and we wait until
//     the INDEXER reports it in a block. Each takes tens of seconds.
//   - call() also returns the transaction id and block height.
//   - publicLedger() must stay synchronous (the protocol code calls it that
//     way), so this class keeps a cached copy of each contract's public state
//     and refreshes ALL of them from the indexer after every call it makes.
//   - `now` is the computer's clock minus a small safety margin. Contracts
//     assert "issued_at is not in the future" against the BLOCK's time, and
//     our clock may run slightly ahead of the chain's.
//   - There is no advanceTime(): nobody can move a real chain's clock.
//
// HOW AN ACTOR'S PRIVATE INPUTS REACH THE WITNESSES
//   Midnight.js reads private state from the private-state provider under an
//   id. Before each call we store the caller's private inputs under one fixed
//   id for that contract, then make the call with that id. Calls are made one
//   at a time, so one slot is enough.
//
// REFERENCES (installed type definitions)
//   @midnight-ntwrk/midnight-js-contracts: deployContract,
//     createCircuitCallTxInterface, TxFailedError (README "Handling Errors")
//   @midnight-ntwrk/midnight-js-contracts README "State Queries": decode a
//     contract state with YOUR OWN runtime's ContractState.
//
// IDEAS, NOT BUILT
//   IDEA: submit independent calls in parallel (needs several DUST coins).
//   IDEA: retry a call once when the node rejects it for a stale state.
// ============================================================================

import { ContractState, encodeContractAddress } from '@midnight-ntwrk/compact-runtime';
import { createCircuitCallTxInterface, deployContract } from '@midnight-ntwrk/midnight-js-contracts';
// The SAME error class the protocol code catches, so `instanceof` works there.
// (Importing this file also loads the repository root's copy of the Compact
// runtime; that copy is not used for anything here.)
import { ContractRejectedError } from '../../protocol/local-chain.mjs';
import { loadCompiledContract } from './compiled-contracts.mjs';

export { ContractRejectedError };

// The slot in the private-state database that holds "whoever is calling now".
const CALLER_PRIVATE_STATE_ID = 'cryptosure-current-caller';

// How far behind the computer's clock `now` is reported (see header).
const CLOCK_SAFETY_MARGIN_SECONDS = 30;

// A contract `assert` that fails while the circuit runs locally arrives
// wrapped by the runtime as "... failed assert: <the contract's sentence>".
const FAILED_ASSERT_PATTERN = /failed assert:\s*/i;

// ----------------------------------------------------------------------------
// Throttle-aware retry
// ----------------------------------------------------------------------------
// Midnight nodes rate-limit each account (pallet_throttle): too many bytes in
// too short a window and the node rejects a transaction AT VALIDATION with
// "1010: Invalid Transaction: Transaction would exhaust the block limits".
// A validation rejection never reached a block, so re-sending the SAME
// transaction later is safe: nothing was applied, nothing can be applied
// twice. Large deploy transactions are the ones most likely to hit the cap,
// and the cap refills with time, so the right answer is to wait and try
// again rather than to fail the whole deployment run.
const THROTTLE_REJECTION_PATTERN = /exhaust the block limits/i;

// How long to wait before trying again, and how many times. The window length
// is not documented, so these are generous: worst case one transaction waits
// about fifteen minutes before the run gives up.
const THROTTLE_RETRY_DELAY_MS = 65_000;
const THROTTLE_RETRY_ATTEMPTS = 15;

/** Every message in an error's cause chain, concatenated, for pattern checks. */
function deepErrorText(error) {
  const parts = [];
  for (let current = error; current; current = current.cause) {
    if (current.message) parts.push(String(current.message));
  }
  return parts.join(' | ');
}

function isThrottleRejection(error) {
  return THROTTLE_REJECTION_PATTERN.test(deepErrorText(error));
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

/**
 * Run `operation`, retrying when - and only when - the node rejects it at
 * validation for exhausting the per-account throttle. Any other error
 * (a contract assert, a missing proof server, a real failure) is thrown
 * straight away: retrying those would only waste time and hide the cause.
 */
async function withThrottleRetry(label, operation) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isThrottleRejection(error) || attempt >= THROTTLE_RETRY_ATTEMPTS) throw error;
      console.log(
        `  throttle: the node is rate-limiting this account; waiting ` +
        `${THROTTLE_RETRY_DELAY_MS / 1000}s before retry ${attempt + 1}/${THROTTLE_RETRY_ATTEMPTS} of ${label}`
      );
      await sleep(THROTTLE_RETRY_DELAY_MS);
    }
  }
}

function contractRejectionMessage(error) {
  return String(error?.message ?? error).replace(/^.*failed assert:\s*/is, '').trim();
}

// Walk an error's `cause` chain looking for a failed contract assert.
function findFailedAssert(error) {
  for (let current = error, depth = 0; current != null && depth < 8; current = current.cause, depth += 1) {
    if (FAILED_ASSERT_PATTERN.test(String(current.message ?? current))) return current;
  }
  return null;
}

export class NetworkChain {
  #providerFactory;
  // address -> { name, loaded contract, cached public ledger }
  #deployed = new Map();
  #onTransaction;

  /** Every transaction this object has sent, in order: what a block explorer would show. */
  transcript = [];

  /**
   * @param {{providerFactory: object, onTransaction?: (entry: object) => void}} input
   *        providerFactory from providers.mjs createProviderFactory()
   */
  constructor({ providerFactory, onTransaction = () => {} }) {
    this.#providerFactory = providerFactory;
    this.#onTransaction = onTransaction;
  }

  /** "Now" in unix seconds, as safe to hand to a contract (see header). */
  get now() {
    return Math.floor(Date.now() / 1000) - CLOCK_SAFETY_MARGIN_SECONDS;
  }

  /** The value a contract stores or receives when it refers to another contract. */
  static contractReference(address) {
    return { bytes: encodeContractAddress(address) };
  }

  /** The pure helper circuits of a contract that need not be deployed yet. */
  static async pureCircuitsOf(contractName) {
    return (await loadCompiledContract(contractName)).module.pureCircuits;
  }

  #entry(address) {
    const entry = this.#deployed.get(address);
    if (entry === undefined) throw new TypeError(`This program has no contract at address ${address}.`);
    return entry;
  }

  // address -> compiled module, for every contract we know, so a call that
  // reaches into another contract can find its code.
  #modulesByAddress() {
    return new Map([...this.#deployed].map(([address, entry]) => [address, entry.loaded.module]));
  }

  #providersFor(entry) {
    return this.#providerFactory.withContractModules(this.#providerFactory.forContract(entry.loaded), this.#modulesByAddress());
  }

  #record(entry) {
    this.transcript.push(entry);
    this.#onTransaction(entry);
  }

  /**
   * Deploy one contract. Returns its address and the deploy transaction.
   * Every CryptoSure contract's constructor takes one argument: the first
   * admin's role key.
   */
  async deploy(contractName, ...constructorArguments) {
    const loaded = await loadCompiledContract(contractName);
    const deployed = await withThrottleRetry(`deploy ${contractName}`, () => deployContract(this.#providerFactory.forContract(loaded), {
      compiledContract: loaded.compiledContract,
      // The constructor reads no witnesses; an empty private state is stored
      // so later calls have a slot to overwrite.
      privateStateId: CALLER_PRIVATE_STATE_ID,
      initialPrivateState: {},
      args: constructorArguments
    }));
    const { contractAddress, txId, blockHeight, status } = deployed.deployTxData.public;
    if (status !== 'SucceedEntirely') {
      throw new Error(`Deploying ${contractName} was included in block ${blockHeight} but did NOT succeed (status "${status}", tx ${txId}).`);
    }
    this.#deployed.set(contractAddress, { name: contractName, loaded, ledger: null });
    await this.refreshPublicLedger(contractAddress);
    const entry = { kind: 'deploy', contract: contractName, address: contractAddress, transactionId: txId, blockHeight };
    this.#record(entry);
    return entry;
  }

  /**
   * Tell this object about a contract that is ALREADY deployed (from the
   * deployment record). Confirms with the indexer that it exists.
   */
  async attach(contractName, address) {
    const loaded = await loadCompiledContract(contractName);
    this.#deployed.set(address, { name: contractName, loaded, ledger: null });
    await this.refreshPublicLedger(address);
  }

  /** Re-read one contract's public state from the indexer into the cache. */
  async refreshPublicLedger(address) {
    const entry = this.#entry(address);
    const read = await this.#providerFactory.shared.publicDataProvider.queryContractState(address);
    if (read === null) {
      throw new Error(
        `The indexer knows no contract at ${address} (expected ${entry.name}).\n` +
        'Next step: check that deployments/<network>.json belongs to this network and that the indexer is caught up.'
      );
    }
    // Decoded with deploy/'s own runtime copy, the one the contract module uses.
    entry.ledger = entry.loaded.module.ledger(read.contractState.deserialize({ v9: ContractState }).data);
    return entry.ledger;
  }

  async #refreshAllPublicLedgers() {
    for (const address of this.#deployed.keys()) await this.refreshPublicLedger(address);
  }

  /**
   * Run one circuit of one contract as one actor, as a real transaction.
   *
   * @param {string} address            where the contract is deployed
   * @param {object} actorPrivateState  the caller's private inputs (see witnesses.mjs)
   * @param {string} circuitName        the exported circuit to run
   * @returns {{result: any, callTrace: string[], transactionId: string, blockHeight: number}}
   * @throws ContractRejectedError if a contract assert fails (nothing is sent)
   */
  async call(address, actorPrivateState, circuitName, ...circuitArguments) {
    const entry = this.#entry(address);
    const providers = this.#providersFor(entry);

    await providers.privateStateProvider.forContract(address).set(CALLER_PRIVATE_STATE_ID, actorPrivateState);
    const callTransaction = createCircuitCallTxInterface(providers, entry.loaded.compiledContract, address, CALLER_PRIVATE_STATE_ID)[circuitName];
    if (callTransaction === undefined) throw new TypeError(`${entry.name} has no circuit named "${circuitName}".`);

    let finalized;
    try {
      finalized = await withThrottleRetry(`${entry.name}.${circuitName}`, () => callTransaction(...circuitArguments));
    } catch (error) {
      const failedAssert = findFailedAssert(error);
      if (failedAssert !== null) throw new ContractRejectedError(contractRejectionMessage(failedAssert));
      // Anything else (no DUST, proof server down, node refused) is NOT the
      // contract saying no. Say which call it was and keep the cause.
      throw new Error(`${entry.name}.${circuitName} could not be sent: ${error.message}`, { cause: error });
    }

    // The indexer reports how the chain judged the transaction. Anything
    // other than complete success means its effects did not (all) happen.
    if (finalized.public.status !== 'SucceedEntirely') {
      throw new Error(
        `${entry.name}.${circuitName} was included in block ${finalized.public.blockHeight} but did NOT succeed ` +
        `(status "${finalized.public.status}", tx ${finalized.public.txId}).`
      );
    }

    await this.#refreshAllPublicLedgers();
    const transcriptEntry = {
      kind: 'call',
      contract: entry.name,
      circuit: circuitName,
      address,
      transactionId: finalized.public.txId,
      blockHeight: finalized.public.blockHeight,
      status: finalized.public.status
    };
    this.#record(transcriptEntry);
    return {
      result: finalized.private.result,
      callTrace: this.#callTraceOf(finalized, entry, circuitName),
      transactionId: finalized.public.txId,
      blockHeight: finalized.public.blockHeight
    };
  }

  // Which circuits ran, across all contracts, as "Contract.circuit".
  // Midnight.js lists every contract call made while the circuit ran in
  // `calls`: cross-contract callees first, the circuit we called last.
  // Reference: @midnight-ntwrk/midnight-js-contracts, Ledger9CallResult.calls.
  #callTraceOf(finalized, entry, circuitName) {
    if (!Array.isArray(finalized.calls)) return [`${entry.name}.${circuitName}`];
    return finalized.calls.map((step) => `${this.#deployed.get(step.contractAddress)?.name ?? '?'}.${step.circuitId}`);
  }

  /** Read-only view of one contract's public ledger, as of the last refresh. */
  publicLedger(address) {
    const entry = this.#entry(address);
    if (entry.ledger === null) throw new Error(`The public state of ${entry.name} has not been read yet.`);
    return entry.ledger;
  }

  /** The pure helper circuits a contract exports (hashes and commitments). */
  pureCircuits(address) {
    return this.#entry(address).loaded.module.pureCircuits;
  }
}
