# Phase 2.1 Validation

## Scope

Runtime lifecycle and Script API scheduling ownership were reviewed without changing domain/economy/database behavior.

## Changes

- Added tracked one-shot timeout support to `RuntimeHandleRegistry.timeout()`.
- Added timeout counts to runtime registry statistics.
- Moved the delayed player welcome callback in `main.js` into the runtime registry.
- Moved delayed player spawn/offline queue work in `PlayerRegistry` into the runtime registry.
- Moved DashboardEntry menu recovery and spawn delivery timeouts into the runtime registry.
- This ensures delayed callbacks are cleared during shutdown/reload together with intervals and jobs.

## Validation

- All JavaScript files pass `node --check`.
- No direct `system.runInterval`, `system.runTimeout`, or `system.runJob` calls remain outside `RuntimeHandleRegistry`.
- `manifest.json` passes JSON validation.

## Runtime limitation

A live Bedrock world was not available in the local Node environment, so actual Script API event delivery and shutdown behavior still require the Bedrock integration test in phase 2.2.
