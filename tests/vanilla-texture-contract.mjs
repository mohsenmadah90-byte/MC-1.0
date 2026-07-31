import assert from "node:assert/strict";
import { ITEM_CATALOG } from "../scripts/core/itemCatalog.js";
assert.equal(ITEM_CATALOG.length, 1944);
assert.equal(ITEM_CATALOG.filter(item => item.textureSource !== "vanilla").length, 0);
assert.equal(ITEM_CATALOG.filter(item => !item.icon).length, 0);
for (const item of ITEM_CATALOG) assert.match(item.icon, /^textures\/(items|blocks)\//, `${item.id} is not using a Vanilla texture path`);
console.log("Vanilla texture path checks passed for 1944 catalog records.");
