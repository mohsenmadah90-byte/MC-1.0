// MCity Dashboard V2 - Market Orders / Order Book
// Phase 10: Match Engine & Order Resolution
// Phase 7.2 (v0.21.1): Infinite-loop guard + daily-limit accounting on fills.
// Phase 4 Fix: Explicit MarketService registration replaces lazy import.
// Patch 2 (v1.6.6): Fail-closed matching if limit accounting is unavailable.

import { CONFIG } from "../../config.js";
import { Logger } from "../../core/logger.js";
import { MarketMailbox } from "./marketMailbox.js";

const MC = CONFIG.MARKET;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Phase 4 Fix: Explicit MarketService registration.
 *
 * PROBLEM (pre-Phase 4):
 *   `MarketOrders` used a lazy async `import()` to get `MarketService`
 *   (to avoid a circular import dependency). The sync accessor
 *   `marketServiceSync()` returned `_MarketService`, which could be
 *   `null` if the async import hadn't resolved yet. The code's comment
 *   acknowledged this:
 *     "Fallback: if not yet resolved, skip limit accounting (the
 *      pre-check in createBuyOrder/createSellOrder still catches the
 *      common case)."
 *
 *   This meant order-book fills could SILENTLY BYPASS daily limits if
 *   `MarketService` wasn't resolved. The pre-check in `createBuyOrder`
 *   catches the common case, but a fill that pushes a player over their
 *   daily limit during a match (e.g., player places a buy order, then
 *   a matching sell order arrives) would not be caught.
 *
 *   The root cause was relying on async resolution for a sync hot path.
 *
 * SOLUTION (Phase 4):
 *   1. `MarketService.initialize()` explicitly registers itself with
 *      `MarketOrders` via `MarketOrders.setMarketService(this)` at the
 *      END of its initialize() method. This is synchronous and happens
 *      before any UI/event that could trigger order matching.
 *   2. `marketServiceSync()` returns the registered reference. If it's
 *      still null (e.g., MarketOrders.match() is called before
 *      MarketService.initialize() — a startup-order bug), we LOG AN
 *      ERROR and SKIP the fill (fail-safe: don't match orders without
 *      limit accounting).
 *   3. The old lazy async import is removed entirely — no more race
 *      between async resolution and sync access.
 *   4. This makes the initialization order dependency EXPLICIT and
 *      VISIBLE: if `main.js` changes the init order, the error log
 *      immediately tells the admin what went wrong.
 */
let _MarketService = null;

/**
 * Sync accessor for use inside transactions.
 * Returns the registered MarketService, or null if not yet registered.
 * Callers should check for null and handle the error case.
 */
function marketServiceSync() {
    return _MarketService;
}

function now() { return Date.now(); }
function orderId() { return `ord_${Date.now()}_${Math.floor(Math.random() * 1000000)}`; }

export class MarketOrders {
    /**
     * Phase 4 Fix: Register MarketService for sync access in the match engine.
     * Called by MarketService.initialize() at the end of its init.
     * This MUST happen before any order matching can occur.
     */
    static setMarketService(MS) {
        if (MS && typeof MS.applyFillToLimits === "function") {
            _MarketService = MS;
            Logger.debug("MarketOrders", "MarketService registered with MarketOrders");
        } else {
            Logger.warn("MarketOrders", "setMarketService called with invalid MarketService (missing applyFillToLimits)");
        }
    }

    /** Phase 4 Fix: Unregister MarketService (for shutdown/hot-reload). */
    static clearMarketService() {
        _MarketService = null;
    }
    static ensureBook(data, itemId) {
        if (!data.orders[itemId]) data.orders[itemId] = { bids: [], asks: [] };
        return data.orders[itemId];
    }

    static hasCapacity(data, itemId, type) {
        const book = this.ensureBook(data, itemId);
        const side = type === "buy" ? book.bids : book.asks;
        const max = MC.ORDERS.MAX_ORDERS_PER_ITEM_SIDE || 100;
        return { ok: side.filter(order => order?.status === "open").length < max, used: side.length, max };
    }

    static countOpen(data, playerId) {
        return Object.values(data.playerOrders?.[playerId] || {}).filter(o => o.status === "open").length;
    }

    static createOrderObject(player, type, itemId, amount, pricePerItem, reserve) {
        return {
            id: orderId(),
            type,
            itemId,
            ownerId: player.id,
            ownerName: player.name,
            pricePerItem: Math.max(0, Math.floor(pricePerItem || 0)),
            amount: Math.max(1, Math.floor(amount || 1)),
            remaining: Math.max(1, Math.floor(amount || 1)),
            reservedMoney: type === "buy" ? reserve : 0,
            reservedItems: type === "sell" ? reserve : 0,
            filled: 0,
            status: "open",
            createdAt: now(),
            expiresAt: now() + (MC.ORDERS.EXPIRE_DAYS * DAY_MS)
        };
    }

