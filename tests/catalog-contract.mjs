import assert from "node:assert/strict";
import { ITEM_CATALOG, ItemCatalog } from "../scripts/core/itemCatalog.js";
import { ENTITY_CATALOG, ENCHANTMENT_CATALOG, EFFECT_CATALOG } from "../scripts/data/gameCatalog.generated.js";

assert.equal(ITEM_CATALOG.length, 1944);
assert.equal(new Set(ITEM_CATALOG.map(item => item.id)).size, ITEM_CATALOG.length);
assert.ok(ITEM_CATALOG.some(item => item.isBlock));
assert.ok(ITEM_CATALOG.some(item => item.isItem));
assert.equal(ItemCatalog.get("minecraft:diamond")?.marketable, true);
assert.equal(ItemCatalog.get("minecraft:acacia_button")?.marketable, false);
assert.equal(ItemCatalog.isAllowed("minecraft:command_block", "market"), false);
assert.equal(ENTITY_CATALOG.length, 139);
assert.equal(ENCHANTMENT_CATALOG.length, 42);
assert.equal(EFFECT_CATALOG.length, 30);

console.log(`Catalog checks passed: ${ITEM_CATALOG.length} item/block records, ${ENTITY_CATALOG.length} entities, ${ENCHANTMENT_CATALOG.length} enchantments, ${EFFECT_CATALOG.length} effects.`);
