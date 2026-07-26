import assert from "node:assert/strict";
import fs from "node:fs";

const settings = fs.readFileSync("scripts/core/itemSettingsService.js", "utf8");
const config = fs.readFileSync("scripts/config.js", "utf8");
const contracts = fs.readFileSync("scripts/modules/contracts/contractService.js", "utf8");
const admin = fs.readFileSync("scripts/modules/market/marketAdminUI.js", "utf8");
const pricing = fs.readFileSync("scripts/data/marketPricing.generated.js", "utf8");

for (const ore of ["copper_ingot", "iron_ingot", "emerald", "gold_ingot", "diamond", "netherite_scrap"]) assert.match(settings, new RegExp(ore));
assert.match(settings, /ATM_ANCHOR_ITEMS/);
assert.match(settings, /setPrices/);
assert.match(config, /SERVER_CONTRACTS_ENABLED: false/);
assert.match(config, /DEFAULT_SERVER_CONTRACTS: \[\]/);
assert.match(contracts, /disableRestrictedContracts/);
assert.match(contracts, /ATM anchor item disabled in contracts/);
assert.match(admin, /Edit Prices/);
assert.match(admin, /ItemSettingsService\.setPrices/);
assert.match(pricing, /minecraft:diamond/);

console.log("Economy policy contract checks passed.");
