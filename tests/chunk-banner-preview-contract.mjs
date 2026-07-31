import assert from "node:assert/strict";
import fs from "node:fs";

const config = fs.readFileSync("scripts/config.js", "utf8");
const service = fs.readFileSync("scripts/modules/land/landService.js", "utf8");
const ui = fs.readFileSync("scripts/modules/land/landUI.js", "utf8");
const protection = fs.readFileSync("scripts/modules/land/landProtection.js", "utf8");

assert.match(config, /CLAIM_PREVIEW_MARKER_BLOCK: "minecraft:white_banner"/);
assert.match(service, /minecraft:white_banner/);
assert.match(service, /isClaimPreviewLocation/);
assert.match(service, /expiresAt/);
assert.match(ui, /Show Chunk/);
assert.match(ui, /Four white banners placed/);
assert.match(ui, /Confirm Claim Purchase/);
assert.match(protection, /isClaimPreviewLocation/);
assert.match(protection, /Preview banners are display-only/);
assert.match(protection, /Preview marker placement compensation failed/);

console.log("Chunk banner preview contract checks passed.");
