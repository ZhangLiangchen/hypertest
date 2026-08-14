# Contributing

## Prerequisites

- Node.js 22.19.0 or newer
- npm 10 or newer

## Local verification

```bash
npm install
npm run ci
```

## Pull-request rules

- Keep changes focused and include failure-path tests.
- Do not add a second agent SDK.
- Do not put language, test-framework, CI, or SCM types in the common core.
- New adapter capabilities require explicit contracts and conformance fixtures.
- Changes that can mutate a governed workspace or publish a change must preserve BUGate fail-closed enforcement.
