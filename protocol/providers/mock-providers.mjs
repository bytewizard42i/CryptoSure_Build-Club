// ============================================================================
// mock-providers.mjs — synthetic answers, so the protocol runs anywhere
// ============================================================================
// These stand in for the outside parties the protocol depends on. They look
// answers up in a fixture file of made-up facts. They verify nothing.
// Read providers/README.md for the interface they implement.
//
// MOCK: every answer here is synthetic. The wallet-control verifier does
// check a real signature, but against stand-in keys (see wallet-signatures.mjs).
//
// The fixture decides outcomes; this file never explains them. That mirrors
// the real arrangement, where a provider says yes or no and keeps the reason.
// ============================================================================

import { randomBytes } from 'node:crypto';
import { createWalletControlChallenge, demoWalletPublicKey, verifyWalletSignature } from '../wallet-signatures.mjs';

const ONE_DAY_SECONDS = 86_400;

const pass = (evidence = {}) => ({ outcome: 'pass', ...evidence });
// An opaque handle. In a real provider it keys into their private log.
const withReference = (outcome) => ({ outcome, referenceId: `mock-ref-${randomBytes(6).toString('hex')}` });

function requireNow(now) {
  if (!Number.isSafeInteger(now) || now <= 0) throw new TypeError('Provider requests must carry `now` in unix seconds.');
}

/**
 * @param {object} fixture  parsed fixtures/mock-subjects.json
 */
export function createMockProviders(fixture) {
  const subjectsById = new Map(fixture.subjects.map((subject) => [subject.id, subject]));
  const walletsByKey = new Map(fixture.subjects.map((subject) => [`${subject.wallet.chain}:${subject.wallet.address}`, subject]));
  const extraListedWallets = new Set((fixture.listedWallets ?? []).map((wallet) => `${wallet.chain}:${wallet.address}`));

  return {
    banList: {
      async screen({ wallet, now }) {
        requireNow(now);
        const walletKey = `${wallet.chain}:${wallet.address}`;
        if (extraListedWallets.has(walletKey)) return withReference('refuse');
        const subject = walletsByKey.get(walletKey);
        // Fail closed: a wallet nobody has screened is not "clean", it is unknown.
        if (subject === undefined || subject.screening === 'never-screened') return withReference('unknown');
        if (subject.screening === 'listed') return withReference('refuse');
        return pass({ listVersion: fixture.listVersion });
      }
    },

    walletControl: {
      createChallenge({ wallet }) {
        return createWalletControlChallenge(wallet);
      },
      async verify({ wallet, challenge, signatureHex, now }) {
        requireNow(now);
        const signedByWallet = verifyWalletSignature({ walletPublicKey: demoWalletPublicKey(wallet), messageText: challenge, signatureHex });
        return signedByWallet ? pass({ expiresAt: now + 30 * ONE_DAY_SECONDS }) : withReference('refuse');
      },
      async verifyMessage({ wallet, messageText, signatureHex }) {
        return verifyWalletSignature({ walletPublicKey: demoWalletPublicKey(wallet), messageText, signatureHex });
      }
    },

    region: {
      async attest({ subjectId, allowedRegions, now }) {
        requireNow(now);
        const subject = subjectsById.get(subjectId);
        if (subject === undefined) return withReference('unknown');
        // The provider is told which regions we serve and answers only about
        // those. On "no" we learn nothing about where the person is.
        if (!allowedRegions.includes(subject.region)) return withReference('refuse');
        return pass({ regionCode: subject.region, expiresAt: now + 90 * ONE_DAY_SECONDS });
      }
    },

    identity: {
      async verify({ subjectId, now }) {
        requireNow(now);
        const subject = subjectsById.get(subjectId);
        if (subject === undefined) return withReference('unknown');
        if (!Number.isInteger(subject.identityLevel) || subject.identityLevel < 1) return withReference('refuse');
        return pass({ level: subject.identityLevel, credentialId: randomBytes(32).toString('hex'), expiresAt: now + 365 * ONE_DAY_SECONDS });
      }
    },

    education: {
      async certify({ subjectId, now }) {
        requireNow(now);
        const subject = subjectsById.get(subjectId);
        if (subject === undefined) return withReference('unknown');
        // A certificate exists only for someone who passed. The level says
        // how demanding a course it was.
        if (!Number.isInteger(subject.educationLevel) || subject.educationLevel < 1) return withReference('refuse');
        return pass({ level: subject.educationLevel, certificateId: randomBytes(32).toString('hex'), expiresAt: now + 365 * ONE_DAY_SECONDS });
      }
    }
  };
}
