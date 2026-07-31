# Economy Policy Implementation

## Applied decisions

- ATM anchor prices remain unchanged.
- All catalog pricing defaults are available through `marketPricing.generated.js`.
- Existing market behavior preserves admin price overrides.
- Market/admin price editing is available through Item Flags → Edit Prices.
- All six ATM anchor items are permanently blocked from Market and Contract paths:
  - copper ingot
  - iron ingot
  - emerald
  - gold ingot
  - diamond
  - netherite scrap
- Server default contracts are disabled and the default list is empty.
- Existing active server default contracts are cancelled on initialization without deleting history or issuing rewards.
- Existing active contracts using ATM anchor items are cancelled on initialization.
- New player contracts using ATM anchor items are rejected.

## Price override behavior

`ItemSettingsService.setPrices()` stores integer-cent overrides with validation:

- non-negative safe integer values only
- `min <= buy <= max`
- `sell <= buy`
- actor and timestamp recorded

Catalog defaults remain the fallback; overrides survive restart and are not overwritten by the generated proposal.

## Market behavior

Existing market records without a price override receive generated catalog base prices during Market initialization. Current buy/sell prices, min/max bounds, and history are updated to the approved defaults for those records. Records with an explicit ItemSettings price override are preserved.

## ATM behavior

ATM configuration and payout values were not changed. ATM remains the sole intended exchange route for the six anchor resources.
