# Phase 2.2 Runtime Validation

## Automated checks

- Runtime lifecycle smoke test passed for 108 JavaScript files.
- Manifest entry and script module metadata validated.
- All required lifecycle registry files exist.
- Required BedrockCompat feature declarations exist.
- Main startup initializes SubscriptionRegistry and RuntimeHandleRegistry.
- Main shutdown subscription and RuntimeHandleRegistry shutdown are present.
- No direct `system.runInterval`, `system.runTimeout`, or `system.runJob` calls remain outside `RuntimeHandleRegistry`.
- All relative imports resolve to files in the repository.
- All JavaScript files pass `node --check`.

## Bedrock-only verification still required

The local environment does not provide `@minecraft/server` or a live Bedrock world, so these scenarios cannot be truthfully executed here:

1. Cold startup in a Bedrock world.
2. `playerSpawn` and `playerLeave` event delivery.
3. Delayed callback execution and cleanup.
4. `system.beforeEvents.shutdown` delivery.
5. Reload/restart without duplicate subscriptions.
6. Interval, timeout, and job cancellation inside the actual Script API.
7. UI opening after player spawn.

A Bedrock test world should execute these cases before production release.
