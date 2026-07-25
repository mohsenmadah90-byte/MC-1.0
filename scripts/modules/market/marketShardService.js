// MCity Dashboard V2 - Market Shard Service
// v1.9.2 Sharding Phase 3A: facade for future market player/order sharding.
// v1.9.5 Sharding Phase 3D: shard mirror verification and repair tools.
//
// This phase does not move live MarketService reads/writes yet. It prepares
// validated shard collections and helper APIs for later migration phases.

import { CONFIG } from "../../config.js";
import { Database } from "../../core/database.js";
import { Logger } from "../../core/logger.js";
import { ShardUtils } from "../../core/shardUtils.js";
import { ShardRegistry } from "../../core/shardRegistry.js";
import { DEFAULT_MARKET_DB, validateMarketData } from "../../schemas/marketSchema.js";
import {
    DEFAULT_MARKET_PLAYERS_SHARD_DB,
    DEFAULT_MARKET_ORDERS_SHARD_DB,
    validateMarketPlayersShardData,
    validateMarketOrdersShardData
} from "../../schemas/marketShardSchema.js";
import { DisposableRegistry } from "../../core/disposableRegistry.js";

const SH = CONFIG.DATABASE?.SHARDING || {};
const MARKET_PLAYERS = SH.MODULES?.MARKET_PLAYERS || { ENABLED: false, BASE: "market_players", SHARD_COUNT: 8 };
const MARKET_ORDERS = SH.MODULES?.MARKET_ORDERS || { ENABLED: false, BASE: "market_orders", SHARD_COUNT: 8 };

export class MarketShardService {
    static #initialized = false;

