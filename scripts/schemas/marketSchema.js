// MCity Dashboard V2 - Market Schema
// Phase 7.2 (v0.21.1): Clamp tax/fee rates to [0,1] to prevent treasury drain.

import { CONFIG } from "../config.js";

const MC = CONFIG.MARKET;
const HISTORY_LIMIT = MC.PRICE.HISTORY_LIMIT;
const RECENT_TRADES_LIMIT = 20;

export const DEFAULT_MARKET_DB = {
    schemaVersion: 1,
    version: "1.0.0",
    categories: [],
    orders: {},        // itemId -> { bids: [], asks: [] }
    playerOrders: {},  // playerId -> { orderId -> order }
    playerLimits: {},  // playerId -> { dayKey, buy:{}, sell:{} }
    mailbox: {},       // playerId -> entries
    treasury: {
        balance: 0,
        totalFeesCollected: 0,
        totalTaxToTreasury: 0,
        totalTaxBurned: 0,
        totalDeposited: 0,
        totalWithdrawn: 0
    },
    stats: {
        totalTrades: 0,
        totalBuyVolume: 0,
        totalSellVolume: 0,
        totalOrderVolume: 0,
        totalMoneyVolume: 0,
        lastUpdated: 0
    },
    lastPriceUpdate: 0,
    // Phase 5 Fix: Anchor timestamp for stable day-boundary computation.
    // See MarketService.dayKey() for why this exists.
    lastLimitAnchor: 0,
    seeded: false,
    authority: { economic: "legacy", locked: true, lockedAt: 0 }
};

function safeInt(v, d = 0) {
    const n = Math.floor(Number(v));
    return Number.isFinite(n) ? n : d;
}

/**
 * Phase 7.2 (v0.21.1) (MK8): Clamp a rate value to [0, 1].
 *
 * Previously, `taxRate`, `buyFeeRate`, and `sellFeeRate` were accepted
 * from raw DB data without any range check. An admin (or a corrupted
 * DB) could set a negative rate, which would cause `buyBreakdown` to
 * compute a negative fee, making the total LESS than the gross —
 * effectively giving the player a discount funded by the treasury.
 *
 * This helper ensures rates are always in the valid [0, 1] range.
 * If the input is not a finite number, returns the configured default.
 */
function clampRate(v, defaultRate) {
    const n = Number(v);
    if (!Number.isFinite(n)) return defaultRate;
    return Math.max(0, Math.min(1, n));
}

export function normalizeItemId(itemId) {
    const raw = String(itemId || "").trim().toLowerCase();
    if (!raw) return "minecraft:stone";
    return raw.includes(":") ? raw : `minecraft:${raw}`;
}

export function normalizeMarketItem(raw = {}) {
    const baseBuy = Math.max(0, safeInt(raw.baseBuyPrice ?? raw.buyPrice, 100));
    const baseSell = Math.max(0, safeInt(raw.baseSellPrice ?? raw.sellPrice ?? Math.floor(baseBuy * MC.DEFAULTS.SELL_RATIO), Math.floor(baseBuy * MC.DEFAULTS.SELL_RATIO)));
    const stock = Math.max(0, safeInt(raw.stock, MC.DEFAULTS.INITIAL_STOCK));
    const targetStock = Math.max(1, safeInt(raw.targetStock, Math.max(stock, MC.DEFAULTS.TARGET_STOCK)));
    return {
        id: normalizeItemId(raw.id || "minecraft:stone"),
        displayName: raw.displayName ? String(raw.displayName).substring(0, 40) : null,
        icon: raw.icon || null,
        enabled: raw.enabled !== false,
        allowBuy: raw.allowBuy !== false,
        allowSell: raw.allowSell !== false,
        requireTag: raw.requireTag ? String(raw.requireTag).substring(0, 32) : null,
        baseBuyPrice: baseBuy,
        baseSellPrice: baseSell,
        buyPrice: Math.max(0, safeInt(raw.buyPrice, baseBuy)),
        sellPrice: Math.max(0, safeInt(raw.sellPrice, baseSell)),
        minPrice: Math.max(0, safeInt(raw.minPrice, Math.floor(baseBuy * 0.5))),
        maxPrice: Math.max(0, safeInt(raw.maxPrice, Math.floor(baseBuy * 2))),
        stock,
        targetStock,
        maxStockSoft: Math.max(targetStock, safeInt(raw.maxStockSoft, targetStock * 3)),
        dailyBuyLimit: Math.max(0, safeInt(raw.dailyBuyLimit, MC.DEFAULTS.DAILY_BUY_LIMIT)),
        dailySellLimit: Math.max(0, safeInt(raw.dailySellLimit, MC.DEFAULTS.DAILY_SELL_LIMIT)),
        taxRate: clampRate(raw.taxRate, MC.TAX.SELL_TAX_RATE),
        buyFeeRate: clampRate(raw.buyFeeRate, MC.FEE.BUY_FEE_RATE),
        sellFeeRate: clampRate(raw.sellFeeRate, MC.FEE.SELL_FEE_RATE),
        totalBought: Math.max(0, safeInt(raw.totalBought, 0)),
        totalSold: Math.max(0, safeInt(raw.totalSold, 0)),
        totalTrades: Math.max(0, safeInt(raw.totalTrades, 0)),
        totalVolume: Math.max(0, safeInt(raw.totalVolume, 0)),
        lastTradePrice: Math.max(0, safeInt(raw.lastTradePrice, raw.buyPrice ?? baseBuy)),
        high24h: Math.max(0, safeInt(raw.high24h, raw.buyPrice ?? baseBuy)),
        low24h: Math.max(0, safeInt(raw.low24h, raw.buyPrice ?? baseBuy)),
        priceChange24h: Number(raw.priceChange24h) || 0,
        priceHistory: Array.isArray(raw.priceHistory) ? raw.priceHistory.slice(-HISTORY_LIMIT) : [],
        recentTrades: Array.isArray(raw.recentTrades) ? raw.recentTrades.slice(-RECENT_TRADES_LIMIT) : []
    };
}

