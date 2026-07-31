import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
const root=process.cwd();
for(const id of ["wall_atm","floor_atm","floor_atm_bottom"]){
 const file=JSON.parse(fs.readFileSync(path.join(root,`blocks/mcity/${id}.json`),"utf8"));
 assert.match(file["minecraft:block"].description.identifier,/^mcity:/);
 assert.ok(file["minecraft:block"].components["tag:mcity:atm"]);
}
for(const file of ["wall_atm.geo.json","floor_atm_top.geo.json","floor_atm_bottom.geo.json"]){assert.ok(fs.existsSync(path.join(root,"resource_packs/mcity_resources/models/blocks/mcity",file)));}
for(const file of ["wall_atm.png","floor_atm_bottom.png","atm_bottom.png"]){assert.ok(fs.existsSync(path.join(root,"resource_packs/mcity_resources/textures/mcity/blocks",file)));}
const config=fs.readFileSync("scripts/config.js","utf8"); assert.match(config,/ATM_BLOCK_VARIANTS/);
console.log("ATM appearance and block integration checks passed.");
