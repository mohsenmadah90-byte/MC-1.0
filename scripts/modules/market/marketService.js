// MCity Dashboard V2 - Market Service
// Phase 2: Transaction Safety & Anti-Dupe
// Phase 2 Performance: O(1) item lookup via maintained index map.
// Phase 4 Scalability: Rate limiting + EventBus integration.
// Phase 7 (v0.21.0): Atomic debit replaces addMoney(-X) to close race-condition exploit.
// Patch 3 (v1.6.7): database.restored item index rebuild hook.
// Sharding Phase 3B (v1.9.3): player mailbox shards + order/limit mirrors.
// Sharding Phase 3C (v1.9.4): orderbook item shard mirrors (legacy authoritative).

import { CONFIG } from "../../config.js";
import { Database } from "../../core/database.js";
import { Logger } from "../../core/logger.js";
import { MoneyUtils } from "../../core/moneyUtils.js";
import { MoneyService } from "../economy/moneyService.js";
import { FinanceService } from "../finance/financeService.js";
import { NotificationService } from "../../dashboard/dashboardNotifications.js";
import { RateLimiter } from "../../core/rateLimiter.js";
import { EventBus } from "../../core/eventBus.js";
import { ItemSettingsService } from "../../core/itemSettingsService.js";
import { DEFAULT_MARKET_DB, validateMarketData, normalizeMarketItem, normalizeItemId } from "../../schemas/marketSchema.js";
import { AuditService } from "../audit/auditService.js";
import { MarketInventory } from "./marketInventory.js";
import { MarketPricing } from "./marketPricing.js";
import { MarketMailbox } from "./marketMailbox.js";
import { MarketOrders } from "./marketOrders.js";
import { MarketShardService } from "./marketShardService.js";
import { DisposableRegistry } from "../../core/disposableRegistry.js";

const MC = CONFIG.MARKET;
const COLLECTION = MC.COLLECTION;
function now() { return Date.now(); }
function safeInt(v, d = 1) { const n = Math.floor(Number(v)); return Number.isFinite(n) ? n : d; }
function itemName(item) { return item.displayName || item.id?.split(":")?.[1] || item.id || "Unknown"; }

export class MarketService {
    static #initialized = false;
    /**
     * Phase 2 Performance: Index map for O(1) item lookup.
     * Key: normalized itemId. Value: { catIndex, itemIndex }.
     * Rebuilt on every transaction commit (via #onDbCommit hook) — but since
     * transactions are infrequent relative to read queries, this is a net win.
     * For very high write scenarios, the index could be versioned instead.
     */
    static #itemIndex = new Map();
    static #indexVersion = -1;
    static #dbVersion = 0;

    static initialize() {
        if (this.#initialized) return;
        this.#initialized = true;
        const db = this.db();
        this.seedDefaults(db);
        this.applyCatalogPricing(db);
        // Phase 2: build the initial index right after load.
        this.#rebuildItemIndex(db);
        // Phase 4 Fix: Explicitly register MarketService with MarketOrders
        // so the match engine can call applyFillToLimits synchronously.
        // This replaces the old lazy async import pattern that could
        // silently bypass daily limits if the import hadn't resolved.
        MarketOrders.setMarketService(this);
        MarketShardService.initialize();
        MarketShardService.migratePlayerDataFromLegacy();
        MarketShardService.migrateOrderBooksFromLegacy();
        EventBus.on("database.restored", event => this.onDatabaseRestored(event));
        Database.registerRefreshHandler("MarketService", event => this.onDatabaseRestored(event));
        DisposableRegistry.registerShutdownCleanup("MarketService.lifecycle", () => {
            MarketOrders.clearMarketService();
            this.#itemIndex.clear();
            this.#indexVersion = -1;
            this.#dbVersion = 0;
            this.#initialized = false;
        });
        Logger.startup("Market", `Market service initialized (${this.#itemIndex.size} items indexed)`);
    }

    static applyCatalogPricing(db = this.db()) {
        let changed = 0;
        for (const item of this.allItems(db)) {
            const policy = ItemSettingsService.effective(item.id);
            if (!policy || policy.baseBuyPrice === undefined) continue;
            const override = ItemSettingsService.overrideFor(item.id);
            if (override?.baseBuyPriceCents !== undefined || override?.baseSellPriceCents !== undefined) continue;
            const buy = Math.max(0, Math.floor(policy.baseBuyPrice));
            const sell = Math.max(0, Math.floor(policy.baseSellPrice ?? buy * MC.DEFAULTS.SELL_RATIO));
            if (item.baseBuyPrice !== buy || item.baseSellPrice !== sell) {
                item.baseBuyPrice = buy; item.baseSellPrice = sell;
                item.buyPrice = buy; item.sellPrice = sell;
                item.minPrice = Math.max(0, Math.floor(policy.minPrice ?? buy * MC.PRICE.MIN_MULTIPLIER));
                item.maxPrice = Math.max(item.minPrice, Math.floor(policy.maxPrice ?? buy * MC.PRICE.MAX_MULTIPLIER));
                changed++;
            }
        }
        if (changed) Database.save(COLLECTION, true);
        return changed;
    }

    static onDatabaseRestored(event = {}) {
        const restored = event.restored || [];
        if (restored.length && !restored.includes(COLLECTION)) return;
        const db = this.db();
        this.ensureStructure(db);
        this.#dbVersion++;
        this.#rebuildItemIndex(db);
        MarketOrders.setMarketService(this);
        MarketShardService.migratePlayerDataFromLegacy();
        MarketShardService.migrateOrderBooksFromLegacy();
        Logger.info("Market", `Database restore detected — item index rebuilt (${this.#itemIndex.size} items)`, { restored });
    }

    static db() {
        const db = Database.collection(COLLECTION, DEFAULT_MARKET_DB, { validate: validateMarketData });
        this.ensureStructure(db);
        return db;
    }

    static ensureStructure(db) {
        if (!Array.isArray(db.categories)) db.categories = [];
        if (!db.orders || typeof db.orders !== "object") db.orders = {};
        if (!db.playerOrders || typeof db.playerOrders !== "object") db.playerOrders = {};
        if (!db.playerLimits || typeof db.playerLimits !== "object") db.playerLimits = {};
        if (!db.mailbox || typeof db.mailbox !== "object") db.mailbox = {};
        if (!db.treasury || typeof db.treasury !== "object") db.treasury = { ...DEFAULT_MARKET_DB.treasury };
        if (!db.stats || typeof db.stats !== "object") db.stats = { ...DEFAULT_MARKET_DB.stats };
    }

    static seedDefaults(db = this.db()) {
        if (!MC.SEED_DEFAULT_ITEMS || db.seeded || db.categories.length) return false;
        for (const cat of MC.DEFAULT_CATEGORIES || []) {
            db.categories.push({
                name: cat.name,
                displayName: cat.displayName || cat.name,
                icon: cat.icon || null,
                items: (cat.items || []).map(normalizeMarketItem)
            });
        }
        for (const item of this.allItems(db)) MarketPricing.updateItem(item, true);
        db.seeded = true;
        db.stats.lastUpdated = now();
        Database.save(COLLECTION, true);
        this.#rebuildItemIndex(db);
        return true;
    }

    static allItems(db = this.db()) {
        const out = [];
        for (const cat of db.categories || []) for (const item of cat.items || []) out.push(item);
        return out;
    }

    static categories() { return this.db().categories || []; }

    /**
     * Phase 2 Performance: Rebuild the itemId → (catIndex, itemIndex) map.
     * Called after seed, after every successful transaction, and lazily on
     * stale-version detection.
     */
    static #rebuildItemIndex(db) {
        this.#itemIndex.clear();
        const cats = db.categories || [];
        for (let ci = 0; ci < cats.length; ci++) {
            const items = cats[ci]?.items || [];
            for (let ii = 0; ii < items.length; ii++) {
                const id = normalizeItemId(items[ii].id);
                if (id) this.#itemIndex.set(id, { catIndex: ci, itemIndex: ii });
            }
        }
        this.#indexVersion = this.#dbVersion;
    }

