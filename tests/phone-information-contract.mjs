import assert from "node:assert/strict";
import fs from "node:fs";
const s=fs.readFileSync("scripts/dashboard/dashboardSystem.js","utf8");
assert.match(s,/Phone Information/); assert.match(s,/MinePhoneService\.battery/); assert.match(s,/MinePhoneService\.flashlight/); assert.match(s,/CustomCardService\.validate/); assert.match(s,/Card Color/); assert.match(s,/Card Version/);
console.log("Phone information integration checks passed.");
