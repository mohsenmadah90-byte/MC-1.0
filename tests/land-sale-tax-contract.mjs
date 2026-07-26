import assert from "node:assert/strict";
import fs from "node:fs";

const service = fs.readFileSync("scripts/modules/land/landService.js", "utf8");
const ui = fs.readFileSync("scripts/modules/land/landUI.js", "utf8");

assert.match(service, /static payTax\(player, claimIdValue, options = \{\}\)/);
assert.match(service, /options\.expectedDebt/);
assert.match(service, /Tax amount changed/);
assert.match(service, /Pay tax debt before listing/);
assert.match(service, /Pay tax debt before selling/);
assert.match(ui, /confirmTaxBeforeSale/);
assert.match(ui, /Pay Tax & Continue/);
assert.match(ui, /Confirm Land Listing/);
assert.match(ui, /Any required tax was paid before this confirmation/);

console.log("Land sale tax-gate checks passed.");
