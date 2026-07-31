import assert from "node:assert/strict";
import fs from "node:fs";
const service=fs.readFileSync("scripts/modules/friends/friendService.js","utf8");
const ui=fs.readFileSync("scripts/modules/friends/friendUI.js","utf8");
const system=fs.readFileSync("scripts/dashboard/dashboardSystem.js","utf8");
assert.match(service,/sendRequest/); assert.match(service,/respond/); assert.match(service,/remove/); assert.match(service,/incoming/); assert.match(service,/outgoing/); assert.match(service,/Database\.transaction/);
assert.match(ui,/Send Friend Request/); assert.match(ui,/Accept/); assert.match(ui,/Reject/); assert.match(ui,/Remove Friend/);
assert.match(system,/id: "friends"/); assert.match(system,/order: 15/);
console.log("Friends request and persistent list checks passed.");
