# ATM Netherite Scrap Update

## Change

The final ATM exchange tier keeps its logical key `diamond_netherite` for compatibility, but its required inputs are now:

```text
minecraft:diamond
minecraft:netherite_scrap
```

The display name is now `Diamond + Netherite Scrap`.

## Updated surfaces

- ATM configuration and input combinations
- ATM inventory counting and preparation through the configuration path
- ATM exchange UI through the configuration path
- Help display through the configuration name
- Admin/testing item grants

## Compatibility

Existing exchange journals and limits retain the `diamond_netherite` logical key. No destructive migration of completed journals is required. New exchanges no longer accept `minecraft:netherite_ingot`.

## Validation

- ATM Netherite Scrap contract passed.
- Full production validation passed.
- No active `netherite_ingot` reference remains in ATM logic or testing tools; Catalog references remain valid Minecraft catalog data.
