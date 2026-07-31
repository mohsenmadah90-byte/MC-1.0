# Chunk Banner Preview

## Changes

- Claim preview markers changed from `minecraft:white_wool` to `minecraft:white_banner`.
- The purchase flow now offers `Show Chunk` and `Buy Claim`.
- `Show Chunk` places four corner banners, sends a message, and closes the UI.
- Preview banners expire using the existing 60-second preview cleanup and are removed on player leave/shutdown.
- A separate purchase confirmation is shown before buying.
- Preview locations are tracked independently of the current block type, so replacing a banner through an after-event fallback is detected and compensated.
- Breaking preview markers is cancelled.
- Placement over preview locations is cancelled when the before-event exists, and removed/refunded through the after-event fallback otherwise.
- Explosions exclude preview locations.

## Safety limitation

The current Bedrock API reports `piston.activate.before` as unavailable. Preview markers are protected from break, placement and explosions; piston movement remains subject to the existing detective fallback and must be tested in a live Bedrock world.

## Validation

- Chunk banner preview contract passed.
- Full production validation passed.
- Import and syntax checks passed.
