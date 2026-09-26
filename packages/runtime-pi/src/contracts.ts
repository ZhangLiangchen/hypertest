import type { NativeEngineDeps } from '@hypertest/runtime';

/**
 * @hypertest/runtime-pi — AgentEngine adapter over `@earendil-works/pi-agent-core` (pin + adapter, no
 * fork). Pi supplies loop mechanics; Hypertest supplies the model (a pi-ai StreamFn backed by the
 * EngineHost ModelInvoker), tools (pi AgentTools wrapping EngineHost ToolDispatcher), context and
 * persistence. Pi message state is rebuilt from the portable SessionStore transcript each turn, so a
 * crash never loses state and Pi types never leave this package.
 *
 * Implementations to export from src/index.ts:
 *   class PiEngine implements AgentEngine   (kind 'pi'; must pass runtime's engineContractSuite)
 */
export const PI_ENGINE_KIND = 'pi';

/**
 * (additive) Dependencies of PiEngine — the same ports as NativeEngine's (`sessions` serves createSession/spawnChild/
 * interrupt/inspect/dispose; runTurn uses `host.sessions`). The contract suite's EngineContractDeps satisfy it.
 */
export type PiEngineDeps = NativeEngineDeps;
