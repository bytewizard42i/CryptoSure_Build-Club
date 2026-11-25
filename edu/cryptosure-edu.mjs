// ============================================================================
// CryptoSureEdu — the test an applicant must pass before a policy is accepted.
// ============================================================================
// Every policy names the education modules it requires and a pass mark.
// Bigger cover means more modules and a higher bar. The flow is:
//
//   buildTestForPolicy(policy)        -> the questions (no answers inside)
//   gradeTest(policy, answerSheet)    -> pass/fail, score, and on a pass an
//                                        education certificate
//
// The certificate is folded into the private policy document, so the hash
// that goes on-chain commits to the fact that the test was passed.
//
// OFF-CHAIN FOR NOW: grading happens here in JavaScript. Putting the
// certificate itself on-chain (a certifier contract) is a later step.
// ============================================================================

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const QUESTION_BANK_PATH = fileURLToPath(new URL('./question-bank.json', import.meta.url));
const QUESTION_BANK = JSON.parse(readFileSync(QUESTION_BANK_PATH, 'utf8')).modules;

function questionsForPolicy(policy) {
  return policy.education.requiredModules.flatMap((moduleName) => {
    const module = QUESTION_BANK[moduleName];
    if (module === undefined) {
      throw new Error(`Policy ${policy.policyId} requires education module "${moduleName}", which is not in edu/question-bank.json.`);
    }
    return module.questions.map((question) => ({ ...question, module: moduleName }));
  });
}

/**
 * The test an applicant sees for a policy. The correct answers are stripped
 * out: this object is safe to hand to the applicant's screen.
 */
export function buildTestForPolicy(policy) {
  return {
    policyId: policy.policyId,
    passMarkPercent: policy.education.passMarkPercent,
    questions: questionsForPolicy(policy).map(({ id, module, prompt, options }) => ({ id, module, prompt, options }))
  };
}

/**
 * Grade an answer sheet: an object mapping question id -> chosen option index.
 * An unanswered or malformed answer counts as wrong.
 * @returns {{passed: boolean, scorePercent: number, correctCount: number, questionCount: number, certificate?: object}}
 */
export function gradeTest(policy, answerSheet, nowUnixSeconds = Math.floor(Date.now() / 1000)) {
  if (answerSheet === null || typeof answerSheet !== 'object' || Array.isArray(answerSheet)) {
    throw new TypeError('gradeTest needs an answer sheet object: { questionId: chosenOptionIndex }.');
  }
  const questions = questionsForPolicy(policy);
  const correctCount = questions.filter((question) => answerSheet[question.id] === question.correctOption).length;
  const scorePercent = Math.floor((correctCount * 100) / questions.length);
  const passed = scorePercent >= policy.education.passMarkPercent;

  const result = { passed, scorePercent, correctCount, questionCount: questions.length };
  if (!passed) return result;

  return {
    ...result,
    certificate: {
      issuedBy: 'CryptoSureEdu (demo)',
      policyId: policy.policyId,
      modulesPassed: policy.education.requiredModules,
      scorePercent,
      passMarkPercent: policy.education.passMarkPercent,
      // Fingerprint of the exact questions asked, so the certificate says
      // which version of the test was passed.
      questionSetHash: createHash('sha256').update(questions.map((question) => question.id).join(','), 'utf8').digest('hex'),
      passedAt: nowUnixSeconds
    }
  };
}

/**
 * DEMO ONLY: fill in an answer sheet for a synthetic persona, getting the
 * first `correctAnswerCount` questions right and the rest wrong. A real
 * applicant's answers come from the screen. Reads the answer key, so it must
 * never be shipped to an applicant's device.
 */
export function simulateAnswerSheet(policy, correctAnswerCount) {
  const questions = questionsForPolicy(policy);
  return Object.fromEntries(questions.map((question, index) => [
    question.id,
    index < correctAnswerCount ? question.correctOption : (question.correctOption + 1) % question.options.length
  ]));
}
