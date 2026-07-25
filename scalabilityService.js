// MCity Dashboard V2 - Scalability / Pruning Service
// Hotfix 4 (v1.6.4): Bounded growth controls for large collections.
// Patch 2 (v1.6.6): Reserve-safe market order pruning.

import { CONFIG } from "../config.js";
import { Database } from "./database.js";
import { Logger } from "./logger.js";
import { DisposableRegistry } from "./disposableRegistry.js";
import { ShardUtils } from "./shardUtils.js";
import { DEFAULT_NOTIFICATION_DB, validateNotificationData } from "../schemas/notificationSchema.js";
import { DEFAULT_FINANCE_DB, validateFinanceData } from "../schemas/financeSchema.js";
import { DEFAULT_CONTRACT_DB, validateContractData, rebuildContractIndexes } from "../schemas/contractSchema.js";
import { DEFAULT_CONTRACT_MAILBOX_SHARD_DB, validateContractMailboxShardData } from "../schemas/contractShardSchema.js";
import { DEFAULT_LAND_DB, validateLandData } from "../schemas/landSchema.js";
import { DEFAULT_MARKET_DB, validateMarketData } from "../schemas/marketSchema.js";
import { DEFAULT_MARKET_PLAYERS_SHARD_DB, validateMarketPlayersShardData, DEFAULT_MARKET_ORDERS_SHARD_DB, validateMarketOrdersShardData } from "../schemas/marketShardSchema.js";
import { DEFAULT_FINANCIAL_JOURNAL_DB, validateFinancialJournalData } from "../schemas/financialJournalSchema.js";
import { AuditService } from "../modules/audit/auditService.js";
import { LandShardService } from "../modules/land/landShardService.js";
import { RuntimeHandleRegistry } from "./runtimeHandleRegistry.js";
import { BatchTaskService } from "./batchTaskService.js";
import { OperationJournalService } from "./operationJournalService.js";

const SC = CONFIG.SCALABILITY || {};
const DAY_MS = 24 * 60 * 60 * 1000;
function now() { return Date.now(); }
function cutoff(days, fallbackDays) { return now() - Math.max(1, Math.floor(Number(days || fallbackDays) || fallbackDays)) * DAY_MS; }

export class ScalabilityService {
    static #initialized = false;
    static #intervalId = null;
    static #lastReport = null;

    static initialize() {
        if (this.#initialized) return;
        this.#initialized = true;
        const interval = Math.max(1200, Math.floor(Number(SC.PRUNE_INTERVAL_TICKS) || 12000));
        BatchTaskService.register("scalability_prune", {
            process: task => this.#processPruneBatch(task),
            afterCommit: effects => this.#afterPruneTask(effects)
        });
        this.#intervalId = RuntimeHandleRegistry.interval("Scalability.prune", () => {
            try { this.pruneAll("interval"); } catch (e) { Logger.warn("Scalability", "Scheduled prune failed", e); }
        }, interval);
        DisposableRegistry.registerShutdownCleanup("ScalabilityService.interval", () => {
            if (this.#intervalId) { RuntimeHandleRegistry.clear(this.#intervalId); this.#intervalId = null; }
            this.#initialized = false;
        });
        Logger.startup("Scalability", `Initialized (prune interval ${interval} ticks)`);
    }

    static pruneAll(reason = "manual") {
        const started = BatchTaskService.start("scalability_prune", { reason, snapshotTime: now() }, { dedupeKey: "scalability_prune" });
        return {
            started: !!started.started,
            taskId: started.task?.id || null,
            message: started.started ? "Scalability prune queued as a persisted staged task." : started.message,
            risks: this.largeCollectionReport()
        };
    }

