// MCity Dashboard V2 - Minecraft Item Catalog Core
// UX Phase 4 (v1.7.3): Searchable item catalog for player-friendly item selection.
// Catalog data is generated from the Bedrock reference workbook; legacy policy metadata is preserved.

import { GENERATED_CATALOG } from "../data/catalog.js";
//
// This catalog intentionally starts with the most economy-relevant vanilla
// Bedrock items instead of every possible block/item. It is designed to be
// expanded safely over time.

function item(id, name, category, icon, aliases = [], options = {}) {
    return {
        id,
        name,
        category,
        icon: icon || "",
        aliases,
        stackSize: options.stackSize || 64,
        marketable: options.marketable !== false,
        contractable: options.contractable !== false,
        adminOnly: !!options.adminOnly,
        dangerous: !!options.dangerous
    };
}

export const ITEM_CATEGORIES = {
    materials: "Materials",
    ores: "Ores & Raw Materials",
    farming: "Farming",
    food: "Food",
    wood: "Wood",
    stone: "Stone & Building",
    redstone: "Redstone",
    combat: "Combat",
    tools: "Tools",
    armor: "Armor",
    decoration: "Decoration",
    misc: "Misc"
};

const LEGACY_ITEM_CATALOG = Object.freeze([
    // Materials / currency-like resources
    item("minecraft:coal", "Coal", "materials", "textures/items/coal", ["charcoal fuel", "زغال"]),
    item("minecraft:charcoal", "Charcoal", "materials", "textures/items/charcoal", ["coal fuel", "زغال چوب"]),
    item("minecraft:iron_ingot", "Iron Ingot", "materials", "textures/items/iron_ingot", ["iron metal ingot", "آهن", "شمش آهن"]),
    item("minecraft:gold_ingot", "Gold Ingot", "materials", "textures/items/gold_ingot", ["gold metal ingot", "طلا", "شمش طلا"]),
    item("minecraft:copper_ingot", "Copper Ingot", "materials", "textures/items/copper_ingot", ["copper metal ingot", "مس", "شمش مس"]),
    item("minecraft:netherite_ingot", "Netherite Ingot", "materials", "textures/items/netherite_ingot", ["netherite", "نذرایت"]),
    item("minecraft:emerald", "Emerald", "materials", "textures/items/emerald", ["villager currency", "زمرد"]),
    item("minecraft:diamond", "Diamond", "materials", "textures/items/diamond", ["gem", "الماس"]),
    item("minecraft:quartz", "Nether Quartz", "materials", "textures/items/quartz", ["quartz", "کوارتز"]),
    item("minecraft:lapis_lazuli", "Lapis Lazuli", "materials", "textures/items/dye_powder_blue", ["lapis blue dye", "لاجورد"]),
    item("minecraft:redstone", "Redstone Dust", "materials", "textures/items/redstone_dust", ["redstone dust", "ردستون"]),
    item("minecraft:amethyst_shard", "Amethyst Shard", "materials", "textures/items/amethyst_shard", ["amethyst crystal", "آمتیست"]),
    item("minecraft:clay_ball", "Clay Ball", "materials", "textures/items/clay_ball", ["clay", "رس"]),
    item("minecraft:brick", "Brick", "materials", "textures/items/brick", ["clay brick", "آجر"]),
    item("minecraft:flint", "Flint", "materials", "textures/items/flint", ["gravel drop", "سنگ چخماق"]),
    item("minecraft:string", "String", "materials", "textures/items/string", ["spider thread", "نخ"]),
    item("minecraft:leather", "Leather", "materials", "textures/items/leather", ["cow hide", "چرم"]),
    item("minecraft:feather", "Feather", "materials", "textures/items/feather", ["chicken", "پر"]),
    item("minecraft:gunpowder", "Gunpowder", "materials", "textures/items/gunpowder", ["creeper", "باروت"]),
    item("minecraft:slime_ball", "Slimeball", "materials", "textures/items/slimeball", ["slime", "اسلایم"]),
    item("minecraft:bone", "Bone", "materials", "textures/items/bone", ["skeleton", "استخوان"]),
    item("minecraft:bone_meal", "Bone Meal", "materials", "textures/items/dye_powder_white", ["fertilizer", "پودر استخوان"]),
    item("minecraft:blaze_rod", "Blaze Rod", "materials", "textures/items/blaze_rod", ["blaze", "میله بلیز"]),
    item("minecraft:ender_pearl", "Ender Pearl", "materials", "textures/items/ender_pearl", ["enderman", "مروارید اندر"]),

    // Ores / raw
    item("minecraft:raw_iron", "Raw Iron", "ores", "textures/items/raw_iron", ["iron raw", "آهن خام"]),
    item("minecraft:raw_gold", "Raw Gold", "ores", "textures/items/raw_gold", ["gold raw", "طلای خام"]),
    item("minecraft:raw_copper", "Raw Copper", "ores", "textures/items/raw_copper", ["copper raw", "مس خام"]),
    item("minecraft:coal_ore", "Coal Ore", "ores", "textures/blocks/coal_ore", ["ore coal", "سنگ زغال"]),
    item("minecraft:iron_ore", "Iron Ore", "ores", "textures/blocks/iron_ore", ["ore iron", "سنگ آهن"]),
    item("minecraft:gold_ore", "Gold Ore", "ores", "textures/blocks/gold_ore", ["ore gold", "سنگ طلا"]),
    item("minecraft:copper_ore", "Copper Ore", "ores", "textures/blocks/copper_ore", ["ore copper", "سنگ مس"]),
    item("minecraft:diamond_ore", "Diamond Ore", "ores", "textures/blocks/diamond_ore", ["ore diamond", "سنگ الماس"]),
    item("minecraft:emerald_ore", "Emerald Ore", "ores", "textures/blocks/emerald_ore", ["ore emerald", "سنگ زمرد"]),
    item("minecraft:redstone_ore", "Redstone Ore", "ores", "textures/blocks/redstone_ore", ["ore redstone", "سنگ ردستون"]),
    item("minecraft:lapis_ore", "Lapis Ore", "ores", "textures/blocks/lapis_ore", ["ore lapis", "سنگ لاجورد"]),
    item("minecraft:ancient_debris", "Ancient Debris", "ores", "textures/blocks/ancient_debris_side", ["netherite debris", "دبریس"]),

    // Farming
    item("minecraft:wheat", "Wheat", "farming", "textures/items/wheat", ["crop", "گندم"]),
    item("minecraft:wheat_seeds", "Wheat Seeds", "farming", "textures/items/seeds_wheat", ["seeds", "دانه گندم"]),
    item("minecraft:carrot", "Carrot", "farming", "textures/items/carrot", ["crop food", "هویج"]),
    item("minecraft:potato", "Potato", "farming", "textures/items/potato", ["crop food", "سیب زمینی"]),
    item("minecraft:beetroot", "Beetroot", "farming", "textures/items/beetroot", ["crop food", "چغندر"]),
    item("minecraft:beetroot_seeds", "Beetroot Seeds", "farming", "textures/items/seeds_beetroot", ["seeds", "دانه چغندر"]),
    item("minecraft:pumpkin", "Pumpkin", "farming", "textures/blocks/pumpkin_side", ["کدو"]),
    item("minecraft:melon_block", "Melon", "farming", "textures/blocks/melon_side", ["melon block", "هندوانه"]),
    item("minecraft:melon_slice", "Melon Slice", "food", "textures/items/melon", ["melon food", "قاچ هندوانه"]),
    item("minecraft:sugar_cane", "Sugar Cane", "farming", "textures/items/reeds", ["reeds paper", "نیشکر"]),
    item("minecraft:cactus", "Cactus", "farming", "textures/blocks/cactus_side", ["کاکتوس"]),
    item("minecraft:bamboo", "Bamboo", "farming", "textures/items/bamboo", ["بامبو"]),
    item("minecraft:cocoa_beans", "Cocoa Beans", "farming", "textures/items/dye_powder_brown", ["cocoa", "کاکائو"]),
    item("minecraft:sweet_berries", "Sweet Berries", "food", "textures/items/sweet_berries", ["berries", "بری"]),
    item("minecraft:kelp", "Kelp", "farming", "textures/items/kelp", ["کلپ"]),

    // Food
    item("minecraft:apple", "Apple", "food", "textures/items/apple", ["سیب"]),
    item("minecraft:bread", "Bread", "food", "textures/items/bread", ["نان"]),
    item("minecraft:cooked_beef", "Steak", "food", "textures/items/beef_cooked", ["beef food", "استیک"]),
    item("minecraft:beef", "Raw Beef", "food", "textures/items/beef_raw", ["raw meat", "گوشت گاو"]),
    item("minecraft:cooked_chicken", "Cooked Chicken", "food", "textures/items/chicken_cooked", ["مرغ پخته"]),
    item("minecraft:chicken", "Raw Chicken", "food", "textures/items/chicken_raw", ["مرغ خام"]),
    item("minecraft:cooked_porkchop", "Cooked Porkchop", "food", "textures/items/porkchop_cooked", ["pork", "گوشت خوک"]),
    item("minecraft:cooked_mutton", "Cooked Mutton", "food", "textures/items/mutton_cooked", ["mutton", "گوشت گوسفند"]),
    item("minecraft:cooked_cod", "Cooked Cod", "food", "textures/items/fish_cod_cooked", ["fish cod", "ماهی پخته"]),
    item("minecraft:cookie", "Cookie", "food", "textures/items/cookie", ["کلوچه"]),
    item("minecraft:cake", "Cake", "food", "textures/items/cake", ["کیک"]),
    item("minecraft:golden_carrot", "Golden Carrot", "food", "textures/items/carrot_golden", ["gold carrot", "هویج طلایی"]),

    // Wood
    item("minecraft:oak_log", "Oak Log", "wood", "textures/blocks/log_oak", ["oak wood log", "چوب بلوط"]),
    item("minecraft:spruce_log", "Spruce Log", "wood", "textures/blocks/log_spruce", ["spruce wood log", "چوب صنوبر"]),
    item("minecraft:birch_log", "Birch Log", "wood", "textures/blocks/log_birch", ["birch wood log", "چوب توس"]),
    item("minecraft:jungle_log", "Jungle Log", "wood", "textures/blocks/log_jungle", ["jungle wood log"]),
    item("minecraft:acacia_log", "Acacia Log", "wood", "textures/blocks/log_acacia", ["acacia wood log"]),
    item("minecraft:dark_oak_log", "Dark Oak Log", "wood", "textures/blocks/log_big_oak", ["dark oak wood log"]),
    item("minecraft:mangrove_log", "Mangrove Log", "wood", "textures/blocks/mangrove_log_side", ["mangrove wood log"]),
    item("minecraft:cherry_log", "Cherry Log", "wood", "textures/blocks/cherry_log_side", ["cherry wood log"]),
    item("minecraft:oak_planks", "Oak Planks", "wood", "textures/blocks/planks_oak", ["planks oak", "تخته بلوط"]),
    item("minecraft:spruce_planks", "Spruce Planks", "wood", "textures/blocks/planks_spruce", ["planks spruce"]),
    item("minecraft:stick", "Stick", "wood", "textures/items/stick", ["wood stick", "چوب دستی"]),

    // Stone / building
    item("minecraft:cobblestone", "Cobblestone", "stone", "textures/blocks/cobblestone", ["stone", "قلوه سنگ"]),
    item("minecraft:stone", "Stone", "stone", "textures/blocks/stone", ["سنگ"]),
    item("minecraft:deepslate", "Deepslate", "stone", "textures/blocks/deepslate", ["دیپ اسلیت"]),
    item("minecraft:dirt", "Dirt", "stone", "textures/blocks/dirt", ["خاک"]),
    item("minecraft:grass_block", "Grass Block", "stone", "textures/blocks/grass_side_carried", ["grass", "چمن"]),
    item("minecraft:sand", "Sand", "stone", "textures/blocks/sand", ["شن"]),
    item("minecraft:red_sand", "Red Sand", "stone", "textures/blocks/red_sand", ["شن قرمز"]),
    item("minecraft:gravel", "Gravel", "stone", "textures/blocks/gravel", ["ریگ"]),
    item("minecraft:glass", "Glass", "stone", "textures/blocks/glass", ["شیشه"]),
    item("minecraft:obsidian", "Obsidian", "stone", "textures/blocks/obsidian", ["portal", "ابسیدین"]),
    item("minecraft:netherrack", "Netherrack", "stone", "textures/blocks/netherrack", ["nether rack"]),
    item("minecraft:end_stone", "End Stone", "stone", "textures/blocks/end_stone", ["end"]),
    item("minecraft:basalt", "Basalt", "stone", "textures/blocks/basalt_side", ["بازالت"]),
    item("minecraft:calcite", "Calcite", "stone", "textures/blocks/calcite", ["کلسیت"]),
    item("minecraft:tuff", "Tuff", "stone", "textures/blocks/tuff", ["تاف"]),

    // Redstone
    item("minecraft:redstone_torch", "Redstone Torch", "redstone", "textures/blocks/redstone_torch_on", ["torch redstone"]),
    item("minecraft:repeater", "Redstone Repeater", "redstone", "textures/items/repeater", ["repeater"]),
    item("minecraft:comparator", "Redstone Comparator", "redstone", "textures/items/comparator", ["comparator"]),
    item("minecraft:piston", "Piston", "redstone", "textures/blocks/piston_top_normal", ["پیستون"]),
    item("minecraft:sticky_piston", "Sticky Piston", "redstone", "textures/blocks/piston_top_sticky", ["sticky piston"]),
    item("minecraft:hopper", "Hopper", "redstone", "textures/items/hopper", ["هاپر"]),
    item("minecraft:observer", "Observer", "redstone", "textures/blocks/observer_front", ["observer"]),
    item("minecraft:dispenser", "Dispenser", "redstone", "textures/blocks/dispenser_front_horizontal", ["dispenser"]),
    item("minecraft:dropper", "Dropper", "redstone", "textures/blocks/dropper_front_horizontal", ["dropper"]),

    // Combat / tools / armor
    item("minecraft:wooden_sword", "Wooden Sword", "combat", "textures/items/wood_sword", ["sword"], { stackSize: 1 }),
    item("minecraft:stone_sword", "Stone Sword", "combat", "textures/items/stone_sword", ["sword"], { stackSize: 1 }),
    item("minecraft:iron_sword", "Iron Sword", "combat", "textures/items/iron_sword", ["sword iron"], { stackSize: 1 }),
    item("minecraft:diamond_sword", "Diamond Sword", "combat", "textures/items/diamond_sword", ["sword diamond"], { stackSize: 1 }),
    item("minecraft:bow", "Bow", "combat", "textures/items/bow_standby", ["کمان"], { stackSize: 1 }),
    item("minecraft:arrow", "Arrow", "combat", "textures/items/arrow", ["تیر"]),
    item("minecraft:shield", "Shield", "combat", "textures/items/shield", ["سپر"], { stackSize: 1 }),
    item("minecraft:iron_pickaxe", "Iron Pickaxe", "tools", "textures/items/iron_pickaxe", ["pickaxe iron کلنگ"], { stackSize: 1 }),
    item("minecraft:diamond_pickaxe", "Diamond Pickaxe", "tools", "textures/items/diamond_pickaxe", ["pickaxe diamond کلنگ"], { stackSize: 1 }),
    item("minecraft:iron_axe", "Iron Axe", "tools", "textures/items/iron_axe", ["axe iron تبر"], { stackSize: 1 }),
    item("minecraft:diamond_axe", "Diamond Axe", "tools", "textures/items/diamond_axe", ["axe diamond تبر"], { stackSize: 1 }),
    item("minecraft:iron_shovel", "Iron Shovel", "tools", "textures/items/iron_shovel", ["shovel بیل"], { stackSize: 1 }),
    item("minecraft:diamond_shovel", "Diamond Shovel", "tools", "textures/items/diamond_shovel", ["shovel diamond بیل"], { stackSize: 1 }),
    item("minecraft:iron_helmet", "Iron Helmet", "armor", "textures/items/iron_helmet", ["helmet armor"], { stackSize: 1 }),
    item("minecraft:iron_chestplate", "Iron Chestplate", "armor", "textures/items/iron_chestplate", ["chestplate armor"], { stackSize: 1 }),
    item("minecraft:diamond_helmet", "Diamond Helmet", "armor", "textures/items/diamond_helmet", ["helmet armor"], { stackSize: 1 }),
    item("minecraft:diamond_chestplate", "Diamond Chestplate", "armor", "textures/items/diamond_chestplate", ["chestplate armor"], { stackSize: 1 }),

    // Decoration / misc
    item("minecraft:torch", "Torch", "decoration", "textures/blocks/torch_on", ["مشعل"]),
    item("minecraft:lantern", "Lantern", "decoration", "textures/items/lantern", ["فانوس"]),
    item("minecraft:chest", "Chest", "decoration", "textures/blocks/chest_front", ["storage صندوق"]),
    item("minecraft:barrel", "Barrel", "decoration", "textures/blocks/barrel_side", ["storage بشکه"]),
    item("minecraft:crafting_table", "Crafting Table", "decoration", "textures/blocks/crafting_table_front", ["workbench میز کار"]),
    item("minecraft:furnace", "Furnace", "decoration", "textures/blocks/furnace_front_off", ["کوره"]),
    item("minecraft:paper", "Paper", "misc", "textures/items/paper", ["کاغذ"]),
    item("minecraft:book", "Book", "misc", "textures/items/book_normal", ["کتاب"]),
    item("minecraft:name_tag", "Name Tag", "misc", "textures/items/name_tag", ["name tag"]),
    item("minecraft:saddle", "Saddle", "misc", "textures/items/saddle", ["زین"]),
    item("minecraft:flint_and_steel", "Flint and Steel", "misc", "textures/items/flint_and_steel", ["lighter fire فندک"], { stackSize: 1, contractable: false, dangerous: true }),
    item("minecraft:tnt", "TNT", "misc", "textures/blocks/tnt_side", ["explosive دینامیت"], { dangerous: true }),
    item("minecraft:ender_chest", "Ender Chest", "misc", "textures/blocks/ender_chest_front", ["ender storage"], { stackSize: 64 }),

    // Explicitly catalogued but not normal-trade safe
    item("minecraft:bedrock", "Bedrock", "misc", "textures/blocks/bedrock", ["admin banned"], { marketable: false, contractable: false, adminOnly: true, dangerous: true }),
    item("minecraft:barrier", "Barrier", "misc", "textures/blocks/barrier", ["admin banned"], { marketable: false, contractable: false, adminOnly: true, dangerous: true }),
    item("minecraft:command_block", "Command Block", "misc", "textures/blocks/command_block", ["admin banned"], { marketable: false, contractable: false, adminOnly: true, dangerous: true })
]);

