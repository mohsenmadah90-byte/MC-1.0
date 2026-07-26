// Complete non-item game catalogs generated from the Bedrock reference workbook.
import { ENTITY_CATALOG, ENCHANTMENT_CATALOG, EFFECT_CATALOG } from "../data/catalog.js";

export { ENTITY_CATALOG, ENCHANTMENT_CATALOG, EFFECT_CATALOG };

export class GameCatalog {
    static entities() { return ENTITY_CATALOG; }
    static enchantments() { return ENCHANTMENT_CATALOG; }
    static effects() { return EFFECT_CATALOG; }
    static entity(id) { return ENTITY_CATALOG.find(entry => entry.id === String(id || "").toLowerCase()) || null; }
    static enchantment(id) { return ENCHANTMENT_CATALOG.find(entry => entry.id === String(id || "").toLowerCase()) || null; }
    static effect(id) { return EFFECT_CATALOG.find(entry => entry.id === String(id || "").toLowerCase()) || null; }
}

export default GameCatalog;
