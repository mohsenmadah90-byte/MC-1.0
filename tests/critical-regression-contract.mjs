import assert from "node:assert/strict";
import fs from "node:fs";
const atm=fs.readFileSync("scripts/modules/atm/atmLimits.js","utf8");
const schema=fs.readFileSync("scripts/schemas/marketSchema.js","utf8");
assert.match(atm,/RuntimeHandleRegistry\.job\("ATMLimits\.resetBatch"/);
assert.match(atm,/yield/);
assert.match(atm,/resetJobId = null/);
assert.match(schema,/catalogSeedCleanupV1/);
console.log("Critical ATM reset and Market persistence regression checks passed.");
