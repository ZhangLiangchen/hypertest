import type { TestRunnerAdapter } from '../../contracts.ts';
import { goTestRunner } from './go.ts';
import { jestRunner, vitestRunner } from './jest.ts';
import { nodeTestRunner } from './node.ts';
import { pytestRunner } from './pytest.ts';

export { buildResult, totalsOf } from './common.ts';
export { commandRunner, type CommandRunnerOptions } from './command.ts';
export { goTestRunner, parseGoTestJson, goSelectorArgs } from './go.ts';
export { jestRunner, vitestRunner, parseJestJson } from './jest.ts';
export { nodeTestRunner, parseJunitCases } from './node.ts';
export { pytestRunner, applyPytestSummary } from './pytest.ts';

/** Default runners in auto-detection order: vitest, jest, node:test, pytest, go test. */
export function defaultTestRunners(): TestRunnerAdapter[] {
  return [vitestRunner(), jestRunner(), nodeTestRunner(), pytestRunner(), goTestRunner()];
}