    static #processPruneBatch(task) {
        const stages = [
            ["notifications", () => this.pruneNotifications()],
            ["finance", () => this.pruneFinance()],
            ["contracts", () => this.pruneContracts()],
            ["land", () => this.pruneLand()],
            ["market", () => this.pruneMarket()],
            ["journals", () => this.pruneFinancialJournals()],
            ["risks", () => this.largeCollectionReport()]
        ];
        const stage = Math.max(0, Math.floor(Number(task.cursor?.stage) || 0));
        if (stage >= stages.length) return { done: true, cursor: { stage }, progress: task.progress || {}, resultPatch: {}, effects: { report: task.result || {} }, flushCollections: [] };
        const [name, execute] = stages[stage];
        const result = execute();
        const nextStage = stage + 1;
        const progress = { stage: nextStage, stagesCompleted: nextStage, totalStages: stages.length };
        const dirtyCollections = Database.listCollections().filter(collection => collection !== BatchTaskService.collectionName() && Database.stats(collection)?.dirty);
        const finalReport = { ...(task.result || {}), [name]: result, reason: task.payload?.reason || "manual", time: task.payload?.snapshotTime || now() };
        return {
            done: nextStage >= stages.length,
            cursor: { stage: nextStage },
            progress,
            resultPatch: { [name]: result, reason: finalReport.reason, time: finalReport.time },
            effects: nextStage >= stages.length ? { report: finalReport } : null,
            flushCollections: dirtyCollections
        };
    }

    static #afterPruneTask(effects) {
        if (!effects?.report) return;
        this.#lastReport = effects.report;
        const risks = effects.report.risks || [];
        try { AuditService.record("scalability.prune", "system", "", "system", "Scalability prune task completed", effects.report, risks.length ? "warn" : "info"); }
        catch (error) { Logger.debug("Scalability", "Prune completion audit failed", error); }
    }

    static lastReport() { return this.#lastReport; }

    static #notificationCollections() {
        const cfg = CONFIG.DATABASE?.SHARDING?.MODULES?.NOTIFICATIONS;
        return cfg?.ENABLED ? [CONFIG.NOTIFICATIONS.COLLECTION, ...ShardUtils.allHashShardNames(cfg.BASE || CONFIG.NOTIFICATIONS.COLLECTION, cfg.SHARD_COUNT || CONFIG.DATABASE?.SHARDING?.PLAYER_SHARD_COUNT || 8)] : [CONFIG.NOTIFICATIONS.COLLECTION];
    }

    static #financePayoutCollections() {
        const cfg = CONFIG.DATABASE?.SHARDING?.MODULES?.FINANCE_PAYOUTS;
        return cfg?.ENABLED ? [CONFIG.FINANCE.COLLECTION, ...ShardUtils.allHashShardNames(cfg.BASE || "finance_payouts", cfg.SHARD_COUNT || CONFIG.DATABASE?.SHARDING?.PLAYER_SHARD_COUNT || 8)] : [CONFIG.FINANCE.COLLECTION];
    }

    static #marketPlayerCollections() {
        const cfg = CONFIG.DATABASE?.SHARDING?.MODULES?.MARKET_PLAYERS;
        return cfg?.ENABLED ? ShardUtils.allHashShardNames(cfg.BASE || "market_players", cfg.SHARD_COUNT || CONFIG.DATABASE?.SHARDING?.PLAYER_SHARD_COUNT || 8) : [];
    }

    static #contractMailboxCollections() {
        const cfg = CONFIG.DATABASE?.SHARDING?.MODULES?.CONTRACT_MAILBOX;
        return cfg?.ENABLED ? ShardUtils.allHashShardNames(cfg.BASE || "contract_mailbox", cfg.SHARD_COUNT || CONFIG.DATABASE?.SHARDING?.PLAYER_SHARD_COUNT || 8) : [];
    }

    static #marketOrderCollections() {
        const cfg = CONFIG.DATABASE?.SHARDING?.MODULES?.MARKET_ORDERS;
        return cfg?.ENABLED ? ShardUtils.allHashShardNames(cfg.BASE || "market_orders", cfg.SHARD_COUNT || CONFIG.DATABASE?.SHARDING?.ITEM_SHARD_COUNT || 8) : [];
    }

    static pruneNotifications() {
        const readCutoff = cutoff(SC.NOTIFICATION_READ_RETENTION_DAYS, 14);
        const max = CONFIG.NOTIFICATIONS.MAX_PER_PLAYER || 100;
        let removed = 0, playersTouched = 0;
        for (const collection of this.#notificationCollections()) {
            Database.collection(collection, DEFAULT_NOTIFICATION_DB, { validate: validateNotificationData });
            const tx = Database.transaction(collection, data => {
                let r = 0, touched = 0;
                for (const [pid, list] of Object.entries(data.players || {})) {
                    if (!Array.isArray(list)) { delete data.players[pid]; r++; continue; }
                    const before = list.length;
                    let clean = list.filter(n => n && (!n.read || (n.createdAt || 0) >= readCutoff));
                    if (clean.length > max) clean = clean.slice(-max);
                    r += before - clean.length;
                    if (clean.length) data.players[pid] = clean; else delete data.players[pid];
                    if (before !== clean.length) touched++;
                }
                if (collection === CONFIG.NOTIFICATIONS.COLLECTION) {
                    const sysBefore = Array.isArray(data.systemEvents) ? data.systemEvents.length : 0;
                    data.systemEvents = Array.isArray(data.systemEvents) ? data.systemEvents.slice(-(CONFIG.NOTIFICATIONS.MAX_SYSTEM_EVENTS || 500)) : [];
                    r += Math.max(0, sysBefore - data.systemEvents.length);
                }
                return { removed: r, playersTouched: touched };
            });
            if (tx.success) { removed += tx.result.removed || 0; playersTouched += tx.result.playersTouched || 0; }
        }
        return { removed, playersTouched, collections: this.#notificationCollections().length };
    }

    static pruneFinance() {
        // Phase 3.3: payout obligations are economic value and are never
        // count-trimmed. Only non-authoritative ledger history may compact;
        // cumulative totals and every positive payout remain intact.
        const historyLimit = CONFIG.FINANCE.MAX_LEDGER_HISTORY || 1500;
        let trimmedTransactions = 0, trimmedPayouts = 0, removedEmptyPayoutLists = 0;
        const collections = [...new Set([CONFIG.FINANCE.COLLECTION, ...this.#financePayoutCollections()])];
        for (const collection of collections) {
            Database.collection(collection, DEFAULT_FINANCE_DB, { validate: validateFinanceData });
            const tx = Database.transaction(collection, data => {
                let trimmed = 0, empty = 0;
                if (!Array.isArray(data.transactions)) data.transactions = [];
                if (data.transactions.length > historyLimit) {
                    trimmed = data.transactions.length - historyLimit;
                    data.transactions = data.transactions.slice(-historyLimit);
                    data.ledgerIndex = {};
                    for (const entry of data.transactions) if (entry?.id) data.ledgerIndex[entry.id] = entry.createdAt || 0;
                }
                for (const [playerId, list] of Object.entries(data.payouts || {})) {
                    if (!Array.isArray(list)) { delete data.payouts[playerId]; empty++; continue; }
                    // Preserve every positive payout; schema validation already
                    // normalizes malformed/zero-value records.
                    if (!list.length) { delete data.payouts[playerId]; empty++; }
                }
                data.stats.lastUpdated = now();
                return { trimmed, empty };
            });
            if (tx.success) { trimmedTransactions += tx.result.trimmed || 0; removedEmptyPayoutLists += tx.result.empty || 0; }
        }
        return { trimmedTransactions, trimmedPayouts, removedEmptyPayoutLists, collections: collections.length };
    }

    static pruneContracts() {
        const collection = CONFIG.CONTRACTS.COLLECTION;
        Database.collection(collection, DEFAULT_CONTRACT_DB, { validate: validateContractData });
        const completedCutoff = cutoff(SC.CONTRACT_COMPLETED_RETENTION_DAYS, 14);
        const expiredCutoff = cutoff(SC.CONTRACT_EXPIRED_RETENTION_DAYS, 7);
        const tx = Database.transaction(collection, data => {
            let removed = 0;
            for (const [id, c] of Object.entries(data.contracts || {})) {
                if (!c) { delete data.contracts[id]; removed++; continue; }
                const t = c.updatedAt || c.createdAt || 0;
                const terminal = ["completed", "cancelled", "expired"].includes(c.status);
                if (!terminal) continue;
                if (c.status === "completed" && t < completedCutoff) { delete data.contracts[id]; removed++; }
                else if ((c.status === "cancelled" || c.status === "expired") && t < expiredCutoff) { delete data.contracts[id]; removed++; }
            }
            if (removed) rebuildContractIndexes(data);
            data.stats.lastUpdated = now();
            return { removed };
        });
        const baseResult = tx.success ? tx.result : { error: tx.error };
        let shardMailboxTrimmed = 0, shardMalformedMailboxes = 0;
        const maxMailbox = CONFIG.CONTRACTS.MAX_MAILBOX_PER_PLAYER || 200;
        for (const collectionName of this.#contractMailboxCollections()) {
            Database.collection(collectionName, DEFAULT_CONTRACT_MAILBOX_SHARD_DB, { validate: validateContractMailboxShardData });
            const sTx = Database.transaction(collectionName, data => {
                let trimmed = 0, malformed = 0;
                for (const [pid, list] of Object.entries(data.itemMailbox || {})) {
                    if (!Array.isArray(list)) { delete data.itemMailbox[pid]; malformed++; continue; }
                    const clean = list.filter(e => e && e.itemId && Math.floor(Number(e.amount) || 0) > 0); // preserve all contract mailbox value
                    trimmed += Math.max(0, list.length - clean.length);
                    if (clean.length) data.itemMailbox[pid] = clean; else delete data.itemMailbox[pid];
                }
                data.stats.totalPlayers = Object.keys(data.itemMailbox || {}).length;
                data.stats.totalEntries = Object.values(data.itemMailbox || {}).reduce((s,l)=>s+(Array.isArray(l)?l.length:0),0);
                data.stats.lastUpdated = now();
                return { trimmed, malformed };
            });
            if (sTx.success) { shardMailboxTrimmed += sTx.result.trimmed || 0; shardMalformedMailboxes += sTx.result.malformed || 0; }
        }
        return { ...baseResult, shardMailboxTrimmed, shardMalformedMailboxes, mailboxShardCollections: this.#contractMailboxCollections().length };
    }

    static pruneLand() {
        const collection = CONFIG.LAND.COLLECTION;
        Database.collection(collection, DEFAULT_LAND_DB, { validate: validateLandData });
        const batch = Math.max(50, Math.floor(Number(SC.LAND_ENTRY_PASS_PRUNE_BATCH) || 500));
        const tx = Database.transaction(collection, data => {
            let removedPasses = 0, removedPlayers = 0, scanned = 0;
            const t = now();
            for (const [pid, passes] of Object.entries(data.entryPasses || {})) {
                if (scanned >= batch) break;
                scanned++;
                if (!passes || typeof passes !== "object" || Array.isArray(passes)) { delete data.entryPasses[pid]; removedPlayers++; continue; }
                for (const [cid, expires] of Object.entries(passes || {})) if (!data.claims?.[cid] || Number(expires) <= t) { delete passes[cid]; removedPasses++; }
                if (Object.keys(passes || {}).length === 0) { delete data.entryPasses[pid]; removedPlayers++; }
            }
            data.stats.lastUpdated = now();
            return { removedPasses, removedPlayers, scanned };
        });
        const base = tx.success ? tx.result : { error: tx.error };
        const claimIds = new Set(Object.keys(Database.collection(collection, DEFAULT_LAND_DB, { validate: validateLandData }).claims || {}));
        const shard = LandShardService.pruneExpired(claimIds);
        return { ...base, shardRemovedPasses: shard.removedPasses || 0, shardRemovedPlayers: shard.removedPlayers || 0, entryPassShards: LandShardService.entryPassEnabled() ? LandShardService.allEntryPassShardNames().length : 0 };
    }

    static pruneMarket() {
        const collection = CONFIG.MARKET.COLLECTION;
        Database.collection(collection, DEFAULT_MARKET_DB, { validate: validateMarketData });
        const closedCutoff = cutoff(SC.MARKET_CLOSED_ORDER_RETENTION_DAYS, 7);
        const hasReserve = (o) => Math.max(0, Math.floor(Number(o?.reservedMoney) || 0)) > 0 || Math.max(0, Math.floor(Number(o?.reservedItems) || 0)) > 0;
        const tx = Database.transaction(collection, data => {
            let removedOrders = 0, removedPlayerOrderEntries = 0, protectedReservedOrders = 0, malformedPlayerOrders = 0;
            for (const [oid, order] of Object.entries(data.orders || {})) {
                // data.orders is usually itemId -> {bids, asks}. Closed orders
                // must not remain in active books because the match engine does
                // not match by status; authoritative reserve evidence is kept in
                // playerOrders below when needed.
                if (order?.bids || order?.asks) {
                    for (const side of ["bids", "asks"]) {
                        const arr = Array.isArray(order[side]) ? order[side] : [];
                        const clean = arr.filter(o => o && o.status === "open");
                        removedOrders += arr.length - clean.length;
                        order[side] = clean;
                    }
                } else if (order && order.status && order.status !== "open" && (order.updatedAt || order.createdAt || 0) < closedCutoff) {
                    if (hasReserve(order)) { protectedReservedOrders++; continue; }
                    delete data.orders[oid]; removedOrders++;
                }
            }
            for (const [pid, orders] of Object.entries(data.playerOrders || {})) {
                if (!orders || typeof orders !== "object" || Array.isArray(orders)) { delete data.playerOrders[pid]; malformedPlayerOrders++; continue; }
                for (const [oid, o] of Object.entries(orders)) {
                    if (!o) { delete orders[oid]; removedPlayerOrderEntries++; continue; }
                    if (o.status !== "open" && (o.updatedAt || o.createdAt || 0) < closedCutoff) {
                        if (hasReserve(o)) { protectedReservedOrders++; continue; }
                        delete orders[oid]; removedPlayerOrderEntries++;
                    }
                }
                if (Object.keys(orders).length === 0) delete data.playerOrders[pid];
            }
            data.stats.lastUpdated = now();
            return { removedOrders, removedPlayerOrderEntries, protectedReservedOrders, malformedPlayerOrders };
        });
        const baseResult = tx.success ? tx.result : { error: tx.error };
        let shardRemovedPlayerOrderEntries = 0, shardMailboxTrimmed = 0, shardMalformedPlayerOrders = 0;
        const maxMailbox = CONFIG.MARKET.MAILBOX.MAX_ENTRIES_PER_PLAYER || 50;
        for (const collectionName of this.#marketPlayerCollections()) {
            Database.collection(collectionName, DEFAULT_MARKET_PLAYERS_SHARD_DB, { validate: validateMarketPlayersShardData });
            const sTx = Database.transaction(collectionName, data => {
                let po = 0, mb = 0, malformed = 0;
                for (const [pid, orders] of Object.entries(data.playerOrders || {})) {
                    if (!orders || typeof orders !== "object" || Array.isArray(orders)) { delete data.playerOrders[pid]; malformed++; continue; }
                    for (const [oid, o] of Object.entries(orders)) {
                        if (!o) { delete orders[oid]; po++; continue; }
                        if (o.status !== "open" && (o.updatedAt || o.createdAt || 0) < closedCutoff && !hasReserve(o)) { delete orders[oid]; po++; }
                    }
                    if (Object.keys(orders).length === 0) delete data.playerOrders[pid];
                }
                for (const [pid, list] of Object.entries(data.mailbox || {})) {
                    if (!Array.isArray(list)) { delete data.mailbox[pid]; mb++; continue; }
                    const clean = list.filter(e => e && Math.floor(Number(e.amount) || 0) > 0); // preserve all economic mailbox obligations
                    mb += Math.max(0, list.length - clean.length);
                    if (clean.length) data.mailbox[pid] = clean; else delete data.mailbox[pid];
                }
                data.stats.totalPlayers = new Set([...Object.keys(data.playerOrders || {}), ...Object.keys(data.mailbox || {}), ...Object.keys(data.playerLimits || {})]).size;
                data.stats.totalMailboxEntries = Object.values(data.mailbox || {}).reduce((s, l) => s + (Array.isArray(l) ? l.length : 0), 0);
                data.stats.totalPlayerOrders = Object.values(data.playerOrders || {}).reduce((s, o) => s + (o && typeof o === "object" ? Object.keys(o).length : 0), 0);
                data.stats.lastUpdated = now();
                return { po, mb, malformed };
            });
            if (sTx.success) { shardRemovedPlayerOrderEntries += sTx.result.po || 0; shardMailboxTrimmed += sTx.result.mb || 0; shardMalformedPlayerOrders += sTx.result.malformed || 0; }
        }
        let orderShardClosedRemoved = 0;
        for (const collectionName of this.#marketOrderCollections()) {
            Database.collection(collectionName, DEFAULT_MARKET_ORDERS_SHARD_DB, { validate: validateMarketOrdersShardData });
            const oTx = Database.transaction(collectionName, data => {
                let removed = 0;
                for (const [itemId, book] of Object.entries(data.orderBooks || {})) {
                    for (const side of ["bids", "asks"]) {
                        const arr = Array.isArray(book?.[side]) ? book[side] : [];
                        const clean = arr.filter(o => o && o.status === "open");
                        removed += arr.length - clean.length;
                        if (book) book[side] = clean;
                    }
                    if ((!book?.bids || !book.bids.length) && (!book?.asks || !book.asks.length)) delete data.orderBooks[itemId];
                }
                data.stats.totalItems = Object.keys(data.orderBooks || {}).length;
                data.stats.totalOpenBids = Object.values(data.orderBooks || {}).reduce((s,b)=>s+(Array.isArray(b.bids)?b.bids.length:0),0);
                data.stats.totalOpenAsks = Object.values(data.orderBooks || {}).reduce((s,b)=>s+(Array.isArray(b.asks)?b.asks.length:0),0);
                data.stats.lastUpdated = now();
                return removed;
            });
            if (oTx.success) orderShardClosedRemoved += oTx.result || 0;
        }
        return { ...baseResult, shardRemovedPlayerOrderEntries, shardMailboxTrimmed, shardMalformedPlayerOrders, orderShardClosedRemoved, playerShardCollections: this.#marketPlayerCollections().length, orderShardCollections: this.#marketOrderCollections().length };
    }

    static pruneFinancialJournals() {
        Database.collection("financial_journals", DEFAULT_FINANCIAL_JOURNAL_DB, { validate: validateFinancialJournalData });
        const terminalCutoff = cutoff(30, 30);
        const tx = Database.transaction("financial_journals", data => {
            let removed = 0;
            const keepOrder = [];
            for (const id of data.order || []) {
                const journal = data.journals[id];
                if (!journal) { removed++; continue; }
                const safelyBridgedTerminal = !!journal.bridgedAt && !!journal.operationId && ["completed", "cancelled"].includes(journal.status);
                if (safelyBridgedTerminal && (journal.updatedAt || journal.createdAt || 0) < terminalCutoff) {
                    delete data.journals[id]; removed++; continue;
                }
                // Active, failed and unbridged legacy journals are never
                // removed by a cap or age-only policy.
                keepOrder.push(id);
            }
            data.order = keepOrder;
            data.stats.lastUpdated = now();
            return { legacyRemoved: removed };
        });
        const operations = OperationJournalService.pruneTerminal();
        return tx.success ? { ...tx.result, operations } : { error: tx.error, operations };
    }

    static largeCollectionReport() {
        const threshold = Math.max(100000, Math.floor(Number(SC.LARGE_COLLECTION_WARNING_BYTES) || 750000));
        const out = [];
        for (const name of Database.listCollections()) {
            const st = Database.stats(name);
            if (st && st.size >= threshold) out.push({ name, size: st.size, itemCount: st.itemCount, dirty: st.dirty });
        }
        return out.sort((a, b) => b.size - a.size);
    }
}

export default ScalabilityService;
