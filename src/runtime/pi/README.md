# pi runtime boundary

This directory is the only place in HyperTest production code allowed to import `@earendil-works/pi-agent-core`.

The first implementation will translate between the HyperTest-owned `AgentRuntime` protocol and pi events/tools. No pi message, tool, session, or provider type may escape this directory.
