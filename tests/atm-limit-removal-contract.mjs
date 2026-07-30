import assert from "node:assert/strict";
import fs from "node:fs";
const files=["scripts/modules/atm/atmService.js","scripts/modules/atm/atmUI.js","scripts/modules/atm/atmAdminUI.js","scripts/main.js","scripts/config.js","scripts/dashboard/helpUI.js"];
for(const file of files) assert.doesNotMatch(fs.readFileSync(file,"utf8"),/ATMLimits|EXCHANGE_LIMITS|RESET_INTERVAL/);
const config=fs.readFileSync("scripts/config.js","utf8");
assert.match(config,/minecraft:raw_copper/); assert.match(config,/minecraft:raw_iron/); assert.match(config,/minecraft:raw_gold/);
assert.doesNotMatch(config,/minecraft:copper_ingot/); assert.doesNotMatch(config,/minecraft:iron_ingot/); assert.doesNotMatch(config,/minecraft:gold_ingot/);
console.log("ATM raw-input and daily-limit removal checks passed.");
