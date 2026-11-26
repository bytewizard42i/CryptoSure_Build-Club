// Shared set-up for the tests: a freshly deployed program, the mock
// providers, and one-line ways to make a holder and to hand out passes.

import { readFileSync } from 'node:fs';
import { deployProgram } from '../protocol/program.mjs';
import { createMockProviders } from '../protocol/providers/mock-providers.mjs';
import { createHolder, recordAndProveCheck } from '../protocol/clearance.mjs';
import { createDemoWalletSigner } from '../protocol/wallet-signatures.mjs';
import { bytesToHex, random32Bytes } from '../protocol/encoding.mjs';

const readJson = (relativePath) => JSON.parse(readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8'));

export const PROGRAM_CONFIG = readJson('config/program.json');
export const MOCK_FIXTURE = readJson('fixtures/mock-subjects.json');
export const SUBJECTS = Object.fromEntries(MOCK_FIXTURE.subjects.map((subject) => [subject.id, subject]));

// A fixed start time keeps runs repeatable.
export const START_TIME = 1_800_000_000;
export const ONE_DAY = 86_400;

export async function freshProgram(config = PROGRAM_CONFIG) {
  return deployProgram(structuredClone(config), { startTime: START_TIME });
}

export const mockProviders = () => createMockProviders(MOCK_FIXTURE);

export function holderFor(program, subjectId) {
  const subject = SUBJECTS[subjectId];
  return {
    subject,
    holder: createHolder(program, { subjectId, wallet: subject.wallet }),
    walletSigner: createDemoWalletSigner(subject.wallet, { signWithSomeoneElsesKey: Boolean(subject.signWithSomeoneElsesKey) })
  };
}

// The answer an honest provider would give for each check, valid for a year.
export function goodAnswer(program, checkName, overrides = {}) {
  const expiresAt = program.chain.now + 365 * ONE_DAY;
  const answers = {
    banList: { listVersion: 1 },
    walletControl: { expiresAt },
    region: { regionCode: 'REGION-A', expiresAt },
    identity: { level: 2, credentialId: bytesToHex(random32Bytes()), expiresAt },
    education: { level: 2, certificateId: bytesToHex(random32Bytes()), expiresAt }
  };
  return { ...answers[checkName], ...overrides };
}

// Give a holder passes straight from the contracts, skipping the providers.
export async function givePasses(program, holder, checkNames, overridesByCheck = {}) {
  const evidence = {};
  for (const checkName of checkNames) {
    evidence[checkName] = await recordAndProveCheck(program, holder, checkName, goodAnswer(program, checkName, overridesByCheck[checkName]));
  }
  return evidence;
}

export const ALL_CHECKS = ['banList', 'walletControl', 'region', 'identity', 'education'];
