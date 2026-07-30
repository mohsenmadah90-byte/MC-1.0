import assert from "node:assert/strict";
import fs from "node:fs";
const service=fs.readFileSync("scripts/modules/friends/friendService.js","utf8");
const ui=fs.readFileSync("scripts/modules/friends/friendUI.js","utf8");
assert.match(service,/sendMessage/); assert.match(service,/messages/); assert.match(service,/markMessageRead/); assert.match(service,/You have a new message from/); assert.match(service,/Message cannot be empty/); assert.match(ui,/Send Message/); assert.match(ui,/Received Messages/); assert.match(ui,/ModalFormData/);
console.log("Friends messaging contract checks passed.");
