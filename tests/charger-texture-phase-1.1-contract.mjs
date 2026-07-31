import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
const root=process.cwd();
for(const file of ["mine_phone_charger.png","mine_phone_charger_top.png","mine_phone_charger_side.png","mine_phone_charger_bottom.png"]) assert.ok(fs.existsSync(path.join(root,"resource_packs/mcity_resources/textures/mcity/items",file)));
for(const file of ["charger_powered_top.png","charger_powered_side.png","charger_charging_top.png","charger_charging_side.png"]) assert.ok(fs.existsSync(path.join(root,"resource_packs/mcity_resources/textures/mcity/charger_states",file)));
for(const file of ["mcity_charger_powered.particle.json","mcity_charger_charging.particle.json","mcity_charger_spark.particle.json"]) { const data=JSON.parse(fs.readFileSync(path.join(root,"resource_packs/mcity_resources/particles",file))); assert.ok(data.particle_effect?.description?.identifier); }
console.log("Charger texture and particle asset checks passed.");