const LEGACY_BY_ID = new Map(LEGACY_ITEM_CATALOG.map(item => [item.id, item]));

function generatedCategory(tab, isBlock) {
    const value = String(tab || "").toLowerCase();
    if (value.includes("redstone")) return "redstone";
    if (value.includes("food")) return "food";
    if (value.includes("nature") || value.includes("farming")) return "farming";
    if (value.includes("combat")) return "combat";
    if (value.includes("tools")) return "tools";
    if (value.includes("building")) return "stone";
    if (value.includes("equipment")) return "armor";
    if (value.includes("transport")) return "misc";
    if (value.includes("decoration")) return "decoration";
    return isBlock ? "stone" : "misc";
}

// Merge the complete raw reference catalog with the existing economy policy.
// New records are deliberately non-tradeable until explicitly approved.
export const ITEM_CATALOG = Object.freeze(GENERATED_CATALOG.map(raw => {
    const legacy = LEGACY_BY_ID.get(raw.id);
    return {
        ...item(raw.id, legacy?.name || raw.englishName, legacy?.category || generatedCategory(raw.creativeTab, raw.isBlock), legacy?.icon || "", legacy?.aliases || [raw.persianName].filter(Boolean), {
            stackSize: legacy?.stackSize || 64,
            marketable: legacy?.marketable === true,
            contractable: legacy?.contractable === true,
            adminOnly: legacy?.adminOnly || raw.id.includes("command_block") || ["minecraft:barrier", "minecraft:bedrock"].includes(raw.id),
            dangerous: legacy?.dangerous || /tnt|lava|fire|spawn_egg|command|barrier|bedrock/.test(raw.id)
        }),
        englishName: raw.englishName,
        persianName: raw.persianName,
        numericId: raw.numericId,
        creativeTab: raw.creativeTab,
        isBlock: raw.isBlock,
        isItem: raw.isItem,
        sourceVersion: raw.sourceVersion
    };
}));