    static addToData(data, order) {
        const book = this.ensureBook(data, order.itemId);
        const side = order.type === "buy" ? book.bids : book.asks;
        const max = MC.ORDERS.MAX_ORDERS_PER_ITEM_SIDE || 100;
        if (side.filter(entry => entry?.status === "open").length >= max) throw new Error(`Order book side capacity ${max} reached before reserve commit.`);
        if (!data.playerOrders[order.ownerId]) data.playerOrders[order.ownerId] = {};
        data.playerOrders[order.ownerId][order.id] = order;
        side.push(order);
        
        this.sortBook(book);
        return order;
    }

    static sortBook(book) {
        // Highest bid (buyer willing to pay most) first
        book.bids.sort((a, b) => b.pricePerItem - a.pricePerItem || a.createdAt - b.createdAt);
        // Lowest ask (seller willing to sell cheapest) first
        book.asks.sort((a, b) => a.pricePerItem - b.pricePerItem || a.createdAt - b.createdAt);
        
        // Phase 4.1: never slice open orders after reserve exists. Capacity is
        // enforced before addToData commits the order.
    }

    static sync(data, order) {
        if (data.playerOrders[order.ownerId]?.[order.id]) {
            data.playerOrders[order.ownerId][order.id] = order;
        }
    }

    // --- The Match Engine --- //
    static match(data, itemId) {
        const book = this.ensureBook(data, itemId);
        this.sortBook(book);
        let fills = 0;
        
        // Phase 7.2 (v0.21.1) (MK7): Infinite-loop guard. If something
        // goes wrong (corrupted order with remaining=0 that isn't shifted,
        // or a sortBook that re-adds the same order), the while-loop could
        // spin forever and freeze the tick. We cap iterations at a sane
        // multiple of the maximum possible fills (book size).
        const MAX_ITERATIONS = (MC.ORDERS.MAX_ORDERS_PER_ITEM_SIDE || 100) * 2 + 10;
        let iterations = 0;
        
        // Match condition: Highest Bid >= Lowest Ask
        while (book.bids.length && book.asks.length && book.bids[0].pricePerItem >= book.asks[0].pricePerItem) {
            iterations++;
            if (iterations > MAX_ITERATIONS) {
                Logger.error("MarketOrders", `match: exceeded ${MAX_ITERATIONS} iterations for ${itemId}. Breaking to prevent tick freeze. bids=${book.bids.length} asks=${book.asks.length}`);
                break;
            }
            
            const bid = book.bids[0]; 
            const ask = book.asks[0];
            if (bid.ownerId && bid.ownerId === ask.ownerId) {
                throw new Error(`Self-trade refused for ${bid.ownerId} on ${itemId}`);
            }
            
            // Amount we can trade is the minimum of what they both want
            const amount = Math.min(bid.remaining, ask.remaining);
            
            // Phase 7.2 (v0.21.1) (MK7): Zero-amount guard. If amount is 0
            // (shouldn't happen, but a corrupted order with remaining=0
            // could end up at the head), we shift both sides and continue
            // to avoid an infinite zero-progress loop.
            if (amount <= 0) {
                Logger.warn("MarketOrders", `match: zero-amount fill detected for ${itemId}. bid.remaining=${bid.remaining} ask.remaining=${ask.remaining}. Shifting both.`);
                if (bid.remaining <= 0) { bid.status = "filled"; book.bids.shift(); }
                if (ask.remaining <= 0) { ask.status = "filled"; book.asks.shift(); }
                continue;
            }
            
            // Price is determined by whoever placed their order FIRST (Maker vs Taker)
            const price = ask.createdAt <= bid.createdAt ? ask.pricePerItem : bid.pricePerItem;
            
            const total = price * amount;
            
            // For a buy order, the player originally reserved (their bid price * amount)
            const maxReserved = bid.pricePerItem * amount;
            
            // Price Improvement: If matched price is lower than bid price, buyer gets a refund
            const improvementRefund = maxReserved - total;
            const MS = marketServiceSync();
            if (!MS || typeof MS.canFillLimits !== "function" || !MS.canFillLimits(data, itemId, bid.ownerId, ask.ownerId, amount).ok) {
                throw new Error(`Daily limit pre-check refused fill of ${amount} ${itemId}`);
            }

            const fillBreakdown = MS.orderFillBreakdown(data,itemId,amount,price);
            if(!fillBreakdown)throw new Error("Order fill pricing unavailable");
            MS.collectMarketFinance(data,fillBreakdown.tax,fillBreakdown.fee);

            // 1. Deliver Item to Buyer via Mailbox
            MarketMailbox.addToData(data, bid.ownerId, { 
                type: "item", 
                itemId: itemId, 
                amount: amount, 
                reason: `Filled buy order @ $${(price/100).toFixed(2)}` 
            });
            
            // 2. Deliver Money to Seller via Mailbox
            MarketMailbox.addToData(data, ask.ownerId, { 
                type: "money", 
                amount: fillBreakdown.net, 
                reason: `Filled sell order @ $${(price/100).toFixed(2)} (after tax/fee)` 
            });
            
            // 3. Refund Price Improvement to Buyer (if any)
            if (improvementRefund > 0) {
                MarketMailbox.addToData(data, bid.ownerId, { 
                    type: "money", 
                    amount: improvementRefund, 
                    reason: `Price improvement refund` 
                });
            }

            // Update Order State
            bid.remaining -= amount; 
            ask.remaining -= amount;
            
            bid.filled += amount; 
            ask.filled += amount;
            
            bid.reservedMoney -= maxReserved; 
            ask.reservedItems -= amount;
            
            fills += amount;

            // Phase 7.2 (v0.21.1) (MK5): Apply daily-limit accounting for
            // this fill. Order-book fills were previously bypassing daily
            // limits entirely. Now both buyer and seller have their
            // playerLimits updated so subsequent instantBuy/instantSell/
            // createOrder calls are properly bounded.
            //
            // Patch 2 (v1.6.6): Fail CLOSED if MarketService is unavailable
            // or daily-limit accounting fails. This function normally runs
            // inside Database.transaction(); throwing here rolls back the
            // whole order add/match operation so no fill can bypass limits.
            if (!MS || typeof MS.applyFillToLimits !== "function") {
                const msg = `MarketService not registered; refusing to match ${amount} ${itemId} (buyer=${bid.ownerId}, seller=${ask.ownerId}) because daily-limit accounting cannot be applied.`;
                Logger.error("MarketOrders", msg);
                throw new Error(msg);
            }
            try {
                MS.applyFillToLimits(data, itemId, bid.ownerId, ask.ownerId, amount);
            } catch (e) {
                const msg = `applyFillToLimits failed; refusing fill of ${amount} ${itemId}: ${e?.message || e}`;
                Logger.error("MarketOrders", msg, e);
                throw new Error(msg);
            }

            // Handle Filled Orders
            if (bid.remaining <= 0) {
                bid.status = "filled";
                book.bids.shift(); // Remove from active book
                
                // Safety net: refund any leftover reserve
                if (bid.reservedMoney > 0) {
                    MarketMailbox.addToData(data, bid.ownerId, { type: "money", amount: bid.reservedMoney, reason: "Unused reserve refund" });
                    bid.reservedMoney = 0;
                }
            }
            
            if (ask.remaining <= 0) {
                ask.status = "filled";
                book.asks.shift(); // Remove from active book
                
                if (ask.reservedItems > 0) {
                    MarketMailbox.addToData(data, ask.ownerId, { type: "item", itemId: itemId, amount: ask.reservedItems, reason: "Unused reserve return" });
                    ask.reservedItems = 0;
                }
            }
            
            // Sync states to DB
            this.sync(data, bid); 
            this.sync(data, ask);
            
            data.stats.totalOrderVolume = (data.stats.totalOrderVolume || 0) + amount;
            data.stats.totalMoneyVolume = (data.stats.totalMoneyVolume || 0) + total;
            data.stats.totalTrades = (data.stats.totalTrades || 0) + 1;
            data.stats.lastUpdated = now();
            
            this.sortBook(book); // Re-sort in case multiple fills shifted arrays
        }

        // Phase 4 Fix: Removed the fire-and-forget getMarketService() call.
        // MarketService is now registered synchronously via setMarketService()
        // in MarketService.initialize(), so there's no async resolution to
        // kick off. If _MarketService is still null here, it's a startup-order
        // bug that should be fixed in main.js, not papered over.

        return fills;
    }

