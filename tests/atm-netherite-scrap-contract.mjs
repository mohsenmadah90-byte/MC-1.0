import assert from "node:assert/strict";
import fs from "node:fs";

const config = fs.readFileSync("scripts/config.js", "utf8");
const atmInventory = fs.readFileSync("scripts/modules/atm/atmInventory.js", "utf8");
const atmService = fs.readFileSync("scripts/modules/atm/atmService.js", "utf8");
const atmUI = fs.readFileSync("scripts/modules/atm/atmUI.js", "utf8");
const tools = fs.readFileSync("scripts/dashboard/testingToolsUI.js", "utf8");

assert.match(config, /diamond_netherite: \["minecraft:diamond", "minecraft:netherite_scrap"\]/);
assert.match(config, /diamond_netherite: "Diamond \+ Netherite Scrap"/);
assert.doesNotMatch(atmInventory, /netherite_ingot/);
assert.doesNotMatch(atmService, /netherite_ingot/);
assert.doesNotMatch(atmUI, /netherite_ingot/);
assert.match(tools, /minecraft:netherite_scrap/);
assert.doesNotMatch(tools, /minecraft:netherite_ingot/);

console.log("ATM Netherite Scrap contract checks passed.");
