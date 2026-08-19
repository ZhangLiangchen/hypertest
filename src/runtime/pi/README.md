# pi runtime boundary

This directory is the only location allowed to import Pi packages. Tests use
the official event-stream fixtures only through `testing.ts` in this boundary.

`@earendil-works/pi-agent-core` is the sole agent-loop/runtime dependency.
`@earendil-works/pi-ai` is its official LLM transport and nominal stream-type
companion; it provides the OpenAI-compatible stream implementation here, not a
second agent loop, state machine, or tool authority.

`PiAgentRuntime` translates HyperTest-owned requests, tools, events, cancellation, and structured results to pi. No pi message, tool, session, provider, or model type escapes this directory. The model object and stream function are injected by the deployment entry point so provider credentials remain outside the core.
