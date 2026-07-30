import assert from "node:assert/strict";
import fs from "node:fs";
for (const [file, id, pattern] of [["recipes/mcity/atm/floor_atm.json","mcity:floor_atm",["III","IGI","IGN"]],["recipes/mcity/atm/floor_atm_bottom.json","mcity:floor_atm_bottom",["III","ICI","III"]]]) {
 const r=JSON.parse(fs.readFileSync(file)); const q=r["minecraft:recipe_shaped"]; assert.equal(q.description.identifier,id); assert.deepEqual(q.pattern,pattern); assert.equal(q.tags[0],"crafting_table");
}
const cfg=fs.readFileSync("scripts/config.js","utf8"); assert.match(cfg,/ATM_BLOCK_VARIANTS/);
console.log("Public ATM recipe checks passed.");
