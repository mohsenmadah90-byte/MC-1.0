// MCity Dashboard V2 - Canonical Finance Ledger
// Phase 3.3: idempotent base ledger with legacy shard aggregation/migration.

import { CONFIG } from "../../config.js";
import { Database } from "../../core/database.js";
import { BatchTaskService } from "../../core/batchTaskService.js";
import { ShardUtils } from "../../core/shardUtils.js";
import { Logger } from "../../core/logger.js";
import { DEFAULT_FINANCE_DB, validateFinanceData } from "../../schemas/financeSchema.js";

const COLLECTION = CONFIG.FINANCE.COLLECTION;
function now() { return Date.now(); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function safeAmount(value) { return Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(Number(value) || 0))); }
function safeText(value, max = 120) { return String(value || "").replace(/[\u0000-\u001f\u007f]/g, "").substring(0, max); }

export class FinanceLedgerService {
    static #initialized = false;
    static #legacyCollections = [];

    static initialize(legacyCollections = []) {
        this.#legacyCollections = [...new Set((legacyCollections || []).filter(name => name && name !== COLLECTION))];
        if (this.#initialized) return;
        this.#initialized = true;
        const base = this.db();
        BatchTaskService.register("finance_ledger_migration", {
            process: task => this.#processLegacyMigration(task)
        });
        const started = base.ledgerMeta?.legacyMigrationComplete
            ? { started: false, message: "complete" }
            : BatchTaskService.start("finance_ledger_migration", {
                collections: this.#legacyCollections,
                batchSize: Math.max(1, Math.min(200, Math.floor(Number(CONFIG.FINANCE.LEDGER_MIGRATION_BATCH_SIZE) || 50)))
            }, { dedupeKey: "finance_ledger_migration_v3" });
        Logger.startup("FinanceLedger", `Canonical ledger initialized (${this.#legacyCollections.length} legacy shard source(s), migration ${started.started ? "queued" : started.message || "known"})`);
    }

    static shutdown() { this.#initialized = false; this.#legacyCollections = []; }

    static db() { return Database.collection(COLLECTION, DEFAULT_FINANCE_DB, { validate: validateFinanceData }); }

    static recordInData(data, entry, options = {}) {
        if (!data || typeof data !== "object") throw new Error("Ledger destination data is required");
        const id = safeText(entry?.id, 120);
        if (!id) throw new Error("Canonical ledger entry requires a deterministic id");
        if (!data.ledgerIndex || typeof data.ledgerIndex !== "object") data.ledgerIndex = {};
        if (data.ledgerIndex[id] !== undefined || (data.transactions || []).some(item => item?.id === id)) {
            const existing = (data.transactions || []).find(item => item?.id === id) || null;
            return { alreadyApplied: true, entry: existing };
        }
        const amount = safeAmount(entry.amount);
        const record = {
            ...clone(entry),
            id,
            type: safeText(entry.type || "tx", 64),
            amount,
            source: safeText(entry.source || "", 64),
            bucket: safeText(entry.bucket || "", 64),
            reason: safeText(entry.reason || "", 160),
            createdAt: Math.max(0, Number(entry.createdAt) || now())
        };
        if (!Array.isArray(data.transactions)) data.transactions = [];
        data.transactions.push(record);
        data.ledgerIndex[id] = record.createdAt;
        if (!data.ledgerMeta || typeof data.ledgerMeta !== "object") data.ledgerMeta = {};
        data.ledgerMeta.canonical = true;
        data.ledgerMeta.canonicalSince = data.ledgerMeta.canonicalSince || now();
        if (!data.stats || typeof data.stats !== "object") data.stats = {};
        if (options.countStats !== false) {
            data.stats.totalTransactions = (data.stats.totalTransactions || 0) + 1;
            if (record.type === "payout_pending") {
                data.stats.totalPayoutsCreated = (data.stats.totalPayoutsCreated || 0) + Math.max(1, Math.floor(Number(record.count) || 1));
                data.stats.totalPayoutAmountCreated = (data.stats.totalPayoutAmountCreated || 0) + amount;
            } else if (record.type === "payout_claim") {
                data.stats.totalPayoutsClaimed = (data.stats.totalPayoutsClaimed || 0) + Math.max(1, Math.floor(Number(record.count) || 1));
                data.stats.totalPayoutAmountClaimed = (data.stats.totalPayoutAmountClaimed || 0) + amount;
            }
        }
        data.stats.lastUpdated = now();
        this.#compactHistoryInData(data);
        return { alreadyApplied: false, entry: record };
    }

    static record(entry, options = {}) {
        this.db();
        const tx = Database.transaction(COLLECTION, data => this.recordInData(data, entry, options));
        if (!tx.success) return { success: false, error: tx.error };
        const flush = options.flush === false ? { ok: true } : Database.flushCritical(COLLECTION, options.reason || "finance_ledger_record");
        return { success: flush.ok, ...tx.result, error: flush.ok ? "" : "Canonical ledger flush failed" };
    }

    static recentTransactions(limit = 20, filter = null, legacyCollections = this.#legacyCollections) {
        const max = Math.max(1, Math.min(200, Math.floor(Number(limit) || 20)));
        const filterLower = filter ? String(filter).toLowerCase() : "";
        const byId = new Map();
        const collections = [COLLECTION, ...new Set(legacyCollections || [])];
        for (const name of collections) {
            const db = Database.collection(name, DEFAULT_FINANCE_DB, { validate: validateFinanceData });
            for (const entry of db.transactions || []) {
                if (!entry?.id) continue;
                if (filterLower) {
                    const match = String(entry.type || "").toLowerCase().includes(filterLower)
                        || String(entry.source || "").toLowerCase().includes(filterLower)
                        || String(entry.bucket || "").toLowerCase().includes(filterLower);
                    if (!match) continue;
                }
                const existing = byId.get(entry.id);
                if (!existing || (entry.createdAt || 0) > (existing.createdAt || 0)) byId.set(entry.id, entry);
            }
        }
        return [...byId.values()].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0) || String(b.id).localeCompare(String(a.id))).slice(0, max).map(clone);
    }

