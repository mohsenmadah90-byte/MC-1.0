import assert from "node:assert/strict";
import fs from "node:fs";
const access=fs.readFileSync("scripts/core/accessCardService.js","utf8");
const gate=fs.readFileSync("scripts/modules/access/gateService.js","utf8");
const atm=fs.readFileSync("scripts/modules/atm/atmProtection.js","utf8");
assert.match(access,/CustomCardService\.validate/); assert.match(access,/missing_card/); assert.match(access,/owner_mismatch/); assert.match(access,/bad_signature/); assert.match(access,/revoked_or_unknown/);
assert.match(gate,/AccessCardService\.authorize/); assert.match(gate,/requiredCard/); assert.match(gate,/enabled/);
assert.match(atm,/AccessCardService\.authorize/); assert.match(atm,/ATMUI\.open/);
console.log("ATM and gate card access contract checks passed.");