const ITEM_BY_ID = new Map(ITEM_CATALOG.map(i => [i.id, i]));

export class ItemCatalog {
    static all() { return ITEM_CATALOG; }
    static categories() { return ITEM_CATEGORIES; }
    static get(id) { return ITEM_BY_ID.get(this.normalizeId(id)) || null; }
    static normalizeId(id) { const raw = String(id || "").trim().toLowerCase(); return raw.includes(":") ? raw : `minecraft:${raw}`; }

    static forMode(mode = "any") {
        if (mode === "contract") return ITEM_CATALOG.filter(i => i.contractable && !i.adminOnly);
        if (mode === "market") return ITEM_CATALOG.filter(i => i.marketable && !i.adminOnly);
        if (mode === "admin") return ITEM_CATALOG.filter(i => i.marketable || i.contractable || i.adminOnly);
        return ITEM_CATALOG;
    }

    static search(query = "", { mode = "any", category = null, limit = 20 } = {}) {
        const q = this.#normalizeQuery(query);
        let pool = this.forMode(mode);
        if (category) pool = pool.filter(i => i.category === category);
        if (!q) return pool.slice(0, Math.max(1, Math.min(5000, limit)));
        const scored = [];
        for (const it of pool) {
            const score = this.#score(it, q);
            if (score > 0) scored.push({ item: it, score });
        }
        scored.sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name));
        return scored.slice(0, Math.max(1, Math.min(5000, limit))).map(x => x.item);
    }

    static isAllowed(id, mode = "any") {
        const it = this.get(id);
        if (!it) return false;
        if (mode === "contract") return it.contractable && !it.adminOnly;
        if (mode === "market") return it.marketable && !it.adminOnly;
        if (mode === "admin") return true;
        return true;
    }

    static #normalizeQuery(q) {
        return String(q || "").trim().toLowerCase().replace(/^minecraft:/, "").replace(/[_-]+/g, " ");
    }

    static #score(it, q) {
        const id = it.id.replace("minecraft:", "").replace(/_/g, " ");
        const name = it.name.toLowerCase();
        const aliases = (it.aliases || []).map(a => String(a).toLowerCase());
        if (id === q || it.id === `minecraft:${q}`) return 100;
        if (name === q) return 95;
        if (name.startsWith(q)) return 80;
        if (aliases.some(a => a === q)) return 75;
        if (id.startsWith(q)) return 65;
        if (name.includes(q)) return 55;
        if (id.includes(q)) return 45;
        if (aliases.some(a => a.includes(q))) return 35;
        return 0;
    }
}

export default ItemCatalog;
