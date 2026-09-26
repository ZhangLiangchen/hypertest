import type { QualityVerdict } from '@hypertest/domain';

/**
 * Exit codes of `hypertest`. `run` is verdict-aware so CI can branch on the QualityGate's decision:
 * pass ⇒ 0, fail ⇒ 3, conditional ⇒ 4, inconclusive ⇒ 5. A run that ends without a verdict (failed, cancelled)
 * is a failure (1); an interrupted foreground command is 130 (128 + SIGINT).
 */
export const EXIT_CODES = Object.freeze({
  ok: 0,
  failure: 1,
  usage: 2,
  verdictFail: 3,
  verdictConditional: 4,
  verdictInconclusive: 5,
  interrupted: 130,
} as const);

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

/** The exit code of a finished run: its verdict, or failure when it has none. */
export function verdictExitCode(verdict: QualityVerdict | undefined): ExitCode {
  switch (verdict) {
    case 'pass':
      return EXIT_CODES.ok;
    case 'fail':
      return EXIT_CODES.verdictFail;
    case 'conditional':
      return EXIT_CODES.verdictConditional;
    case 'inconclusive':
      return EXIT_CODES.verdictInconclusive;
    default:
      return EXIT_CODES.failure;
  }
}
