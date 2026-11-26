// ============================================================================
// witnesses.mjs — the witness table, re-exported from the protocol
// ============================================================================
// The single source of truth is protocol/local-chain.mjs in the repository
// root. It is environment-independent: the same twenty functions answer the
// contracts' witness requests whether the "chain" is the local stand-in or
// the live network, because a witness only ever looks at the caller's private
// state and the contract's public ledger.
// ============================================================================

export { WITNESSES, findPathOrDecoy } from '../../protocol/local-chain.mjs';