    static aggregateStats(legacyCollections = this.#legacyCollections) {
        const base = this.db();
        const result = { ...clone(base.stats || {}) };
        const additive = ["totalTransactions", "totalPayoutsCreated", "totalPayoutsClaimed", "totalPayoutAmountCreated", "totalPayoutAmountClaimed"];
        const legacy = {};
        for (const key of additive) legacy[key] = 0;
        for (const name of new Set(legacyCollections || [])) {
            if (!name || name === COLLECTION) continue;
            const shard = Database.collection(name, DEFAULT_FINANCE_DB, { validate: validateFinanceData });
            for (const key of additive) legacy[key] += safeAmount(shard.stats?.[key]);
        }
        for (const key of additive) result[key] = safeAmount(result[key]) + legacy[key];
        result.lastUpdated = Math.max(Number(result.lastUpdated) || 0, ...[...new Set(legacyCollections || [])].map(name => Number(Database.collection(name, DEFAULT_FINANCE_DB, { validate: validateFinanceData }).stats?.lastUpdated) || 0));
        return { stats: result, baseStats: clone(base.stats || {}), legacyShardStats: legacy, ledgerMeta: clone(base.ledgerMeta || {}) };
    }

    static migrationStatus() {
        const base = this.db();
        return clone(base.ledgerMeta || {});
    }

