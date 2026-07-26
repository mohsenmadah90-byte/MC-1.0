import assert from "node:assert/strict";
import fs from "node:fs";

const config = fs.readFileSync("scripts/config.js", "utf8");
const compat = fs.readFileSync("scripts/core/bedrockCompat.js", "utf8");
const main = fs.readFileSync("scripts/main.js", "utf8");
const village = fs.readFileSync("scripts/modules/village/villageProtection.js", "utf8");

assert.match(config, /VILLAGE_PROTECTION:/);
assert.match(config, /TELEPORT_ESCAPED_VILLAGERS: true/);
assert.match(config, /ALLOWED_INTERACTION_BLOCKS/);
assert.match(compat, /entity\.interact\.before/);
assert.match(village, /minecraft:villager/);
assert.match(village, /getEntities\(\{ type: "minecraft:villager" \}\)/);
assert.match(village, /block\.break\.before/);
assert.match(village, /block\.place\.before/);
assert.match(village, /block\.place\.after/);
assert.match(village, /block\.interact\.before/);
assert.match(village, /explosion\.before/);
assert.match(village, /entity\.hurt\.after/);
assert.match(village, /teleport/);
assert.match(village, /ALLOWED_INTERACTION_BLOCKS/);
assert.match(main, /VillageProtection\.initialize\(\)/);
assert.match(main, /VillageProtection\.shutdown\(\)/);

console.log("Village protection contract checks passed.");
