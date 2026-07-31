import assert from "node:assert/strict";
import fs from "node:fs";
const s=fs.readFileSync("scripts/core/minePhoneService.js","utf8");
assert.match(s,/phoneVisuals/); assert.match(s,/Math\.sin/); assert.match(s,/setRotation/); assert.match(s,/36/); assert.match(s,/0\.08/); assert.match(s,/charger_charging/); console.log("Charger phone animation and particle integration checks passed.");
