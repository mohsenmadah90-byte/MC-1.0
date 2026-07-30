import assert from "node:assert/strict";
import { CustomItemRegistry, CARD_COLORS } from "../scripts/core/customItemRegistry.js";

assert.equal(CARD_COLORS.length, 16);
assert.equal(CustomItemRegistry.cards().length, 16);
assert.equal(CustomItemRegistry.all().length, 18);
assert.equal(CustomItemRegistry.isCharger("mcity:mine_phone_charger"), true);
assert.equal(new Set(CustomItemRegistry.all().map(item => item.id)).size, 18);
for (const color of CARD_COLORS) {
    const item = CustomItemRegistry.get(`mcity:personal_card_${color}`);
    assert.ok(item);
    assert.equal(item.type, "personal_card");
    assert.equal(item.color, color);
    assert.equal(item.stackSize, 1);
    assert.equal(item.marketable, false);
    assert.equal(item.contractable, false);
    assert.equal(item.requiresIdentity, true);
    assert.match(item.texturePath, /^textures\/items\/personal_card_/);
}
const phone = CustomItemRegistry.get("mcity:mine_phone");
assert.ok(phone);
assert.equal(phone.type, "mine_phone");
assert.equal(phone.stackSize, 1);
assert.equal(phone.marketable, false);
assert.equal(phone.contractable, false);
assert.equal(phone.requiresIdentity, true);

console.log("Custom item registry checks passed: 16 cards + Mine Phone.");
