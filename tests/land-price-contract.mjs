import assert from "node:assert/strict";
import fs from "node:fs";

const service = fs.readFileSync("scripts/modules/land/landService.js", "utf8");
const ui = fs.readFileSync("scripts/modules/land/landUI.js", "utf8");
assert.match(service, /static saleInfo\(claimOrId\)/);
assert.match(service, /listing\.price/);
assert.match(service, /priceCents/);
assert.match(service, /Number\.isSafeInteger\(price\)/);
assert.doesNotMatch(ui, /MoneyUtils\.formatCents\(c\.marketPrice\)/);
assert.match(ui, /MoneyUtils\.formatCents\(sale\.priceCents\)/);

console.log("Land price consistency checks passed.");
