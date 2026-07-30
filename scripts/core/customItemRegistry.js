// MCity Dashboard V2 - Custom Item Registry
// Phase 1.1: canonical definitions for identity cards and Mine Phone.

const CARD_COLORS = Object.freeze([
    "white", "orange", "magenta", "light_blue", "yellow", "lime", "pink", "gray",
    "light_gray", "cyan", "purple", "blue", "brown", "green", "red", "black"
]);

const CARD_DISPLAY_NAMES = Object.freeze({
    white: "White Personal Card", orange: "Orange Personal Card", magenta: "Magenta Personal Card",
    light_blue: "Light Blue Personal Card", yellow: "Yellow Personal Card", lime: "Lime Personal Card",
    pink: "Pink Personal Card", gray: "Gray Personal Card", light_gray: "Light Gray Personal Card",
    cyan: "Cyan Personal Card", purple: "Purple Personal Card", blue: "Blue Personal Card",
    brown: "Brown Personal Card", green: "Green Personal Card", red: "Red Personal Card",
    black: "Black Personal Card"
});

const definitions = {};
for (const color of CARD_COLORS) {
    definitions[`mcity:personal_card_${color}`] = Object.freeze({
        id: `mcity:personal_card_${color}`,
        type: "personal_card",
        color,
        displayName: CARD_DISPLAY_NAMES[color],
        textureKey: `mcity_personal_card_${color}`,
        texturePath: `textures/items/personal_card_${color}`,
        stackSize: 1,
        marketable: false,
        contractable: false,
        adminOnly: false,
        requiresIdentity: true,
        version: 1
    });
}

definitions["mcity:mine_phone"] = Object.freeze({
    id: "mcity:mine_phone",
    type: "mine_phone",
    displayName: "Mine Phone",
    textureKey: "mcity_mine_phone",
    texturePath: "textures/items/mine_phone",
    stackSize: 1,
    marketable: false,
    contractable: false,
    adminOnly: false,
    requiresIdentity: true,
    version: 1
});

const CUSTOM_ITEMS = Object.freeze(definitions);

export class CustomItemRegistry {
    static all() { return Object.values(CUSTOM_ITEMS); }
    static cards() { return this.all().filter(item => item.type === "personal_card"); }
    static get(id) { return CUSTOM_ITEMS[String(id || "").toLowerCase()] || null; }
    static isCustom(id) { return !!this.get(id); }
    static isPersonalCard(id) { return this.get(id)?.type === "personal_card"; }
    static isMinePhone(id) { return this.get(id)?.type === "mine_phone"; }
    static colors() { return CARD_COLORS; }
}

export { CARD_COLORS, CUSTOM_ITEMS };
export default CustomItemRegistry;
