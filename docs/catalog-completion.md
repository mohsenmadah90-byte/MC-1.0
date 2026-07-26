# Complete Minecraft Catalog Integration

## Source

`Minecraft_Bedrock_1.21.130_Complete_List.xlsx`

The workbook is retained as the source artifact. Generated files are derived from it and must not be edited manually.

## Generated data

- `scripts/data/itemCatalog.generated.js`: 1,944 unique item/block IDs (1,427 blocks + 545 items, with the duplicate workbook block ID normalized once).
- `scripts/data/gameCatalog.generated.js`: 139 entities, 42 enchantments, 30 effects.
- `scripts/core/gameCatalog.js`: access API for entity, enchantment, and effect catalogs.

## Policy model

The raw Minecraft catalog and the economy policy are separated. Existing legacy economy metadata is preserved for the original catalog entries. Newly imported records default to:

- `marketable: false`
- `contractable: false`
- `adminOnly: false` unless clearly technical/admin
- dangerous IDs such as spawn eggs, TNT, command blocks, barrier and bedrock are flagged

This prevents importing a complete reference list from accidentally enabling all blocks/items for trade or contracts.

## ItemCatalog behavior

`ItemCatalog` now exposes the complete item/block set while preserving existing search, mode filters, and policy checks. Records additionally expose source metadata:

- English and Persian names
- numeric ID
- creative tab
- block/item flags
- source version

## Validation

- Manifest validation passed.
- Relative import validation passed for 112 JavaScript files.
- Syntax validation passed.
- Catalog contract checks passed.
- Runtime, database, financial, protection, cache, load and production preflight checks passed.

## Version note

The source workbook is for Bedrock 1.21.130, while the observed server was Bedrock 1.26.32.2. The catalog records carry `sourceVersion` so a later version-diff update can be performed. New records remain non-tradeable until explicitly approved.
