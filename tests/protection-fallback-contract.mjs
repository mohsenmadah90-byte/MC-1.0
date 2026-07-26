import assert from "node:assert/strict";
import fs from "node:fs";

const compat = fs.readFileSync("scripts/core/bedrockCompat.js", "utf8");
const land = fs.readFileSync("scripts/modules/land/landProtection.js", "utf8");
const atm = fs.readFileSync("scripts/modules/atm/atmProtection.js", "utf8");

for (const mode of ["compensating", "detective", "conservative"]) assert.match(compat, new RegExp(`fallbackMode: "${mode}"`));
assert.match(compat, /fallbackMode: def\.fallbackMode/);
assert.match(land, /block\.place\.after/);
assert.match(land, /Block removed and item refunded/);
assert.match(land, /item\.use\.before/);
assert.match(land, /piston\.activate\.before/);
assert.match(atm, /block\.place\.after/);
assert.match(atm, /Hopper compensation failed/);
assert.match(atm, /piston\.activate\.before/);

console.log("Protection fallback contract checks passed.");
