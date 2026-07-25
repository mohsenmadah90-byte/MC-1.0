// MCity Dashboard V2 - Market Shard Schemas
// v1.9.2 Sharding Phase 3A: data models for future market sharding.

import { CONFIG } from "../config.js";

const MC = CONFIG.MARKET;

export const DEFAULT_MARKET_PLAYERS_SHARD_DB = {
    schemaVersion: 1,
    version: "1.0.0",
    playerOrders: {},  // playerId -> orderId -> order summary
    mailbox: {},       // playerId -> mailbox entries
    playerLimits: {},  // playerId -> daily buy/sell limits
    stats: {
        totalPlayers: 0,
        totalMailboxEntries: 0,
        totalPlayerOrders: 0,
        lastUpdated: 0
    }
};

export const DEFAULT_MARKET_ORDERS_SHARD_DB = {
    schemaVersion: 1,
    version: "1.0.0",
    orderBooks: {},    // itemId -> { bids: [], asks: [] }
    stats: {
        totalItems: 0,
        totalOpenBids: 0,
        totalOpenAsks: 0,
        lastUpdated: 0
    }
};

function now() { return Date.now(); }
function safeInt(v, d = 0) { const n = Math.floor(Number(v)); return Number.isFinite(n) ? Math.max(d, n) : d; }
function safeKey(v, max = 100) { return String(v || "").substring(0, max); }
function safeObj(v) { try { return JSON.parse(JSON.stringify(v || {})); } catch { return {}; } }

export function sanitizeMarketOrder(raw = {}) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const type = raw.type === "sell" ? "sell" : "buy";
    return {
        id: safeKey(raw.id || `ord_${now()}_${Math.floor(Math.random() * 1000000)}`, 100),
        type,
        itemId: safeKey(raw.itemId || "minecraft:stone", 100),
        ownerId: safeKey(raw.ownerId || "", 64),
        ownerName: safeKey(raw.ownerName || "Unknown", 32),
        pricePerItem: safeInt(raw.pricePerItem, 0),
        amount: Math.max(1, safeInt(raw.amount, 1)),
        remaining: Math.max(0, safeInt(raw.remaining, 0)),
        reservedMoney: safeInt(raw.reservedMoney, 0),
        reservedItems: safeInt(raw.reservedItems, 0),
        filled: safeInt(raw.filled, 0),
        status: ["open", "filled", "cancelled", "expired"].includes(raw.status) ? raw.status : "open",
        createdAt: Number(raw.createdAt) || now(),
        expiresAt: Number(raw.expiresAt) || 0,
        updatedAt: Number(raw.updatedAt) || 0
    };
}

export function sanitizeMarketMailboxEntry(raw = {}) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const type = raw.type === "item" ? "item" : raw.type === "money" ? "money" : safeKey(raw.type || "unknown", 32);
    const entry = {
        id: safeKey(raw.id || `mail_${now()}_${Math.floor(Math.random() * 1000000)}`, 100),
        type,
        amount: safeInt(raw.amount, 0),
        reason: safeKey(raw.reason || "Market mailbox", 200),
        createdAt: Number(raw.createdAt) || now(),
        meta: safeObj(raw.meta),
        deliveryState: ["pending","delivery_attempted","delivery_uncertain"].includes(raw.deliveryState) ? raw.deliveryState : "pending",
        deliveryAttemptedAt: Number(raw.deliveryAttemptedAt) || 0
    };
    if (type === "item") entry.itemId = safeKey(raw.itemId || "minecraft:stone", 100);
    return entry.amount > 0 ? entry : null;
}

export function validateMarketPlayersShardData(data, def = DEFAULT_MARKET_PLAYERS_SHARD_DB) {
    const out = JSON.parse(JSON.stringify(def));
    try {
        out.version = data?.version || "1.0.0";
        out.schemaVersion = Math.max(1, Math.floor(Number(data?.schemaVersion) || Number(out.schemaVersion) || 1));
        if (data?.playerOrders && typeof data.playerOrders === "object" && !Array.isArray(data.playerOrders)) {
            for (const [pid, orders] of Object.entries(data.playerOrders)) {
                if (!orders || typeof orders !== "object" || Array.isArray(orders)) continue;
                const clean = {};
                for (const [oid, raw] of Object.entries(orders)) {
                    const o = sanitizeMarketOrder({ ...raw, id: oid });
                    if (o) clean[o.id] = o;
                }
                if (Object.keys(clean).length) out.playerOrders[pid] = clean;
            }
        }
        if (data?.mailbox && typeof data.mailbox === "object" && !Array.isArray(data.mailbox)) {
            for (const [pid, list] of Object.entries(data.mailbox)) {
                if (!Array.isArray(list)) continue;
                const clean = list.map(sanitizeMarketMailboxEntry).filter(Boolean); // economic obligations are never count-trimmed
                if (clean.length) out.mailbox[pid] = clean;
            }
        }
        if (data?.playerLimits && typeof data.playerLimits === "object" && !Array.isArray(data.playerLimits)) {
            out.playerLimits = safeObj(data.playerLimits);
        }
        out.stats = { ...out.stats, ...(data?.stats || {}) };
        out.stats.totalPlayers = new Set([...Object.keys(out.playerOrders), ...Object.keys(out.mailbox), ...Object.keys(out.playerLimits)]).size;
        out.stats.totalMailboxEntries = Object.values(out.mailbox).reduce((s, list) => s + list.length, 0);
        out.stats.totalPlayerOrders = Object.values(out.playerOrders).reduce((s, orders) => s + Object.keys(orders).length, 0);
    } catch {
        return JSON.parse(JSON.stringify(def));
    }
    return out;
}

export function validateMarketOrdersShardData(data, def = DEFAULT_MARKET_ORDERS_SHARD_DB) {
    const out = JSON.parse(JSON.stringify(def));
    try {
        out.version = data?.version || "1.0.0";
        out.schemaVersion = Math.max(1, Math.floor(Number(data?.schemaVersion) || Number(out.schemaVersion) || 1));
        const books = data?.orderBooks && typeof data.orderBooks === "object" && !Array.isArray(data.orderBooks) ? data.orderBooks : {};
        let openBids = 0, openAsks = 0;
        for (const [itemId, book] of Object.entries(books)) {
            if (!book || typeof book !== "object") continue;
            const bids = Array.isArray(book.bids) ? book.bids.map(sanitizeMarketOrder).filter(o => o && o.status === "open") : [];
            const asks = Array.isArray(book.asks) ? book.asks.map(sanitizeMarketOrder).filter(o => o && o.status === "open") : [];
            if (bids.length || asks.length) {
                out.orderBooks[itemId] = { bids, asks };
                openBids += bids.length;
                openAsks += asks.length;
            }
        }
        out.stats = { ...out.stats, ...(data?.stats || {}) };
        out.stats.totalItems = Object.keys(out.orderBooks).length;
        out.stats.totalOpenBids = openBids;
        out.stats.totalOpenAsks = openAsks;
    } catch {
        return JSON.parse(JSON.stringify(def));
    }
    return out;
}

export default {
    DEFAULT_MARKET_PLAYERS_SHARD_DB,
    DEFAULT_MARKET_ORDERS_SHARD_DB,
    validateMarketPlayersShardData,
    validateMarketOrdersShardData,
    sanitizeMarketOrder,
    sanitizeMarketMailboxEntry
};
