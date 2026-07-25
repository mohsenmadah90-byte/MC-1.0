// MCity Dashboard V2 - Item Settings Service
// v1.8.5: Merges static item catalog with admin flag overrides.

import { Database } from "./database.js";
import { Logger } from "./logger.js";
import { ItemCatalog } from "./itemCatalog.js";
import { DEFAULT_ITEM_SETTINGS_DB, validateItemSettingsData } from "../schemas/itemSettingsSchema.js";
import { DisposableRegistry } from "./disposableRegistry.js";

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
        const override = this.overrideFor(base.id);
        return override ? { ...base, ...override, override } : { ...base, override: null };
    }

    static isMarketable(id) {
        const item = this.effective(id);
        return !!(item && item.marketable && !item.adminOnly);
    }

    static isContractable(id) {
        const item = this.effective(id);
        return !!(item && item.contractable && !item.adminOnly);
    }

    static all(mode = "any") {
        return ItemCatalog.all().map(i => this.effective(i)).filter(i => this.#modeAllowed(i, mode));
    }

    static search(query = "", options = {}) {
        const mode = options.mode || "any";
        const category = options.category || null;
        const limit = Math.max(1, Math.min(100, Math.floor(options.limit || 20)));
        // Search broader than mode, then apply effective override filter so
        // disabled items disappear immediately from player-facing pickers.
        let results = ItemCatalog.search(query, { mode: mode === "admin" ? "admin" : "any", category, limit: 100 })
            .map(i => this.effective(i))
            .filter(i => this.#modeAllowed(i, mode));
        return results.slice(0, limit);
    }

    static setFlags(itemId, { marketable = null, contractable = null } = {}, actor = "system") {
        itemId = this.normalizeId(itemId);
        if (!ItemCatalog.get(itemId)) return { success: false, message: "§cItem is not in catalog." };
        const tx = Database.transaction(COLLECTION, data => {
            if (!data.overrides[itemId]) data.overrides[itemId] = { updatedBy: actor, updatedAt: now() };
            if (typeof marketable === "boolean") data.overrides[itemId].marketable = marketable;
            if (typeof contractable === "boolean") data.overrides[itemId].contractable = contractable;
            data.overrides[itemId].updatedBy = String(actor || "system").substring(0, 64);
            data.overrides[itemId].updatedAt = now();
            data.stats.totalOverrides = Object.keys(data.overrides).length;
            data.stats.lastUpdated = now();
            return data.overrides[itemId];
        });
        return tx.success ? { success: true, override: tx.result, message: "§aItem flags updated." } : { success: false, message: `§c${tx.error}` };
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
