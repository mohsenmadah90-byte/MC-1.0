# Market Pricing Policy Proposal (not applied)

## Economic anchors

The six ATM inputs define the economy anchor. The current ATM payouts are exactly represented by these marginal values:

| Resource | Proposed value (cents) |
|---|---:|
| Copper Ingot | 100 |
| Iron Ingot | 400 |
| Emerald | 600 |
| Gold Ingot | 900 |
| Diamond | 1,600 |
| Netherite Scrap | 2,400 |

Pair checks: copper+iron=500, iron+emerald=1,000, emerald+gold=1,500, gold+diamond=2,500, diamond+scrap=4,000.

## Proposed market rules

- `baseBuyPrice` is the server listing price per unit.
- `baseSellPrice` starts at 70% of buy price; this preserves the existing `SELL_RATIO` and creates a spread.
- New catalog records remain disabled until reviewed: `marketable=false`, `contractable=false`.
- Dynamic market price is bounded by 0.65x–1.75x and changes at most 10% per update.
- Prices are integer cents; no floating-point values are persisted.
- Minimum buy price is 1 cent for enabled low-value items; technical/admin items remain disabled.
- ATM exchange is the money creation boundary; market buying/selling must not silently mint currency outside the configured spread and fees.

## Price model

Recommended buy price is generated from deterministic signals:

1. ATM anchor and conversion-equivalent value.
2. Crafting/acquisition tier and rarity.
3. Renewable versus non-renewable supply.
4. Utility and demand multiplier.
5. Technical/admin/danger classification.
6. Stackability and transaction practicality.

The generated proposal contains every workbook item/block and is intentionally a proposal only. It must be reviewed before being imported into market state.
