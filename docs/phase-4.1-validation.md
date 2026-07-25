# Phase 4.1 Scheduling and Batch Control

## Changes

- Extended `RuntimeHandleRegistry.interval()` with optional execution budgets.
- Added overlap protection: an interval callback cannot run concurrently with itself.
- Added `RuntimeHandleRegistry.scheduled()` as the central scheduling API.
- Added runtime metrics for executions, skipped overlaps, and over-budget executions.
- Added budget monitoring warnings for slow scheduled tasks.
- Applied a 5ms budget to the main land-tax and contract-GC loops.
- Existing lifecycle cleanup continues to clear all tracked handles.

## Validation

- Runtime lifecycle smoke checks passed for 108 JavaScript files.
- Database/migration/backup contract checks passed.
- Financial safety checks passed.
- All relative imports resolve.
- All JavaScript files pass `node --check`.

## Runtime follow-up

Actual task duration and tick impact must be measured in a live Bedrock world. The new metrics can be surfaced through the health-check UI in the next performance sub-phase.