    static #compactHistoryInData(data) {
        const limit = Math.max(100, Math.min(10_000, Math.floor(Number(CONFIG.FINANCE.MAX_LEDGER_HISTORY) || 1500)));
        if (data.transactions.length <= Math.floor(limit * 1.2)) return;
        data.transactions = data.transactions.slice(-limit);
        data.ledgerIndex = {};
        for (const entry of data.transactions) if (entry?.id) data.ledgerIndex[entry.id] = entry.createdAt || 0;
    }

    static #processLegacyMigration(task) {
        const collections = Array.isArray(task.payload?.collections) ? task.payload.collections : [];
        // Dynamic-property serialization dominates this migration's wall time. Keep
        // each durable batch deliberately small so a growing canonical ledger
        // cannot monopolize a server tick. The cap also applies to already
        // persisted tasks created with the previous larger payload.
        const batchSize = Math.max(1, Math.min(5, Math.floor(Number(task.payload?.batchSize) || 5)));
        let collectionIndex = Math.max(0, Math.floor(Number(task.cursor?.collectionIndex) || 0));
        let offset = Math.max(0, Math.floor(Number(task.cursor?.offset) || 0));
        while (collectionIndex < collections.length && collections[collectionIndex] === COLLECTION) { collectionIndex++; offset = 0; }
        if (collectionIndex >= collections.length) {
            const tx = Database.transaction(COLLECTION, data => {
                data.ledgerMeta.legacyMigrationComplete = true;
                data.ledgerMeta.lastMigrationAt = now();
            });
            if (!tx.success) return { error: tx.error };
            return { done: true, cursor: { collectionIndex, offset: 0 }, progress: { collectionsCompleted: collections.length, totalCollections: collections.length }, flushCollections: [COLLECTION] };
        }
        const sourceName = collections[collectionIndex];
        const source = Database.collection(sourceName, DEFAULT_FINANCE_DB, { validate: validateFinanceData });
        const entries = Array.isArray(source.transactions) ? source.transactions : [];
        const batch = entries.slice(offset, offset + batchSize);
        const sourceAmount = batch.reduce((sum, entry) => sum + safeAmount(entry?.amount), 0);
        const batchChecksumValue = batch.reduce((sum, entry) => (sum + ShardUtils.fnv1a(`${sourceName}:${entry?.id || ""}:${safeAmount(entry?.amount)}`)) >>> 0, 0);
        const nextOffset = offset + batch.length;
        const sourceDone = nextOffset >= entries.length;
        const finalBatch = sourceDone && collectionIndex + 1 >= collections.length;
        const batchKey = `${sourceName}:${offset}:${batch.length}`;
        const tx = Database.transaction(COLLECTION, data => {
            if (!data.ledgerMeta.migrationBatches || typeof data.ledgerMeta.migrationBatches !== "object") data.ledgerMeta.migrationBatches = {};
            if (data.ledgerMeta.migrationBatches[batchKey]) return { imported: 0, counted: false };
            let imported = 0;
            for (const entry of batch) {
                if (!entry?.id) continue;
                const result = this.recordInData(data, { ...entry, legacySourceCollection: sourceName }, { countStats: false });
                if (!result.alreadyApplied) imported++;
            }
            data.ledgerMeta.legacyImported = (data.ledgerMeta.legacyImported || 0) + imported;
            data.ledgerMeta.legacySourceCount = (data.ledgerMeta.legacySourceCount || 0) + batch.length;
            data.ledgerMeta.legacySourceAmount = (data.ledgerMeta.legacySourceAmount || 0) + sourceAmount;
            data.ledgerMeta.legacyChecksumValue = ((data.ledgerMeta.legacyChecksumValue || 0) + batchChecksumValue) >>> 0;
            data.ledgerMeta.legacySourceChecksum = `fnv1a-sum:${data.ledgerMeta.legacyChecksumValue.toString(16).padStart(8, "0")}`;
            data.ledgerMeta.lastMigrationAt = now();
            data.ledgerMeta.migrationBatches[batchKey] = { source: sourceName, offset, count: batch.length, amount: sourceAmount, checksumValue: batchChecksumValue, at: now() };
            if (finalBatch) data.ledgerMeta.legacyMigrationComplete = true;
            return { imported, counted: true };
        });
        if (!tx.success) return { error: tx.error };
        if (sourceDone) { collectionIndex++; offset = 0; } else offset = nextOffset;
        return {
            done: collectionIndex >= collections.length,
            cursor: { collectionIndex, offset },
            progress: { collectionsCompleted: collectionIndex, totalCollections: collections.length, source: sourceName, sourceOffset: nextOffset },
            resultPatch: {
                imported: (task.result?.imported || 0) + (tx.result?.imported || 0),
                sourceCount: (task.result?.sourceCount || 0) + (tx.result?.counted ? batch.length : 0),
                sourceAmount: (task.result?.sourceAmount || 0) + (tx.result?.counted ? sourceAmount : 0),
                checksumValue: (((task.result?.checksumValue || 0) + (tx.result?.counted ? batchChecksumValue : 0)) >>> 0),
                sourceChecksum: `fnv1a-sum:${(((task.result?.checksumValue || 0) + (tx.result?.counted ? batchChecksumValue : 0)) >>> 0).toString(16).padStart(8, "0")}`
            },
            flushCollections: [COLLECTION]
        };
    }
}

export default FinanceLedgerService;