    static cancelInData(data, playerId, orderIdValue) {
        const order = data.playerOrders[playerId]?.[orderIdValue];
        if (!order || order.status !== "open") throw new Error("Open order not found.");
        
        const book = this.ensureBook(data, order.itemId);
        const side = order.type === "buy" ? book.bids : book.asks;
        const idx = side.findIndex(o => o.id === order.id);
        if (idx >= 0) side.splice(idx, 1);
        
        order.status = "cancelled";
        
        if (order.type === "buy" && order.reservedMoney > 0) {
            MarketMailbox.addToData(data, playerId, { type: "money", amount: order.reservedMoney, reason: "Cancelled buy order refund" });
            order.reservedMoney = 0;
        }
        
        if (order.type === "sell" && order.reservedItems > 0) {
            MarketMailbox.addToData(data, playerId, { type: "item", itemId: order.itemId, amount: order.reservedItems, reason: "Cancelled sell order return" });
            order.reservedItems = 0;
        }
        
        data.playerOrders[playerId][order.id] = order;
        return order;
    }

    static expireInData(data) {
        let expired = 0;
        const t = now();
        for (const [playerId, ordersObj] of Object.entries(data.playerOrders || {})) {
            for (const order of Object.values(ordersObj || {})) {
                if (!order || order.status !== "open" || (order.expiresAt || 0) > t) continue;
                this.cancelInData(data, playerId, order.id);
                order.status = "expired";
                expired++;
            }
        }
        return expired;
    }
}

export default MarketOrders;