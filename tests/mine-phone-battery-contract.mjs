import assert from "node:assert/strict";
import fs from "node:fs";
const phone=fs.readFileSync("scripts/core/minePhoneService.js","utf8");
const router=fs.readFileSync("scripts/dashboard/dashboardRouter.js","utf8");
assert.match(phone,/BATTERY_KEY/); assert.match(phone,/MAX_SECONDS = 20 \* 60/); assert.match(phone,/MinePhone\.battery/); assert.match(phone,/flashlight/); assert.match(phone,/static begin/); assert.match(phone,/static tick/); assert.match(phone,/syncDurability/); assert.match(phone,/LAST_KEY, Date\.now\(\)/);
const item=fs.readFileSync("items/mcity/mine_phone.json","utf8"); assert.match(item,/minecraft:durability/); assert.match(item,/max_durability/);
assert.match(router,/MinePhoneService\.battery/);
console.log("Mine Phone battery/session checks passed.");