    static initialize() {
        if (this.#initialized) return;
        this.#initialized = true;
        // Do not eagerly create all shard collections unless explicitly enabled.
        // For Phase 3A we only expose the facade and status report.
        if (this.playersEnabled()) {
            for (const name of this.allPlayerShardNames()) this.playerShardDBByName(name);
        }
        if (this.ordersEnabled()) {
            for (const name of this.allOrderShardNames()) this.orderShardDBByName(name);
        }
        DisposableRegistry.registerShutdownCleanup("MarketShardService.lifecycle", () => { this.#initialized = false; });
        Logger.startup("MarketShards", `Initialized (players=${this.playersEnabled()?this.playerShardCount():0}, orders=${this.ordersEnabled()?this.orderShardCount():0})`);
    }

    static playersEnabled() { return !!MARKET_PLAYERS.ENABLED; }
    static ordersEnabled() { return !!MARKET_ORDERS.ENABLED; }
    static playerShardCount() { return ShardUtils.clampCount(MARKET_PLAYERS.SHARD_COUNT || SH.PLAYER_SHARD_COUNT || 8, 8); }
    static orderShardCount() { return ShardUtils.clampCount(MARKET_ORDERS.SHARD_COUNT || SH.ITEM_SHARD_COUNT || 8, 8); }
    static playerBase() { return MARKET_PLAYERS.BASE || "market_players"; }
    static orderBase() { return MARKET_ORDERS.BASE || "market_orders"; }

    static playerShardName(playerId) {
        return ShardUtils.playerShardName(this.playerBase(), playerId, this.playerShardCount());
    }

    static orderShardName(itemId) {
        return ShardUtils.itemShardName(this.orderBase(), itemId, this.orderShardCount());
    }

    static allPlayerShardNames() { return ShardUtils.allHashShardNames(this.playerBase(), this.playerShardCount()); }
    static allOrderShardNames() { return ShardUtils.allHashShardNames(this.orderBase(), this.orderShardCount()); }

    static playerShardDB(playerId) { return this.playerShardDBByName(this.playerShardName(playerId)); }
    static orderShardDB(itemId) { return this.orderShardDBByName(this.orderShardName(itemId)); }

    static playerShardDBByName(name) {
        return Database.collection(name, DEFAULT_MARKET_PLAYERS_SHARD_DB, { validate: validateMarketPlayersShardData });
    }

    static orderShardDBByName(name) {
        return Database.collection(name, DEFAULT_MARKET_ORDERS_SHARD_DB, { validate: validateMarketOrdersShardData });
    }

    static legacyMarketDB() { return Database.collection(CONFIG.MARKET.COLLECTION, DEFAULT_MARKET_DB, { validate: validateMarketData }); }

    static syncPlayerMirrorFromLegacy(playerId, legacyDb = null) {
        if (!this.playersEnabled() || !playerId) return { success: false, skipped: "disabled" };
        const legacy = legacyDb || this.legacyMarketDB();
        const shardName = this.playerShardName(playerId);
        const shard = this.playerShardDB(playerId);
        const orders = legacy.playerOrders?.[playerId];
        const limits = legacy.playerLimits?.[playerId];
        if (orders && typeof orders === "object") shard.playerOrders[playerId] = JSON.parse(JSON.stringify(orders));
        else delete shard.playerOrders[playerId];
        if (limits && typeof limits === "object") shard.playerLimits[playerId] = JSON.parse(JSON.stringify(limits));
        else delete shard.playerLimits[playerId];
        this.#recountPlayerShard(shard);
        Database.markDirty(shardName);
        return { success: true, shardName };
    }

    /**
     * Phase 3B migration policy:
     * - mailbox is MOVED to market_players shards and cleared from legacy.
     * - playerOrders/playerLimits are MIRRORED to shards but remain in legacy
     *   because the current order-book engine still needs them atomically in
     *   the legacy market transaction until Phase 3C.
     */
    static migratePlayerDataFromLegacy() {
        if (!this.playersEnabled()) return { migrated: 0, skipped: "disabled" };
        const legacy = this.legacyMarketDB();
        if (legacy.playerShardMigration?.mailboxMoved && legacy.playerShardMigration?.shardCount === this.playerShardCount()) return { migrated: 0, skipped: "already migrated" };
        const ids = new Set([
            ...Object.keys(legacy.playerOrders || {}),
            ...Object.keys(legacy.mailbox || {}),
            ...Object.keys(legacy.playerLimits || {})
        ]);
        let migrated = 0, movedMailbox = 0;
        for (const pid of ids) {
            const shardName = this.playerShardName(pid);
            const shard = this.playerShardDB(pid);
            if (legacy.playerOrders?.[pid]) shard.playerOrders[pid] = JSON.parse(JSON.stringify(legacy.playerOrders[pid]));
            if (legacy.playerLimits?.[pid]) shard.playerLimits[pid] = JSON.parse(JSON.stringify(legacy.playerLimits[pid]));
            if (legacy.mailbox?.[pid]) {
                const existing = Array.isArray(shard.mailbox[pid]) ? shard.mailbox[pid] : [];
                const byId = new Map();
                for (const e of existing) if (e?.id) byId.set(e.id, e);
                for (const e of legacy.mailbox[pid]) if (e?.id) byId.set(e.id, e);
                shard.mailbox[pid] = [...byId.values()];
                delete legacy.mailbox[pid];
                movedMailbox++;
            }
            this.#recountPlayerShard(shard);
            Database.markDirty(shardName);
            migrated++;
        }
        legacy.playerShardMigration = { mailboxMoved: true, mirroredAt: Date.now(), shardCount: this.playerShardCount() };
        Database.markDirty(CONFIG.MARKET.COLLECTION);
        Logger.startup("MarketShards", `Mirrored ${migrated} player market record(s), moved ${movedMailbox} mailbox list(s) to ${this.playerShardCount()} shard(s)`);
        return { migrated, movedMailbox };
    }

    static getPlayerOrders(playerId) { return this.playersEnabled() ? (this.playerShardDB(playerId).playerOrders[playerId] || {}) : {}; }
    static getMailbox(playerId) { return this.playersEnabled() ? (this.playerShardDB(playerId).mailbox[playerId] || []) : []; }
    static getPlayerLimits(playerId) { return this.playersEnabled() ? (this.playerShardDB(playerId).playerLimits[playerId] || null) : null; }

    static #recountPlayerShard(shard) {
        const players = new Set([...Object.keys(shard.playerOrders || {}), ...Object.keys(shard.mailbox || {}), ...Object.keys(shard.playerLimits || {})]);
        shard.stats.totalPlayers = players.size;
        shard.stats.totalMailboxEntries = Object.values(shard.mailbox || {}).reduce((s, list) => s + (Array.isArray(list) ? list.length : 0), 0);
        shard.stats.totalPlayerOrders = Object.values(shard.playerOrders || {}).reduce((s, obj) => s + (obj && typeof obj === "object" ? Object.keys(obj).length : 0), 0);
        shard.stats.lastUpdated = Date.now();
    }

    static syncOrderBookFromLegacy(itemId, legacyDb = null) {
        if (!this.ordersEnabled() || !itemId) return { success: false, skipped: "disabled" };
        const legacy = legacyDb || this.legacyMarketDB();
        const normalized = String(itemId || "").toLowerCase();
        const legacyBook = legacy.orders?.[normalized] || { bids: [], asks: [] };
        const shardName = this.orderShardName(normalized);
        const shard = this.orderShardDB(normalized);
        if (!shard.orderBooks) shard.orderBooks = {};
        const bids = Array.isArray(legacyBook.bids) ? legacyBook.bids.filter(o => o && o.status === "open") : [];
        const asks = Array.isArray(legacyBook.asks) ? legacyBook.asks.filter(o => o && o.status === "open") : [];
        if (bids.length || asks.length) shard.orderBooks[normalized] = JSON.parse(JSON.stringify({ bids, asks }));
        else delete shard.orderBooks[normalized];
        this.#recountOrderShard(shard);
        Database.markDirty(shardName);
        return { success: true, shardName, bids: bids.length, asks: asks.length };
    }

    static migrateOrderBooksFromLegacy() {
        if (!this.ordersEnabled()) return { migrated: 0, skipped: "disabled" };
        const legacy = this.legacyMarketDB();
        if (legacy.orderShardMigration?.orderBooksMirrored && legacy.orderShardMigration?.shardCount === this.orderShardCount()) return { migrated: 0, skipped: "already migrated" };
        let migrated = 0;
        for (const itemId of Object.keys(legacy.orders || {})) {
            const res = this.syncOrderBookFromLegacy(itemId, legacy);
            if (res.success) migrated++;
        }
        legacy.orderShardMigration = { orderBooksMirrored: true, mirroredAt: Date.now(), shardCount: this.orderShardCount() };
        Database.markDirty(CONFIG.MARKET.COLLECTION);
        Logger.startup("MarketShards", `Mirrored ${migrated} market order book(s) to ${this.orderShardCount()} item shard(s)`);
        return { migrated };
    }

    static getOrderBook(itemId, legacyDb = null) {
        const normalized = String(itemId || "").toLowerCase();
        if (this.ordersEnabled()) {
            const shard = this.orderShardDB(normalized);
            const book = shard.orderBooks?.[normalized];
            if (book) return book;
        }
        const legacy = legacyDb || this.legacyMarketDB();
        return legacy.orders?.[normalized] || { bids: [], asks: [] };
    }

    static #recountOrderShard(shard) {
        let bids = 0, asks = 0;
        for (const book of Object.values(shard.orderBooks || {})) {
            bids += Array.isArray(book.bids) ? book.bids.filter(o => o && o.status === "open").length : 0;
            asks += Array.isArray(book.asks) ? book.asks.filter(o => o && o.status === "open").length : 0;
        }
        shard.stats.totalItems = Object.keys(shard.orderBooks || {}).length;
        shard.stats.totalOpenBids = bids;
        shard.stats.totalOpenAsks = asks;
        shard.stats.lastUpdated = Date.now();
    }

    static verifyMirrors() {
        const legacy = this.legacyMarketDB();
        const report = {
            playersEnabled: this.playersEnabled(),
            ordersEnabled: this.ordersEnabled(),
            legacyMailboxPlayers: Object.keys(legacy.mailbox || {}).length,
            playerOrderPlayers: 0,
            playerOrderMismatches: 0,
            playerLimitPlayers: 0,
            playerLimitMismatches: 0,
            orderBooks: 0,
            orderBookMismatches: 0,
            missingOrderShardBooks: 0
        };

        if (this.playersEnabled()) {
            const ids = new Set([...Object.keys(legacy.playerOrders || {}), ...Object.keys(legacy.playerLimits || {})]);
            for (const pid of ids) {
                const legacyOrders = legacy.playerOrders?.[pid] || {};
                const shardOrders = this.getPlayerOrders(pid) || {};
                if (Object.keys(legacyOrders).length) report.playerOrderPlayers++;
                if (Object.keys(legacyOrders).length !== Object.keys(shardOrders).length) report.playerOrderMismatches++;
                const legacyLimits = legacy.playerLimits?.[pid] || null;
                const shardLimits = this.getPlayerLimits(pid) || null;
                if (legacyLimits) report.playerLimitPlayers++;
                if (!!legacyLimits !== !!shardLimits) report.playerLimitMismatches++;
            }
        }

        if (this.ordersEnabled()) {
            for (const [itemId, book] of Object.entries(legacy.orders || {})) {
                report.orderBooks++;
                const legacyBids = (book?.bids || []).filter(o => o && o.status === "open").length;
                const legacyAsks = (book?.asks || []).filter(o => o && o.status === "open").length;
                const shardBook = this.getOrderBook(itemId, legacy);
                const shardBids = (shardBook?.bids || []).filter(o => o && o.status === "open").length;
                const shardAsks = (shardBook?.asks || []).filter(o => o && o.status === "open").length;
                if (!shardBook || (!shardBids && !shardAsks && (legacyBids || legacyAsks))) report.missingOrderShardBooks++;
                if (legacyBids !== shardBids || legacyAsks !== shardAsks) report.orderBookMismatches++;
            }
        }
        report.ok = report.legacyMailboxPlayers === 0 && report.playerOrderMismatches === 0 && report.playerLimitMismatches === 0 && report.orderBookMismatches === 0;
        return report;
    }

    static repairMirrors() {
        const legacy = this.legacyMarketDB();
        let playerMirrors = 0, orderMirrors = 0, movedMailbox = 0;
        if (this.playersEnabled()) {
            const ids = new Set([...Object.keys(legacy.playerOrders || {}), ...Object.keys(legacy.playerLimits || {}), ...Object.keys(legacy.mailbox || {})]);
            for (const pid of ids) {
                const beforeMailbox = Array.isArray(legacy.mailbox?.[pid]) ? legacy.mailbox[pid].length : 0;
                this.syncPlayerMirrorFromLegacy(pid, legacy);
                if (beforeMailbox) {
                    const shard = this.playerShardDB(pid);
                    const existing = Array.isArray(shard.mailbox[pid]) ? shard.mailbox[pid] : [];
                    const byId = new Map(existing.map(e => [e.id, e]));
                    for (const e of legacy.mailbox[pid] || []) if (e?.id) byId.set(e.id, e);
                    shard.mailbox[pid] = [...byId.values()];
                    delete legacy.mailbox[pid];
                    this.#recountPlayerShard(shard);
                    Database.markDirty(this.playerShardName(pid));
                    movedMailbox++;
                }
                playerMirrors++;
            }
        }
        if (this.ordersEnabled()) {
            for (const itemId of Object.keys(legacy.orders || {})) {
                this.syncOrderBookFromLegacy(itemId, legacy);
                orderMirrors++;
            }
        }
        legacy.playerShardRepair = { repairedAt: Date.now(), playerMirrors, orderMirrors, movedMailbox };
        Database.markDirty(CONFIG.MARKET.COLLECTION);
        const verify = this.verifyMirrors();
        Logger.warn("MarketShards", `Repair mirrors complete: players=${playerMirrors}, orders=${orderMirrors}, movedMailbox=${movedMailbox}, ok=${verify.ok}`);
        return { playerMirrors, orderMirrors, movedMailbox, verify };
    }

    static authority() { return { players: "shard", orders: "shard", legacyRetainedForRollback: true, locked: true }; }

    static status() {
        return {
            registry: {
                marketPlayers: ShardRegistry.definition("MARKET_PLAYERS"),
                marketOrders: ShardRegistry.definition("MARKET_ORDERS")
            },
            players: {
                enabled: this.playersEnabled(),
                base: this.playerBase(),
                shardCount: this.playerShardCount(),
                shards: this.playersEnabled() ? this.allPlayerShardNames() : []
            },
            orders: {
                enabled: this.ordersEnabled(),
                base: this.orderBase(),
                shardCount: this.orderShardCount(),
                shards: this.ordersEnabled() ? this.allOrderShardNames() : []
            }
        };
    }

    static stats() {
        const status = this.status();
        const out = { ...status, playerShardStats: [], orderShardStats: [] };
        if (this.playersEnabled()) {
            for (const name of this.allPlayerShardNames()) {
                const st = Database.stats(name);
                out.playerShardStats.push({ name, loaded: !!st, size: st?.size || 0, itemCount: st?.itemCount || 0, dirty: !!st?.dirty });
            }
        }
        if (this.ordersEnabled()) {
            for (const name of this.allOrderShardNames()) {
                const st = Database.stats(name);
                out.orderShardStats.push({ name, loaded: !!st, size: st?.size || 0, itemCount: st?.itemCount || 0, dirty: !!st?.dirty });
            }
        }
        return out;
    }
}

export default MarketShardService;
