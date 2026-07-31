# Protection API Fallback Fix

## Observed runtime condition

On Bedrock 1.26.32.2, the following cancellable before-events were unavailable:

- `block.place.before`
- `piston.activate.before`
- `item.useOn.before`

## Changes

- Added explicit fallback modes to the Bedrock compatibility report:
  - `block.place.before`: `compensating`
  - `piston.activate.before`: `detective`
  - `item.useOn.before`: `conservative`
- Health/API reports now expose `fallbackMode`, so an unavailable protection event is not reported as an opaque warning.
- Existing land placement fallback remains post-event compensating: unauthorized blocks are removed and the item is refunded.
- Existing ATM hopper fallback remains post-event compensating: unauthorized hoppers adjacent to protected ATM/source blocks are removed and refunded.
- Existing item-use fallback remains conservative and cancels the use while the player is in a protected claim context.
- Protection fallback contract tests were added to guard these safety paths.

## Important limitation

A post-event fallback cannot provide the same guarantee as a cancellable before-event. In particular, piston movement may occur before detection. The compatibility report now marks this as `detective`, not as equivalent protection. A real Bedrock test must verify piston behavior and any residual movement in protected claims.