function sanitizeOrder(order = {}) {
    const id = String(order.id || "").substring(0, 64);
    if (!id) return null;
    return {
        id,
        type: order.type === "sell" ? "sell" : "buy",
        itemId: normalizeItemId(order.itemId),
        ownerId: String(order.ownerId || "").substring(0, 64),
        ownerName: String(order.ownerName || "Unknown").substring(0, 32),
        pricePerItem: Math.max(0, safeInt(order.pricePerItem, 0)),
        amount: Math.max(1, safeInt(order.amount, 1)),
        remaining: Math.max(0, safeInt(order.remaining, 0)),
        reservedMoney: Math.max(0, safeInt(order.reservedMoney, 0)),
        reservedItems: Math.max(0, safeInt(order.reservedItems, 0)),
        filled: Math.max(0, safeInt(order.filled, 0)),
        status: ["open", "filled", "cancelled", "expired"].includes(order.status) ? order.status : "open",
        createdAt: Number(order.createdAt) || Date.now(),
        expiresAt: Number(order.expiresAt) || 0
    };
}

export function validateMarketData(data, def = DEFAULT_MARKET_DB) {
    const out = JSON.parse(JSON.stringify(def));
    try {
        out.version = data?.version || "1.0.0";
        out.schemaVersion = Math.max(1, Math.floor(Number(data?.schemaVersion) || Number(out.schemaVersion) || 1));
        if (Array.isArray(data?.categories)) {
            for (const cat of data.categories.slice(0, 50)) {
                if (!cat || typeof cat !== "object") continue;
                const clean = {
                    name: String(cat.name || "default").substring(0, 32),
                    displayName: String(cat.displayName || cat.name || "Default").substring(0, 40),
                    icon: cat.icon || null,
                    items: []
                };
                if (Array.isArray(cat.items)) clean.items = cat.items.slice(0, 100).filter(i => i?.id).map(normalizeMarketItem);
                if (clean.items.length) out.categories.push(clean);
            }
        }
        out.orders = {};
        if (data?.orders && typeof data.orders === "object") {
            for (const [itemId, book] of Object.entries(data.orders)) {
                out.orders[normalizeItemId(itemId)] = {
                    bids: Array.isArray(book?.bids) ? book.bids.map(sanitizeOrder).filter(Boolean) : [],
                    asks: Array.isArray(book?.asks) ? book.asks.map(sanitizeOrder).filter(Boolean) : []
                };
            }
        }
        out.playerOrders = data?.playerOrders && typeof data.playerOrders === "object" ? data.playerOrders : {};
        out.playerLimits = data?.playerLimits && typeof data.playerLimits === "object" ? data.playerLimits : {};
        out.mailbox = data?.mailbox && typeof data.mailbox === "object" ? data.mailbox : {};
        out.treasury = { ...out.treasury, ...(data?.treasury || {}) };
        out.stats = { ...out.stats, ...(data?.stats || {}) };
        out.lastPriceUpdate = Number(data?.lastPriceUpdate) || 0;
        // Phase 5 Fix: Preserve the limit anchor for stable day boundaries.
        out.lastLimitAnchor = Number(data?.lastLimitAnchor) || 0;
        out.seeded = !!data?.seeded;
        out.authority = { economic: "legacy", locked: true, lockedAt: Number(data?.authority?.lockedAt) || Date.now() };
    } catch {
        return JSON.parse(JSON.stringify(def));
    }
    return out;
}

export default { DEFAULT_MARKET_DB, validateMarketData, normalizeMarketItem, normalizeItemId };
