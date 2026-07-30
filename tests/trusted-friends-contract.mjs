import assert from "node:assert/strict";
import fs from "node:fs";
const ui=fs.readFileSync("scripts/modules/land/landUI.js","utf8");
assert.match(ui,/FriendService\.list\(player\)/);
assert.doesNotMatch(ui,/const players = PlayerRegistry\.online\(\)\.filter/);
console.log("Land trusted friend-only selection checks passed.");