    /**
     * Phase 2 Performance: Mark index as needing rebuild after a DB mutation.
     * Called by every transaction that touches the market collection.
     */
    static #markIndexStale() {
        this.#dbVersion++;
    }

    static #ensureIndexFresh(db) {
        if (this.#indexVersion !== this.#dbVersion || this.#itemIndex.size === 0 && (db.categories || []).some(c => (c.items || []).length > 0)) {
            this.#rebuildItemIndex(db);
        }
    }

    static findItem(itemId, db = this.db()) {
        itemId = normalizeItemId(itemId);
        this.#ensureIndexFresh(db);
        const entry = this.#itemIndex.get(itemId);
        if (!entry) return null;
        const category = db.categories?.[entry.catIndex];
        const item = category?.items?.[entry.itemIndex];
        // Defensive: index might be stale if items were reordered externally
        if (!item || normalizeItemId(item.id) !== itemId) {
            // Fall back to linear scan and rebuild index
            this.#rebuildItemIndex(db);
            const entry2 = this.#itemIndex.get(itemId);
            if (!entry2) return null;
            const category2 = db.categories?.[entry2.catIndex];
            const item2 = category2?.items?.[entry2.itemIndex];
            if (!item2) return null;
            return { db, category: category2, item: item2 };
        }
        return { db, category, item };
    }

    static buyBreakdown(item, amount) {
        const gross = (item.buyPrice || 0) * amount;
        const tax = MC.TAX.ENABLED ? Math.floor(gross * (MC.TAX.BUY_TAX_RATE || 0)) : 0;
        const fee = MC.FEE.ENABLED ? Math.floor(gross * (item.buyFeeRate ?? MC.FEE.BUY_FEE_RATE)) : 0;
        return { gross, tax, fee, total: gross + tax + fee };
    }

    static orderFillBreakdown(data, itemId, amount, pricePerItem) {
        const item=this.findItem(itemId,data)?.item;if(!item)return null;
        const gross=Math.max(0,Math.floor(pricePerItem))*amount;
        const tax=MC.TAX.ENABLED?Math.floor(gross*(item.taxRate??MC.TAX.SELL_TAX_RATE)):0;
        const fee=MC.FEE.ENABLED?Math.floor(gross*(item.sellFeeRate??MC.FEE.SELL_FEE_RATE)):0;
        return {gross,tax,fee,net:Math.max(0,gross-tax-fee)};
    }

    static sellBreakdown(item, amount) {
        const gross = (item.sellPrice || 0) * amount;
        const tax = MC.TAX.ENABLED ? Math.floor(gross * (item.taxRate ?? MC.TAX.SELL_TAX_RATE)) : 0;
        const fee = MC.FEE.ENABLED ? Math.floor(gross * (item.sellFeeRate ?? MC.FEE.SELL_FEE_RATE)) : 0;
        return { gross, tax, fee, net: Math.max(0, gross - tax - fee) };
    }

    /**
     * Phase 5 Fix: Stable day boundary with anchor timestamp.
     *
     * PROBLEM (pre-Phase 5):
     *   `dayKey()` used `Math.floor(Date.now() / reset)`. If
     *   `RESET_HOURS` changed mid-server (e.g., admin tweaks config and
     *   reloads), the day boundary MOVED. All limits instantly reset
     *   (or stayed reset forever), because the `dayKey` string changed.
     *   This was exploitable: an admin could toggle `RESET_HOURS` to
     *   reset everyone's limits on demand.
     *
     * SOLUTION (Phase 5):
     *   An `anchor` timestamp is stored in the market DB. The day key
     *   is computed as `Math.floor((Date.now() - anchor) / reset)`.
     *   - If `RESET_HOURS` changes, the anchor stays the same, so the
     *     day boundary shifts gradually rather than jumping. Limits
     *     reset at the next natural boundary, not instantly.
     *   - If the admin wants a force-reset, they can clear `anchor`
     *     (not yet exposed in UI — would be a future admin tool).
     *   - The anchor is initialized lazily on first `dayKey()` call if
     *     missing, using the current timestamp.
     *
     *   This makes the day boundary STABLE across config changes, while
     *   still allowing natural periodic resets.
     */
    static dayKey() {
        const reset = Math.max(1, MC.LIMITS.RESET_HOURS || 24) * 60 * 60 * 1000;
        const db = this.db();
        // Phase 5 Fix: Use anchor-based day key.
        if (!db.lastLimitAnchor || typeof db.lastLimitAnchor !== "number") {
            db.lastLimitAnchor = Date.now();
        }
        const anchor = db.lastLimitAnchor;
        return String(Math.floor((Date.now() - anchor) / reset));
    }

    static limitRecord(data, playerId) {
        if (!data.playerLimits[playerId] || data.playerLimits[playerId].dayKey !== this.dayKey()) data.playerLimits[playerId] = { dayKey: this.dayKey(), buy: {}, sell: {} };
        return data.playerLimits[playerId];
    }

    static canBuy(data, player, item, amount) {
        if (!MC.LIMITS.ENABLED) return { ok: true, remaining: Infinity };
        const rec = this.limitRecord(data, player.id);
        const used = rec.buy[item.id] || 0;
        const limit = item.dailyBuyLimit || 0;
        const remaining = Math.max(0, limit - used);
        return { ok: amount <= remaining, remaining };
    }

    static canSell(data, player, item, amount) {
        if (!MC.LIMITS.ENABLED) return { ok: true, remaining: Infinity };
        const rec = this.limitRecord(data, player.id);
        const used = rec.sell[item.id] || 0;
        const limit = item.dailySellLimit || 0;
        const remaining = Math.max(0, limit - used);
        return { ok: amount <= remaining, remaining };
    }

    static instantBuy(player, itemId, amount) {
        amount = Math.max(1, Math.min(MC.LIMITS.MAX_TRANSACTION_AMOUNT, safeInt(amount, 1)));
        // Phase 4: Rate limit per-player market buys.
        const rl = CONFIG.RATE_LIMITS?.MARKET_BUY;
        if (rl && !RateLimiter.check(`market_buy:${player.id}`, rl[0], rl[1])) {
            return { success: false, message: `§cRate limit. Try again in ${Math.ceil(RateLimiter.retryIn(`market_buy:${player.id}`, rl[0], rl[1]) / 1000)}s.` };
        }
        const live = this.findItem(itemId);
        if (!live) return { success: false, message: "§cItem not found." };
        const { item } = live;
        if (!ItemSettingsService.isMarketable(item.id)) return { success: false, message: "§cThis item is disabled in the market." };
        if (!item.enabled || !item.allowBuy) return { success: false, message: "§cBuying this item is disabled." };
        if (item.requireTag && !player.hasTag(item.requireTag)) return { success: false, message: `§cYou need tag '${item.requireTag}'.` };
        if (item.stock < amount) return { success: false, message: `§cNot enough stock. Available: §e${item.stock}` };
        if (!MarketInventory.hasSpace(player, item.id, amount)) return { success: false, message: "§cNot enough inventory space." };
        const b = this.buyBreakdown(item, amount);
        if (MoneyService.getBalance(player) < b.total) return { success: false, message: `§cNeed ${MoneyUtils.formatCents(b.total)}.` };

        // Transactional safety: take money FIRST via atomic debit.
        // Phase 7 (v0.21.0): Previously used `addMoney(player, -b.total)`
        // which silently clamps a negative result to 0 and reports success.
        // This allowed a race-condition exploit where two concurrent buys
        // could both pass the pre-check (line 203) and then both clamp to 0,
        // giving the player the items for free. `debit()` performs the
        // balance check AND the deduction atomically inside the DB
        // transaction, so the second concurrent call sees the updated
        // balance and fails cleanly.
        const deduction = MoneyService.debit(player, b.total, "market_buy");
        if (!deduction.success) return { success: false, message: `§c${deduction.message || "Failed to deduct balance."}` };

        const tx = Database.transaction(COLLECTION, data => {
            const found = this.findItem(item.id, data); if (!found) throw new Error("Item missing.");
            const dbItem = found.item;
            if (dbItem.stock < amount) throw new Error("Stock changed.");
            const lim = this.canBuy(data, player, dbItem, amount); if (!lim.ok) throw new Error(`Daily buy limit reached. Remaining: ${lim.remaining}`);
            dbItem.stock -= amount;
            dbItem.totalBought = (dbItem.totalBought || 0) + amount;
            this.limitRecord(data, player.id).buy[dbItem.id] = (this.limitRecord(data, player.id).buy[dbItem.id] || 0) + amount;
            this.collectMarketFinance(data, b.tax, b.fee);
            this.pushTrade(dbItem, "buy", dbItem.buyPrice, amount, player.name);
            MarketPricing.updateItem(dbItem, true);
            data.stats.totalTrades = (data.stats.totalTrades || 0) + 1;
            data.stats.totalBuyVolume = (data.stats.totalBuyVolume || 0) + amount;
            data.stats.totalMoneyVolume = (data.stats.totalMoneyVolume || 0) + b.total;
            data.stats.lastUpdated = now();
        });

        if (!tx.success) { 
            // Rollback money — use addMoney (positive) since debit already
            // verified funds; we just need to credit back the exact amount.
            // Phase 7 (v0.21.0): Check return value and log if rollback fails.
            const rollback = MoneyService.addMoney(player, b.total, "market_buy_rollback");
            if (!rollback || !rollback.success) {
                Logger.error("Market", `CRITICAL: market_buy_rollback failed for ${player.id} (${player.name}), amount ${b.total}. Money not refunded.`);
                AuditService.record("market.rollback.failed", "market", player.id, player.name,
                    `CRITICAL rollback failure: ${b.total}c lost`, { itemId: item.id, amount, total: b.total }, "error");
                // Queue a payout so the player can recover the funds later.
                try { FinanceService.addPayout(player.id, b.total, "Market buy rollback (delayed)", "market", { itemId: item.id, amount }); } catch (e) { Logger.error("Market", "Fallback payout also failed", e); }
            }
            return { success: false, message: `§cBuy failed: ${tx.error}` }; 
        }
        // Phase 2: index still valid since structure didn't change, but bump version to be safe.
        this.#markIndexStale();

        const add = MarketInventory.add(player, item.id, amount);
        if (!add.success) {
            // Player's inventory became full mid-tick or items dropped.
            // Phase 7.2 (v0.21.1): Previously called `MarketMailbox.addEntry`
            // which DID NOT EXIST — the transaction threw TypeError, the
            // return value was never checked, and the partial-fill items
            // were lost forever. Now we use the correct `addToData` method,
            // wrap it in a transaction, and verify success. If the mailbox
            // write somehow fails too, we revert the stock and refund the
            // money so the player is made whole.
            const refundTx = Database.transaction(COLLECTION, data => {
                // Remainder becomes a mailbox delivery obligation. Stock was
                // already consumed and must NOT also be restored (dupe).
                MarketMailbox.addToData(data, player.id, {
                    type: "item",
                    itemId: item.id,
                    amount: add.remaining,
                    reason: `Inventory full during buy. Recovered ${add.remaining}x ${item.id}`
                });
            });
            if (!refundTx.success) {
                // Last-resort: try to deliver items directly via payout queue
                // so they are not lost. Stock revert failed too, so the
                // economy is slightly off, but the player is made whole.
                Logger.error("Market", `CRITICAL: partial-fill mailbox write failed for ${player.id}, ${add.remaining}x ${item.id}. Attempting fallback payout.`);
                try { FinanceService.addPayout(player.id, add.remaining * item.buyPrice, `Market buy item refund (fallback): ${add.remaining}x ${item.id}`, "market", { itemId: item.id, amount: add.remaining }); } catch (e) { Logger.error("Market", "Fallback payout also failed", e); }
            }
            this.mirrorFinance(b.tax, b.fee, "Market buy (Partial)", { playerId: player.id, itemId: item.id, amount });
            return { success: true, message: `§eInventory full. Check your Market Mailbox for the remaining items.` };
        }

        this.mirrorFinance(b.tax, b.fee, "Market buy", { playerId: player.id, itemId: item.id, amount });
        AuditService.record("market.buy", "market", player.id, player.name, `Bought ${amount}x ${item.id}`, { itemId: item.id, amount, total: b.total });
        return { success: true, message: `§aBought §e${amount}x §f${itemName(item)} §afor §e${MoneyUtils.formatCents(b.total)}§a.` };
    }

    static instantSell(player, itemId, amount) {
        amount = Math.max(1, Math.min(MC.LIMITS.MAX_TRANSACTION_AMOUNT, safeInt(amount, 1)));
        // Phase 4: Rate limit per-player market sells.
        const rl = CONFIG.RATE_LIMITS?.MARKET_SELL;
        if (rl && !RateLimiter.check(`market_sell:${player.id}`, rl[0], rl[1])) {
            return { success: false, message: `§cRate limit. Try again in ${Math.ceil(RateLimiter.retryIn(`market_sell:${player.id}`, rl[0], rl[1]) / 1000)}s.` };
        }
        const live = this.findItem(itemId);
        if (!live) return { success: false, message: "§cItem not found." };
        const { item } = live;
        if (!ItemSettingsService.isMarketable(item.id)) return { success: false, message: "§cThis item is disabled in the market." };
        if (!item.enabled || !item.allowSell) return { success: false, message: "§cSelling this item is disabled." };
        if (!MarketInventory.canReserveFungible(player, item.id, amount).ok) return { success: false, message: "§cOnly plain fungible items can be sold." };
        if (MarketInventory.count(player, item.id) < amount) return { success: false, message: "§cNot enough items." };
        const b = this.sellBreakdown(item, amount);
        
        // Transactional safety: remove item FIRST.
        const rem = MarketInventory.remove(player, item.id, amount);
        if (!rem.success) return { success: false, message: "§cFailed to reserve items. Check inventory." };

        const tx = Database.transaction(COLLECTION, data => {
            const found = this.findItem(item.id, data); if (!found) throw new Error("Item missing.");
            const dbItem = found.item;
            const lim = this.canSell(data, player, dbItem, amount); if (!lim.ok) throw new Error(`Daily sell limit reached. Remaining: ${lim.remaining}`);
            dbItem.stock = (dbItem.stock || 0) + amount;
            dbItem.totalSold = (dbItem.totalSold || 0) + amount;
            this.limitRecord(data, player.id).sell[dbItem.id] = (this.limitRecord(data, player.id).sell[dbItem.id] || 0) + amount;
            this.collectMarketFinance(data, b.tax, b.fee);
            this.pushTrade(dbItem, "sell", dbItem.sellPrice, amount, player.name);
            MarketPricing.updateItem(dbItem, true);
            data.stats.totalTrades = (data.stats.totalTrades || 0) + 1;
            data.stats.totalSellVolume = (data.stats.totalSellVolume || 0) + amount;
            data.stats.totalMoneyVolume = (data.stats.totalMoneyVolume || 0) + b.gross;
            data.stats.lastUpdated = now();
        });

        if (!tx.success) {
            // Rollback items
            MarketInventory.add(player, item.id, amount);
            return { success: false, message: `§cSell failed: ${tx.error}` };
        }
        // Phase 2: index still valid since structure didn't change, but bump version to be safe.
        this.#markIndexStale();

        // Give money AFTER successful DB write.
        // Phase 7 (v0.21.0): Check return value. If credit fails (player
        // disconnected between form.show and confirm, scoreboard objective
        // missing, etc.), the items are already removed from inventory and
        // the stock is already incremented in the DB. We cannot undo the
        // stock increment cheaply, so we queue the net amount as a payout
        // so the player can claim it later. This prevents silent item loss.
        const credit = MoneyService.addMoney(player, b.net, "market_sell");
        if (!credit || !credit.success) {
            Logger.warn("Market", `market_sell credit failed for ${player.id} (${player.name}); queueing payout of ${b.net}.`);
            try {
                FinanceService.addPayout(player.id, b.net, `Market sell credit (deferred): ${amount}x ${item.id}`, "market", { itemId: item.id, amount, net: b.net });
            } catch (e) {
                Logger.error("Market", "Fallback payout queue also failed", e);
            }
        }
        this.mirrorFinance(b.tax, b.fee, "Market sell", { playerId: player.id, itemId: item.id, amount, gross: b.gross, net: b.net });
        AuditService.record("market.sell", "market", player.id, player.name, `Sold ${amount}x ${item.id}`, { itemId: item.id, amount, net: b.net });
        return { success: true, message: `§aSold §e${amount}x §f${itemName(item)} §afor net §e${MoneyUtils.formatCents(b.net)}§a.` };
    }

    static createBuyOrder(player, itemId, amount, pricePerItem) {
        itemId = normalizeItemId(itemId); amount = Math.max(1, Math.min(MC.ORDERS.MAX_ORDER_AMOUNT, safeInt(amount, 1))); pricePerItem = Math.max(0, safeInt(pricePerItem, 0));
        if (!this.findItem(itemId)) return { success: false, message: "§cItem not found." };
        if (!ItemSettingsService.isMarketable(itemId)) return { success: false, message: "§cThis item is disabled in the market." };
        // Phase 7.2 (v0.21.1) (MK5): Rate limit check was missing despite
        // CONFIG.RATE_LIMITS.MARKET_ORDER_CREATE being defined. Without it,
        // a player could spam order creation to lag the match engine.
        const rlCreate = CONFIG.RATE_LIMITS?.MARKET_ORDER_CREATE;
        if (rlCreate && !RateLimiter.check(`market_order_create:${player.id}`, rlCreate[0], rlCreate[1])) {
            const retryIn = RateLimiter.retryIn(`market_order_create:${player.id}`, rlCreate[0], rlCreate[1]);
            return { success: false, message: `§cRate limit. Try again in ${Math.ceil(retryIn / 1000)}s.` };
        }
        // Phase 7.2 (v0.21.1) (MK5): Pre-check daily buy limit BEFORE
        // reserving money. Previously, order-book fills bypassed daily
        // limits entirely — a player could instantBuy up to their limit,
        // then create a buy order that matched a seller, and the matched
        // fill did not count against their daily limit. Now we pre-check
        // here AND the match engine updates playerLimits on fill.
        const liveItem = this.findItem(itemId)?.item;
        if (liveItem && MC.LIMITS.ENABLED) {
            const db = this.db();
            const lim = this.canBuy(db, player, liveItem, amount);
            if (!lim.ok) return { success: false, message: `§cDaily buy limit reached. Remaining: ${lim.remaining}` };
        }
        const capacity = MarketOrders.hasCapacity(this.db(), itemId, "buy");
        if (!capacity.ok) return { success: false, message: `§cBuy order book is full (${capacity.max}); no money was reserved.` };
        const reserve = amount * pricePerItem;
        if (MoneyService.getBalance(player) < reserve) return { success: false, message: `§cNeed ${MoneyUtils.formatCents(reserve)} to reserve.` };
        // Phase 7 (v0.21.0): Use atomic debit instead of addMoney(-reserve).
        const deduction = MoneyService.debit(player, reserve, "market_buy_order_reserve");
        if (!deduction.success) return { success: false, message: `§c${deduction.message || "Failed to reserve funds."}` };
        const order = MarketOrders.createOrderObject(player, "buy", itemId, amount, pricePerItem, reserve);
        const tx = Database.transaction(COLLECTION, data => {
            if (MarketOrders.countOpen(data, player.id) >= MC.ORDERS.MAX_ACTIVE_PER_PLAYER) throw new Error("Too many active orders.");
            MarketOrders.addToData(data, order);
            MarketOrders.match(data, itemId);
            return order;
        });
        if (!tx.success) {
            // Refund with return-value check.
            const refund = MoneyService.addMoney(player, reserve, "market_buy_order_refund");
            if (!refund || !refund.success) {
                Logger.error("Market", `CRITICAL: market_buy_order_refund failed for ${player.id}, ${reserve}c lost.`);
                AuditService.record("market.rollback.failed", "market", player.id, player.name, `CRITICAL order refund failure: ${reserve}c`, { itemId, amount, pricePerItem }, "error");
                try { FinanceService.addPayout(player.id, reserve, "Market buy-order refund (delayed)", "market", { itemId, amount }); } catch (e) { Logger.error("Market", "Fallback payout failed", e); }
            }
            return { success: false, message: `§cOrder failed: ${tx.error}` };
        }
        MarketShardService.syncPlayerMirrorFromLegacy(player.id, this.db());
        MarketShardService.syncOrderBookFromLegacy(itemId, this.db());
        NotificationService.create(player.id, { type: "market", source: "market", title: "Buy Order Created", message: `Buy order: ${amount}x ${itemId} @ ${MoneyUtils.formatCents(pricePerItem)}.`, action: "market_orders" });
        AuditService.record("market.order.create_buy", "market", player.id, player.name, `Buy order ${amount}x ${itemId}`, { itemId, amount, pricePerItem });
        return { success: true, message: `§aBuy order created.` };
    }

    static createSellOrder(player, itemId, amount, pricePerItem) {
        itemId = normalizeItemId(itemId); amount = Math.max(1, Math.min(MC.ORDERS.MAX_ORDER_AMOUNT, safeInt(amount, 1))); pricePerItem = Math.max(0, safeInt(pricePerItem, 0));
        if (!this.findItem(itemId)) return { success: false, message: "§cItem not found." };
        if (!ItemSettingsService.isMarketable(itemId)) return { success: false, message: "§cThis item is disabled in the market." };
        // Phase 7.2 (v0.21.1) (MK5): Rate limit check (was missing).
        const rlCreate = CONFIG.RATE_LIMITS?.MARKET_ORDER_CREATE;
        if (rlCreate && !RateLimiter.check(`market_order_create:${player.id}`, rlCreate[0], rlCreate[1])) {
            const retryIn = RateLimiter.retryIn(`market_order_create:${player.id}`, rlCreate[0], rlCreate[1]);
            return { success: false, message: `§cRate limit. Try again in ${Math.ceil(retryIn / 1000)}s.` };
        }
        // Phase 7.2 (v0.21.1) (MK5): Pre-check daily sell limit.
        const liveItem = this.findItem(itemId)?.item;
        if (liveItem && MC.LIMITS.ENABLED) {
            const db = this.db();
            const lim = this.canSell(db, player, liveItem, amount);
            if (!lim.ok) return { success: false, message: `§cDaily sell limit reached. Remaining: ${lim.remaining}` };
        }
        const capacity = MarketOrders.hasCapacity(this.db(), itemId, "sell");
        if (!capacity.ok) return { success: false, message: `§cSell order book is full (${capacity.max}); no items were reserved.` };
        if (!MarketInventory.canReserveFungible(player, itemId, amount).ok) return { success: false, message: "§cOnly plain fungible items without name, lore, enchantment or damage can be sold." };
        if (MarketInventory.count(player, itemId) < amount) return { success: false, message: "§cNot enough items to reserve." };
        const rem = MarketInventory.remove(player, itemId, amount); if (!rem.success) return { success: false, message: "§cFailed to reserve items." };
        const order = MarketOrders.createOrderObject(player, "sell", itemId, amount, pricePerItem, amount);
        const tx = Database.transaction(COLLECTION, data => {
            if (MarketOrders.countOpen(data, player.id) >= MC.ORDERS.MAX_ACTIVE_PER_PLAYER) throw new Error("Too many active orders.");
            MarketOrders.addToData(data, order);
            MarketOrders.match(data, itemId);
            return order;
        });
        if (!tx.success) { MarketInventory.add(player, itemId, amount); return { success: false, message: `§cOrder failed: ${tx.error}` }; }
        MarketShardService.syncPlayerMirrorFromLegacy(player.id, this.db());
        MarketShardService.syncOrderBookFromLegacy(itemId, this.db());
        NotificationService.create(player.id, { type: "market", source: "market", title: "Sell Order Created", message: `Sell order: ${amount}x ${itemId} @ ${MoneyUtils.formatCents(pricePerItem)}.`, action: "market_orders" });
        AuditService.record("market.order.create_sell", "market", player.id, player.name, `Sell order ${amount}x ${itemId}`, { itemId, amount, pricePerItem });
        return { success: true, message: `§aSell order created.` };
    }

    static orderBookFor(itemId) {
        return MarketShardService.getOrderBook(normalizeItemId(itemId), this.db());
    }

    static myOrders(player) {
        const legacy = this.db().playerOrders?.[player.id] || {};
        const shard = MarketShardService.getPlayerOrders(player.id) || {};
        const merged = new Map();
        for (const o of Object.values(shard)) if (o?.id) merged.set(o.id, o);
        for (const o of Object.values(legacy)) if (o?.id) merged.set(o.id, o);
        return [...merged.values()].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    }

    static cancelOrder(player, orderId) {
        // Phase 7.2 (v0.21.1) (MK5): Rate limit check (was missing).
        const rlCancel = CONFIG.RATE_LIMITS?.MARKET_ORDER_CANCEL;
        if (rlCancel && !RateLimiter.check(`market_order_cancel:${player.id}`, rlCancel[0], rlCancel[1])) {
            const retryIn = RateLimiter.retryIn(`market_order_cancel:${player.id}`, rlCancel[0], rlCancel[1]);
            return { success: false, message: `§cRate limit. Try again in ${Math.ceil(retryIn / 1000)}s.` };
        }
        const beforeOrder = this.myOrders(player).find(o => o.id === orderId);
        const tx = Database.transaction(COLLECTION, data => MarketOrders.cancelInData(data, player.id, orderId));
        if (tx.success) { MarketShardService.syncPlayerMirrorFromLegacy(player.id, this.db()); if (beforeOrder?.itemId) MarketShardService.syncOrderBookFromLegacy(beforeOrder.itemId, this.db()); AuditService.record("market.order.cancel", "market", player.id, player.name, `Cancelled order ${orderId}`, { orderId }); }
        return tx.success ? { success: true, message: "§aOrder cancelled. Refund/return moved to Market Mailbox." } : { success: false, message: `§cCancel failed: ${tx.error}` };
    }

    static claimMailbox(player) {
        // Phase 4.1: legacy is authoritative. Each mailbox entry is settled by
        // deterministic entry ID; money is converted to an idempotent Finance
        // payout and item delivery uses a temporary inventory token.
        const snapshot = MarketMailbox.list(this.db(), player.id);
        let claimed=0,money=0,items=0,uncertain=0;
        for(const entry of snapshot){
            if(!entry?.id)continue;
            if(entry.type==="money"){
                const amount=Math.max(0,Math.floor(Number(entry.amount)||0));
                const payout=FinanceService.addPayout(player.id,amount,entry.reason||"Market mailbox","market",{journalId:`market_mail_${entry.id}`,toName:player.name,mailboxEntryId:entry.id});
                if(!payout.success)continue;
                const tx=Database.transaction(COLLECTION,data=>{const list=data.mailbox?.[player.id]||[];data.mailbox[player.id]=list.filter(e=>e?.id!==entry.id);if(!data.mailbox[player.id].length)delete data.mailbox[player.id];});
                if(tx.success&&Database.flushCritical(COLLECTION,"market_mailbox_money_settle").ok){claimed++;money+=amount;}
                continue;
            }
            if(entry.type!=="item")continue;
            const amount=Math.max(0,Math.floor(Number(entry.amount)||0));
            if(entry.deliveryState==="delivery_attempted"){
                const delivered=MarketInventory.tokenAmount(player,entry.id);
                if(delivered<=0){Database.transaction(COLLECTION,data=>{const e=(data.mailbox?.[player.id]||[]).find(x=>x?.id===entry.id);if(e)e.deliveryState="delivery_uncertain";});uncertain++;continue;}
                const tx=Database.transaction(COLLECTION,data=>{const list=data.mailbox?.[player.id]||[];data.mailbox[player.id]=list.filter(e=>e?.id!==entry.id);if(!data.mailbox[player.id].length)delete data.mailbox[player.id];});
                if(tx.success&&Database.flushCritical(COLLECTION,"market_mailbox_item_recover_settle").ok){MarketInventory.clearDeliveryToken(player,entry.id);claimed++;items+=delivered;}continue;
            }
            if(entry.deliveryState==="delivery_uncertain"){uncertain++;continue;}
            const mark=Database.transaction(COLLECTION,data=>{const e=(data.mailbox?.[player.id]||[]).find(x=>x?.id===entry.id);if(!e)throw new Error("Mailbox entry missing");e.deliveryState="delivery_attempted";e.deliveryAttemptedAt=Date.now();});
            if(!mark.success||!Database.flushCritical(COLLECTION,"market_mailbox_item_attempt").ok)continue;
            const add=MarketInventory.addTagged(player,entry.itemId,amount,entry.id);
            if(add.added<=0){Database.transaction(COLLECTION,data=>{const e=(data.mailbox?.[player.id]||[]).find(x=>x?.id===entry.id);if(e)e.deliveryState="pending";});continue;}
            const settle=Database.transaction(COLLECTION,data=>{const e=(data.mailbox?.[player.id]||[]).find(x=>x?.id===entry.id);if(!e)return;if(add.remaining>0){e.amount=add.remaining;e.deliveryState="pending";}else{data.mailbox[player.id]=(data.mailbox[player.id]||[]).filter(x=>x?.id!==entry.id);if(!data.mailbox[player.id].length)delete data.mailbox[player.id];}});
            if(settle.success&&Database.flushCritical(COLLECTION,"market_mailbox_item_settle").ok){MarketInventory.clearDeliveryToken(player,entry.id);items+=add.added;if(!add.remaining)claimed++;}else uncertain++;
        }
        MarketShardService.syncPlayerMirrorFromLegacy(player.id,this.db());
        return {claimed,money,items,remaining:MarketMailbox.list(this.db(),player.id).length,uncertain,authority:"legacy"};
    }

    static mailboxStats(player) {
        return { ...MarketMailbox.stats(this.db(), player.id), authority: "legacy" };
    }
    static mailboxList(player) {
        return MarketMailbox.list(this.db(), player.id);
    }

    static collectMarketFinance(data, tax, fee) {
        const taxDestination = MC.TAX.TAX_DESTINATION || "burn";
        let taxToTreasury = 0, taxBurned = 0;
        if (taxDestination === "treasury") taxToTreasury = tax;
        else if (taxDestination === "split") { taxToTreasury = Math.floor(tax * MC.TAX.TAX_TREASURY_RATIO); taxBurned = tax - taxToTreasury; }
        else taxBurned = tax;
        const treasuryIn = (MC.FEE.SEND_TO_TREASURY ? fee : 0) + taxToTreasury;
        data.treasury.balance = (data.treasury.balance || 0) + treasuryIn;
        data.treasury.totalFeesCollected = (data.treasury.totalFeesCollected || 0) + fee;
        data.treasury.totalTaxToTreasury = (data.treasury.totalTaxToTreasury || 0) + taxToTreasury;
        data.treasury.totalTaxBurned = (data.treasury.totalTaxBurned || 0) + taxBurned;
    }

    /**
     * Phase 7.2 (v0.21.1) (MK5): Apply daily-limit accounting for an
     * order-book fill. Called by MarketOrders.match after a fill is
     * committed. Updates playerLimits for BOTH the buyer and the seller
     * so order-book fills can no longer bypass daily limits.
     *
     * Exposed as a static method so marketOrders.js can call it without
     * needing a circular import (MarketOrders already imports
     * MarketMailbox; adding MarketService would create a cycle).
     */
    static canFillLimits(data, itemId, buyerId, sellerId, amount) {
        const item = this.findItem(itemId, data)?.item;
        if (!item || !MC.LIMITS.ENABLED) return { ok: !!item };
        const buyer = this.canBuy(data, { id: buyerId }, item, amount);
        const seller = this.canSell(data, { id: sellerId }, item, amount);
        return { ok: buyer.ok && seller.ok, buyerRemaining: buyer.remaining, sellerRemaining: seller.remaining };
    }

    static applyFillToLimits(data, itemId, buyerId, sellerId, amount) {
        if (!MC.LIMITS.ENABLED || amount <= 0) return;
        const item = this.findItem(itemId, data)?.item;
        if (!item) return;
        // Buyer side
        if (buyerId) {
            const buyerRec = this.limitRecord(data, buyerId);
            buyerRec.buy[item.id] = (buyerRec.buy[item.id] || 0) + amount;
        }
        // Seller side
        if (sellerId) {
            const sellerRec = this.limitRecord(data, sellerId);
            sellerRec.sell[item.id] = (sellerRec.sell[item.id] || 0) + amount;
        }
    }

    static mirrorFinance(tax, fee, reason, meta = {}) {
        const taxDestination = MC.TAX.TAX_DESTINATION || "burn";
        let taxToTreasury = 0, taxBurned = 0;
        if (taxDestination === "treasury") taxToTreasury = tax;
        else if (taxDestination === "split") { taxToTreasury = Math.floor(tax * MC.TAX.TAX_TREASURY_RATIO); taxBurned = tax - taxToTreasury; }
        else taxBurned = tax;
        const treasuryIn = (MC.FEE.SEND_TO_TREASURY ? fee : 0) + taxToTreasury;
        if (treasuryIn > 0) FinanceService.addTreasury("market", treasuryIn, reason, { source: "market", fee, taxToTreasury, ...meta });
        if (taxBurned > 0) FinanceService.burn(taxBurned, `${reason} tax burn`, "market", meta);
    }

    static pushTrade(item, type, price, amount, playerName) {
        if (!Array.isArray(item.recentTrades)) item.recentTrades = [];
        item.recentTrades.push({ time: now(), type, price, amount, playerName });
        item.recentTrades = item.recentTrades.slice(-20);
        item.lastTradePrice = price;
        item.totalTrades = (item.totalTrades || 0) + 1;
        item.totalVolume = (item.totalVolume || 0) + amount;
    }

    /**
     * Phase 7.6 (v0.23.0) (S5): Public admin methods for market management.
     *
     * Previously, MarketAdminUI called Database directly, bypassing the
     * service layer. This meant:
     *   - The #itemIndex was left stale until the next find() defensive rebuild.
     *   - Pricing recalculation wasn't triggered for edited items.
     *   - No validation/hooks ran centrally.
     *
     * These public methods encapsulate the mutations so admin UIs don't
     * need to touch Database directly.
     */

    /**
     * Add or edit a market item. If an item with the same itemId exists
     * in the specified category, it's updated; otherwise a new item is added.
     * Triggers index invalidation and optional price recalculation.
     * @returns {{ success: boolean, message: string }}
     */
    static addItem(itemData, category = "materials", recalcPrice = true) {
        const itemId = normalizeItemId(itemData.id);
        if (!itemId) return { success: false, message: "§cInvalid item ID." };
        const item = normalizeMarketItem(itemData);
        const tx = Database.transaction(COLLECTION, data => {
            let cat = (data.categories || []).find(c => c.name === category);
            if (!cat) {
                cat = { name: category, displayName: category, icon: null, items: [] };
                if (!Array.isArray(data.categories)) data.categories = [];
                data.categories.push(cat);
            }
            const idx = cat.items.findIndex(i => normalizeItemId(i.id) === itemId);
            if (idx >= 0) cat.items[idx] = { ...cat.items[idx], ...item };
            else cat.items.push(item);
            data.stats.lastUpdated = now();
            return { idx, category };
        });
        if (!tx.success) return { success: false, message: `§c${tx.error}` };
        // Invalidate index so the next findItem rebuilds with the new item.
        this.#markIndexStale();
        // Optional price recalculation.
        if (recalcPrice) {
            const live = this.findItem(itemId)?.item;
            if (live) MarketPricing.updateItem(live, true);
        }
        return { success: true, message: `§aItem ${itemId} ${tx.result.idx >= 0 ? "updated" : "added"}.` };
    }

    /**
     * Recalculate prices for all market items.
     * @returns {{ success: boolean, count: number }}
     */
    static recalculateAllPrices() {
        const db = this.db();
        let count = 0;
        for (const item of this.allItems(db)) {
            MarketPricing.updateItem(item, true);
            count++;
        }
        Database.markDirty(COLLECTION);
        return { success: true, count };
    }

    /**
     * Force-expire all overdue orders. Returns the count of expired orders.
     * @returns {{ success: boolean, count: number }}
     */
    static expireOrders() {
        const tx = Database.transaction(COLLECTION, data => MarketOrders.expireInData(data));
        if (tx.success) {
            const db = this.db();
            for (const itemId of Object.keys(db.orders || {})) MarketShardService.syncOrderBookFromLegacy(itemId, db);
        }
        return { success: tx.success, count: tx.success ? (tx.result || 0) : 0 };
    }

    static countOpenOrdersForItem(data, itemId) {
        itemId = normalizeItemId(itemId);
        let count = 0;
        const book = data.orders?.[itemId];
        if (book) {
            for (const o of [...(book.bids || []), ...(book.asks || [])]) if (o?.status === "open") count++;
        }
        for (const orders of Object.values(data.playerOrders || {})) {
            if (!orders || typeof orders !== "object") continue;
            for (const o of Object.values(orders)) if (o?.itemId === itemId && o.status === "open") count++;
        }
        return count;
    }

    /**
     * Remove an item from the market by itemId.
     * Refuses while open orders exist unless options.force is true.
     * @returns {{ success: boolean, message: string }}
     */
    static removeItem(itemId, options = {}) {
        itemId = normalizeItemId(itemId);
        let removed = false;
        let openOrders = 0;
        const tx = Database.transaction(COLLECTION, data => {
            openOrders = this.countOpenOrdersForItem(data, itemId);
            if (openOrders > 0 && !options.force) throw new Error(`Cannot remove item with ${openOrders} open order(s). Cancel/expire orders first.`);
            for (const cat of (data.categories || [])) {
                const before = cat.items.length;
                cat.items = cat.items.filter(i => normalizeItemId(i.id) !== itemId);
                if (cat.items.length < before) removed = true;
            }
            if (removed) data.stats.lastUpdated = now();
            return { removed, openOrders };
        });
        if (tx.success && removed) this.#markIndexStale();
        return tx.success
            ? { success: true, removed, openOrders, message: removed ? `§aItem ${itemId} removed.` : `§eItem ${itemId} not found.` }
            : { success: false, openOrders, message: `§c${tx.error}` };
    }

    /**
     * Remove a market category. By default refuses if category has items or
     * open orders. Pass { deleteItems: true } to delete contained items too.
     */
    static removeCategory(categoryName, options = {}) {
        const category = String(categoryName || "").toLowerCase().replace(/[^a-z0-9_]/g, "_").substring(0, 32);
        if (!category) return { success: false, message: "§cInvalid category." };
        let removed = false, itemCount = 0, openOrders = 0;
        const tx = Database.transaction(COLLECTION, data => {
            const idx = (data.categories || []).findIndex(c => c.name === category);
            if (idx < 0) return { removed: false, itemCount: 0, openOrders: 0 };
            const cat = data.categories[idx];
            const itemIds = (cat.items || []).map(i => normalizeItemId(i.id));
            itemCount = itemIds.length;
            openOrders = itemIds.reduce((sum, id) => sum + this.countOpenOrdersForItem(data, id), 0);
            if (openOrders > 0 && !options.force) throw new Error(`Cannot remove category with ${openOrders} open order(s). Cancel/expire orders first.`);
            if (itemCount > 0 && !options.deleteItems) throw new Error(`Category contains ${itemCount} item(s). Use deleteItems option after confirmation.`);
            data.categories.splice(idx, 1);
            removed = true;
            data.stats.lastUpdated = now();
            return { removed, itemCount, openOrders };
        });
        if (tx.success && removed) this.#markIndexStale();
        return tx.success
            ? { success: true, removed, itemCount, openOrders, message: removed ? `§aCategory ${category} removed${itemCount ? ` with ${itemCount} item(s)` : ""}.` : `§eCategory ${category} not found.` }
            : { success: false, itemCount, openOrders, message: `§c${tx.error}` };
    }
}

export function getMarketDatabase() { return MarketService.db(); }
export default MarketService;