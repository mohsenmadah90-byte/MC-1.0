# Village Protection

## Scope

Added conservative automatic village/villager protection outside land claims.

## Detection

- Loaded villagers are scanned every configured interval (default 600 ticks).
- Villagers are grouped by dimension and proximity.
- Each group becomes a protected bounding zone with configurable padding.
- The registry is in-memory and rebuilt from loaded villagers; it does not scan every tick.
- A maximum tracked-villager limit prevents unbounded work.

## Protection

- Block break is cancelled inside a village.
- Block placement is cancelled before the event when available.
- Placement is compensated after the event when the before event is unavailable.
- Explosions remove village blocks from the impacted set.
- Block interaction is allowed only for configured door/container/workstation tokens.
- Villager damage is compensated through the after-event when a cancellable hurt event is unavailable.
- Escaped tracked villagers are teleported back to the village center when enabled.
- Villager interaction/trading remains allowed.

## Configuration

`CONFIG.VILLAGE_PROTECTION` controls scan interval, cluster radius, padding, maximum tracked villagers, containment, and allowed interaction block tokens.

## Limitations

Bedrock does not expose a universally reliable exact Village bounding-box API through the current compatibility layer. The implementation therefore uses villager clustering and a padded bounding box. Lead/boat/minecart edge cases and all API-specific entity movement behavior require live Bedrock testing.
