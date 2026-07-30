import assert from "node:assert/strict";
import fs from "node:fs";
const s=fs.readFileSync("scripts/modules/friends/friendService.js","utf8"); const u=fs.readFileSync("scripts/modules/friends/friendUI.js","utf8"); const c=fs.readFileSync("scripts/config.js","utf8");
assert.match(s,/MoneyService\.transfer/); assert.match(s,/sendGift/); assert.match(s,/lastGiftAt/); assert.match(s,/GIFT_COOLDOWN_MS/); assert.match(s,/gifts/); assert.match(u,/Send Money/); assert.match(u,/Send Gift/); assert.match(c,/ALLOWED_GIFT_ITEMS/);
console.log("Friends money and gift policy checks passed.");
