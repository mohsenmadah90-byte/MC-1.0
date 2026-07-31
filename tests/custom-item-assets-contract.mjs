import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const colors = ["white","orange","magenta","light_blue","yellow","lime","pink","gray","light_gray","cyan","purple","blue","brown","green","red","black"];
const readJson = file => JSON.parse(fs.readFileSync(file, "utf8"));
const root = process.cwd();
const rpManifest = readJson(path.join(root, "resource_packs/mcity_resources/manifest.json"));
const manifest = readJson(path.join(root, "manifest.json"));
const rpUuid = rpManifest.header.uuid;
assert.ok(manifest.dependencies.some(dep => dep.uuid === rpUuid));
const texture = readJson(path.join(root, "resource_packs/mcity_resources/textures/item_texture.json"));
for (const color of colors) {
    const item = readJson(path.join(root, `items/mcity/personal_card/${color}.json`));
    assert.equal(item["minecraft:item"].description.identifier, `mcity:personal_card_${color}`);
    assert.ok(texture.texture_data[`mcity_personal_card_${color}`]);
    assert.ok(fs.existsSync(path.join(root, `resource_packs/mcity_resources/textures/mcity/cards/${color}.png`)));
    const recipe = readJson(path.join(root, `recipes/mcity/personal_card/${color}.json`));
    assert.equal(recipe["minecraft:recipe_shapeless"].result.item, `mcity:personal_card_${color}`);
    const phoneRecipe = readJson(path.join(root, `recipes/mcity/mine_phone_${color}.json`));
    assert.equal(phoneRecipe["minecraft:recipe_shaped"].key.C, `mcity:personal_card_${color}`);
    assert.deepEqual(phoneRecipe["minecraft:recipe_shaped"].pattern, ["ILI", "CGN", "IGI"]);
    assert.equal(phoneRecipe["minecraft:recipe_shaped"].key.L, "minecraft:lightning_rod");
}
const charger = readJson(path.join(root, "items/mcity/mine_phone_charger.json"));
assert.equal(charger["minecraft:item"].description.identifier, "mcity:mine_phone_charger");
const chargerRecipe = readJson(path.join(root, "recipes/mcity/mine_phone_charger.json"));
assert.equal(chargerRecipe["minecraft:recipe_shaped"].result.item, "mcity:mine_phone_charger");
const phone = readJson(path.join(root, "items/mcity/mine_phone.json"));
assert.equal(phone["minecraft:item"].description.identifier, "mcity:mine_phone");
assert.ok(texture.texture_data.mcity_mine_phone);
assert.ok(fs.existsSync(path.join(root, "resource_packs/mcity_resources/textures/mcity/items/mine_phone.png")));
console.log("Custom item asset contracts passed: 16 cards, 16 phone recipes, Mine Phone texture.");
