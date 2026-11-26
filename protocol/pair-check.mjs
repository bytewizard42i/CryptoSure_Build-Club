// ============================================================================
// pair-check.mjs — "is it sensible to send from this wallet to that one?"
// ============================================================================
// ADVICE ONLY
//   This looks at two wallets, a sender and a receiver, and says what is
//   known about each. It does not touch the transfer. Nothing is held,
//   blocked or routed through CryptoSure, and the sender is free to ignore
//   the advice.
//
// PER WALLET, ONE OF THREE ANSWERS
//   clear        it holds a current clearance, and the ban list is still clean
//   unsure       never cleared, or its clearance ran out, or the ban list
//                cannot say
//   not-cleared  it is on the ban list right now
//
// WHY THE BAN LIST IS ASKED AGAIN EVERY TIME
//   A clearance is a point-in-time fact. A wallet cleared yesterday can be
//   listed today. The ban list is the cheapest check and the one that goes
//   stale fastest, so it is re-asked live; the slower checks are trusted for
//   their shelf life.
//
// THE ADVICE
//   proceed   both clear. A dated receipt is issued on-chain (PairReceipt).
//   caution   at least one unsure, none not-cleared.
//   stop      at least one not-cleared.
//
// THE DIRECTORY
//   On-chain a wallet is only an anonymous ticket. To answer "is the wallet
//   at THIS address clear?", someone has to know which ticket belongs to
//   which address. That mapping is the directory. It is private, off-chain,
//   and filled in when a holder clears a wallet and agrees to be findable.
//   It also keeps a dated history of clearances per wallet.
//
// IDEAS, NOT BUILT
//   - attaching cover to a receipt: "this transfer, to this receiver, in
//     this window, was checked"
//   - a receiver proving clearance directly to a sender, with no directory
//   - a just-in-time recheck of every pass before a very large transfer
//   - a price for the check that grows with how deep it goes
// ============================================================================

import { readClearance } from './clearance.mjs';
import { ContractRejectedError } from './local-chain.mjs';
import { bytesToHex, padTo32Bytes } from './encoding.mjs';

const walletKey = ({ chain, address }) => `${chain}:${address}`;

/** PRIVATE, off-chain: which ticket belongs to which wallet, plus a dated history. */
export class ClearanceDirectory {
  #entries = new Map();

  /** Record the outcome of a clearWallet() run for a wallet. */
  record(holder, clearanceResult, recordedAt) {
    const key = walletKey(holder.wallet);
    const entry = this.#entries.get(key) ?? { ticket: null, history: [] };
    if (clearanceResult.status === 'clear') entry.ticket = holder.ticket;
    entry.history.push({ at: recordedAt, profile: clearanceResult.profile, status: clearanceResult.status, validUntil: clearanceResult.validUntil });
    this.#entries.set(key, entry);
  }

  ticketFor(wallet) {
    return this.#entries.get(walletKey(wallet))?.ticket ?? null;
  }

  /** "This wallet was cleared on this date": every attempt, oldest first. */
  historyFor(wallet) {
    return [...(this.#entries.get(walletKey(wallet))?.history ?? [])];
  }
}

async function statusOfOneWallet(program, providers, directory, wallet, profileName) {
  // Cheapest and freshest first: is it on the ban list right now?
  const screening = await providers.banList.screen({ wallet, now: program.chain.now });
  if (screening.outcome === 'refuse') return { status: 'not-cleared', clearedUntil: null, referenceId: screening.referenceId };

  const ticket = directory.ticketFor(wallet);
  if (ticket === null) return { status: 'unsure', clearedUntil: null, referenceId: screening.referenceId ?? null };

  if (screening.outcome !== 'pass') return { status: 'unsure', clearedUntil: null, referenceId: screening.referenceId ?? null };

  let clearance = readClearance(program, ticket, profileName);
  if (!clearance.clear) {
    // The wallet may hold every pass this profile needs without anyone having
    // asked for THIS profile yet (for example it was cleared for a stricter
    // one). Granting a clearance needs no private input, so we simply ask the
    // registry. The contract decides; if the passes are missing or stale it
    // refuses and the wallet stays "unsure".
    try {
      await program.chain.call(program.addresses.ClearanceRegistry, {}, 'grant_clearance', ticket, padTo32Bytes(profileName), BigInt(program.chain.now));
      clearance = readClearance(program, ticket, profileName);
    } catch (error) {
      if (!(error instanceof ContractRejectedError)) throw error;
    }
  }
  if (!clearance.clear) return { status: 'unsure', clearedUntil: null, referenceId: null };
  return { status: 'clear', clearedUntil: clearance.validUntil, ticket };
}

/**
 * Check a sender and a receiver, and advise.
 * @returns {Promise<{checkedAt: number, sender: object, receiver: object,
 *                    advice: 'proceed'|'caution'|'stop', receiptId: string|null, receiptValidUntil: number|null}>}
 */
export async function checkPair(program, providers, directory, { sender, receiver }) {
  const profileName = program.config.pairCheckProfile;
  const [senderStatus, receiverStatus] = [
    await statusOfOneWallet(program, providers, directory, sender, profileName),
    await statusOfOneWallet(program, providers, directory, receiver, profileName)
  ];
  const statuses = [senderStatus.status, receiverStatus.status];
  const advice = statuses.includes('not-cleared') ? 'stop' : statuses.every((status) => status === 'clear') ? 'proceed' : 'caution';

  let receiptId = null;
  let receiptValidUntil = null;
  if (advice === 'proceed') {
    try {
      // The contract re-checks both clearances itself. Needs no private input.
      const issued = await program.chain.call(program.addresses.PairReceipt, {}, 'issue_receipt', senderStatus.ticket, receiverStatus.ticket, padTo32Bytes(profileName), BigInt(program.chain.now));
      receiptId = bytesToHex(issued.result);
      receiptValidUntil = Number(program.chain.publicLedger(program.addresses.PairReceipt).receipts.lookup(issued.result).validUntil);
    } catch (error) {
      if (!(error instanceof ContractRejectedError)) throw error;
      // The contract disagreed with our reading. Its word is final.
      return { checkedAt: program.chain.now, sender: publicView(senderStatus, 'unsure'), receiver: publicView(receiverStatus, 'unsure'), advice: 'caution', receiptId: null, receiptValidUntil: null };
    }
  }
  return { checkedAt: program.chain.now, sender: publicView(senderStatus), receiver: publicView(receiverStatus), advice, receiptId, receiptValidUntil };
}

// What the asker is told about one wallet. Never the ticket, never a reason.
function publicView(walletStatus, overrideStatus) {
  const status = overrideStatus ?? walletStatus.status;
  return { status, clearedUntil: status === 'clear' ? walletStatus.clearedUntil : null, referenceId: walletStatus.referenceId ?? null };
}
