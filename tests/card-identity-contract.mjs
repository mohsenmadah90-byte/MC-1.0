import assert from "node:assert/strict";
import fs from "node:fs";
const service=fs.readFileSync("scripts/core/customCardService.js","utf8");
const compat=fs.readFileSync("scripts/core/bedrockCompat.js","utf8");
const main=fs.readFileSync("scripts/main.js","utf8");
assert.match(service,/ownerId/); assert.match(service,/cardId/); assert.match(service,/signature/); assert.match(service,/revoked/); assert.match(service,/player\.craft\.after/); assert.match(service,/setDynamicProperty/); assert.match(service,/Database\.transaction/); assert.match(service,/static validate/);
assert.match(compat,/player\.craft\.after/); assert.match(main,/CustomCardService\.initialize/); assert.match(main,/CustomCardService\.shutdown/);
console.log("Personal card identity contract checks passed.");
