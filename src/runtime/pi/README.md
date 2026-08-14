# pi runtime boundary

This directory is the only production location allowed to load `@earendil-works/pi-agent-core`.

`PiAgentRuntime` translates HyperTest-owned requests, tools, events, cancellation, and structured results to pi. No pi message, tool, session, provider, or model type escapes this directory. The model object and stream function are injected by the deployment entry point so provider credentials remain outside the core.
