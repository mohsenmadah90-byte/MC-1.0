// Canonical catalog facade. All runtime catalog consumers must import from this file.
// The generated source files remain split by domain to keep generated artifacts
// manageable, but this module is the single public data boundary.
import { GENERATED_CATALOG } from "./itemCatalog.generated.js";
import { MARKET_PRICING_DEFAULTS } from "./marketPricing.generated.js";
import { ENTITY_CATALOG, ENCHANTMENT_CATALOG, EFFECT_CATALOG } from "./gameCatalog.generated.js";

export { GENERATED_CATALOG, MARKET_PRICING_DEFAULTS, ENTITY_CATALOG, ENCHANTMENT_CATALOG, EFFECT_CATALOG };
export const CATALOG_VERSION = "1.21.130";
export const CATALOG_COUNTS = Object.freeze({
    itemsAndBlocks: GENERATED_CATALOG.length,
    entities: ENTITY_CATALOG.length,
    enchantments: ENCHANTMENT_CATALOG.length,
    effects: EFFECT_CATALOG.length
});
