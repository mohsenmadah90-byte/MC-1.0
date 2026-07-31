# Land Price Consistency Fix

## Root cause

`LandUI.claimInfo()` displayed `claim.marketPrice`, but the sale system stores the authoritative amount in `market.listings[listingId].price` and the normalized fallback in `claim.salePriceCents`. This produced missing or inaccurate displayed prices.

## Changes

- Added `LandService.saleInfo(claimOrId)` as the single read path for listing price and seller metadata.
- `claimInfo()` now displays `saleInfo.priceCents`.
- My Lands list now displays the authoritative listing price.
- `listForSale()` now validates that price is a positive safe integer in cents at the service boundary, not only in UI.
- Existing buyer transaction continues to re-read the authoritative listing price inside its transaction.

## Validation

- Land price consistency contract passed.
- Full production validation passed.
- Listing price source is no longer `claim.marketPrice` in the UI.

## Remaining pricing policy

The server buyback refund remains based on the configured base price and refund ratio. Zone-aware/server-buyback pricing is a separate policy decision and was not silently changed in this fix.
