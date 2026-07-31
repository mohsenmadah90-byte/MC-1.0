// MCity Dashboard V2 - Item Settings Service
// v1.8.5: Merges static item catalog with admin flag overrides.

import { Database } from "./database.js";
import { Logger } from "./logger.js";
import { ItemCatalog } from "./itemCatalog.js";
import { DEFAULT_ITEM_SETTINGS_DB, validateItemSettingsData } from "../schemas/itemSettingsSchema.js";
import { DisposableRegistry } from "./disposableRegistry.js";
import { ITEM_PRICING_DEFAULTS as MARKET_PRICING_DEFAULTS } from "./itemCatalog.js";

const ATM_ANCHOR_ITEMS = new Set(["minecraft:copper_ingot", "minecraft:iron_ingot", "minecraft:emerald", "minecraft:gold_ingot", "minecraft:diamond", "minecraft:netherite_scrap"]);
const COLLECTION = "item_settings";
function now() { return Date.now(); }

export class ItemSettingsService {
    static #initialized = false;

    static initialize() {
        if (this.#initialized) return;
        this.#initialized = true;
        this.db();
        DisposableRegistry.registerShutdownCleanup("ItemSettingsService.lifecycle", () => { this.#initialized = false; });
        Logger.startup("ItemSettings", "Item settings service initialized");
    }

    static db() { return Database.collection(COLLECTION, DEFAULT_ITEM_SETTINGS_DB, { validate: validateItemSettingsData }); }
    static normalizeId(id) { return ItemCatalog.normalizeId(id); }
    static overrideFor(id) { return this.db().overrides[this.normalizeId(id)] || null; }

    static effective(itemOrId) {
        const base = typeof itemOrId === "string" ? ItemCatalog.get(itemOrId) : itemOrId;
        if (!base) return null;
        const override = this.overrideFor(base.id) || {};
        const pricing = MARKET_PRICING_DEFAULTS[base.id] || {};
        return {
            ...base,
            ...pricing,
            ...override,
            baseBuyPrice: override.baseBuyPriceCents ?? pricing.baseBuyPriceCents ?? base.baseBuyPrice,
            baseSellPrice: override.baseSellPriceCents ?? pricing.baseSellPriceCents ?? base.baseSellPrice,
            minPrice: override.minPriceCents ?? pricing.minPriceCents ?? base.minPrice,
            maxPrice: override.maxPriceCents ?? pricing.maxPriceCents ?? base.maxPrice,
            marketable: ATM_ANCHOR_ITEMS.has(base.id) ? false : (override.marketable ?? base.marketable ?? false),
            contractable: ATM_ANCHOR_ITEMS.has(base.id) ? false : (override.contractable ?? base.contractable ?? false),
            override: Object.keys(override).length ? override : null
        };
    }

    static isATMAnchor(id) { return ATM_ANCHOR_ITEMS.has(this.normalizeId(id)); }

    static isMarketable(id) {
        const item = this.effective(id);
        return !!(item && !ATM_ANCHOR_ITEMS.has(item.id) && item.marketable && !item.adminOnly);
    }

    static isContractable(id) {
        const item = this.effective(id);
        return !!(item && !ATM_ANCHOR_ITEMS.has(item.id) && item.contractable && !item.adminOnly);
    }

    static all(mode = "any") {
        return ItemCatalog.all().map(i => this.effective(i)).filter(i => this.#modeAllowed(i, mode));
    }

    static search(query = "", options = {}) {
        const mode = options.mode || "any";
        const category = options.category || null;
        const limit = Math.max(1, Math.min(5000, Math.floor(options.limit || 20)));
        // Search broader than mode, then apply effective override filter so
        // disabled items disappear immediately from player-facing pickers.
        let results = ItemCatalog.search(query, { mode: mode === "admin" ? "admin" : "any", category, limit: 5000 })
            .map(i => this.effective(i))
            .filter(i => this.#modeAllowed(i, mode));
        return results.slice(0, limit);
    }

    static setFlags(itemId, { marketable = null, contractable = null } = {}, actor = "system") {
        itemId = this.normalizeId(itemId);
        if (!ItemCatalog.get(itemId)) return { success: false, message: "§cItem is not in catalog." };
        const tx = Database.transaction(COLLECTION, data => {
            if (!data.overrides[itemId]) data.overrides[itemId] = { updatedBy: actor, updatedAt: now() };
            if (typeof marketable === "boolean") data.overrides[itemId].marketable = ATM_ANCHOR_ITEMS.has(itemId) ? false : marketable;
            if (typeof contractable === "boolean") data.overrides[itemId].contractable = ATM_ANCHOR_ITEMS.has(itemId) ? false : contractable;
            data.overrides[itemId].updatedBy = String(actor || "system").substring(0, 64);
            data.overrides[itemId].updatedAt = now();
            data.stats.totalOverrides = Object.keys(data.overrides).length;
            data.stats.lastUpdated = now();
            return data.overrides[itemId];
        });
        return tx.success ? { success: true, override: tx.result, message: ATM_ANCHOR_ITEMS.has(itemId) ? "§eATM anchor items are permanently disabled in Market and Contracts." : "§aItem flags updated." } : { success: false, message: `§c${tx.error}` };
    }

    static setPrices(itemId, { baseBuyPriceCents, baseSellPriceCents, minPriceCents, maxPriceCents } = {}, actor = "system") {
        itemId = this.normalizeId(itemId);
        if (!ItemCatalog.get(itemId)) return { success: false, message: "§cItem is not in catalog." };
        const values = [baseBuyPriceCents, baseSellPriceCents, minPriceCents, maxPriceCents].map(v => Math.floor(Number(v)));
        if (values.some(v => !Number.isSafeInteger(v) || v < 0)) return { success: false, message: "§cPrices must be non-negative integer cents." };
        const [buy, sell, min, max] = values;
        if (min > buy || buy > max || sell > buy) return { success: false, message: "§cPrice order must be min ≤ buy and sell ≤ buy ≤ max." };
        const tx = Database.transaction(COLLECTION, data => {
            if (!data.overrides[itemId]) data.overrides[itemId] = { updatedBy: actor, updatedAt: now() };
            Object.assign(data.overrides[itemId], { baseBuyPriceCents: buy, baseSellPriceCents: sell, minPriceCents: min, maxPriceCents: max, updatedBy: String(actor || "system").substring(0, 64), updatedAt: now() });
            data.stats.totalOverrides = Object.keys(data.overrides).length; data.stats.lastUpdated = now();
            return data.overrides[itemId];
        });
        return tx.success ? { success: true, override: tx.result, message: "§aItem prices updated." } : { success: false, message: `§c${tx.error}` };
    }

    static reset(itemId) {
        itemId = this.normalizeId(itemId);
        const tx = Database.transaction(COLLECTION, data => {
            const existed = !!data.overrides[itemId];
            delete data.overrides[itemId];
            data.stats.totalOverrides = Object.keys(data.overrides).length;
            data.stats.lastUpdated = now();
            return existed;
        });
        return tx.success ? { success: true, removed: !!tx.result, message: tx.result ? "§aOverride reset." : "§eNo override existed." } : { success: false, message: `§c${tx.error}` };
    }

    static #modeAllowed(item, mode) {
        if (!item) return false;
        if (mode === "contract") return !!item.contractable && !item.adminOnly;
        if (mode === "market") return !!item.marketable && !item.adminOnly;
        if (mode === "admin") return true;
        return true;
    }
}

export default ItemSettingsService;
