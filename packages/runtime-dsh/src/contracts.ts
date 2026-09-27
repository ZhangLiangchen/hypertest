import type { NativeEngineDeps } from '@hypertest/runtime';

/**
 * @hypertest/runtime-dsh — AgentEngine adapter over the DeepSeek Harness (`@deepseek-ai/dsh-agent-loop`, pinned; pin +
 * adapter, no fork). DSH supplies loop mechanics (turn/step lifecycle, inbox claim, request assembly, the tool scheduler
 * and execution pipeline); Hypertest supplies the model (a DSH `LlmAdapter` backed by the EngineHost ModelInvoker), tools
 * (agent-scoped DSH tools wrapping the EngineHost ToolDispatcher), context and persistence. DSH's session log is a
 * per-turn projection rebuilt from the portable SessionStore transcript, so a crash never loses state and DSH types
 * (SessionId, Cordis services, messages) never leave this package.
 *
 * Implementations to export from src/index.ts:
 *   class DshEngine implements AgentEngine   (kind 'dsh'; must pass runtime's engineContractSuite)
 */
export const DSH_ENGINE_KIND = 'dsh';

/**
 * (additive) Dependencies of DshEngine — the same ports as NativeEngine's (`sessions` serves createSession/spawnChild/
 * interrupt/inspect/dispose; runTurn uses `host.sessions`). The contract suite's EngineContractDeps satisfy it.
 */
export type DshEngineDeps = NativeEngineDeps;
