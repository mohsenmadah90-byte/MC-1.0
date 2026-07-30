# Access Card Phase 3.1

- Added `AccessCardService` as the shared card authorization boundary.
- ATM interaction now requires a valid Personal Card before opening ATM UI.
- Added `GateService` registry and authorization API for future Nether/End gates.
- Gate definitions support enabled/disabled state and required-card policy.
- Invalid, missing, foreign, malformed, revoked and unknown cards are denied.
- ATM economy, raw inputs, prices, journal, recovery and rate limiter remain unchanged.

The new ATM appearance/block integration remains phase 3.2.
