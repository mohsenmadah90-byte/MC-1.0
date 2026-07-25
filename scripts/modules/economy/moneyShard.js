// MCity Dashboard V2 - Locked Money Shard Router
// Phase 3.1: one Math.imul FNV-1a implementation and persisted routing metadata.

import { CONFIG } from "../config.js";
import { Database } from "./database.js";
import { Logger } from "./logger.js";
import { ShardUtils } from "./shardUtils.js";
import { DEFAULT_MONEY_DB, validateMoneyData } from "../schemas/moneySchema.js";
import { DisposableRegistry } from "./disposableRegistry.js";

export class MoneyShard {
    static BASE_COLLECTION = "money";
    static #shardCount = 16;
    static #enabled = true;
    static #activeBase = "money";
    static #algorithm = ShardUtils.HASH_ALGORITHM;
    static #locked = false;
    static #initialized = false;
    static #lastMigration = null;

    static getShardCount() { return this.#shardCount; }
    static isEnabled() { return this.#enabled; }
    static getActiveBase() { return this.#activeBase; }
    static getAlgorithm() { return this.#algorithm; }

    static initialize() {
        if (this.#initialized) return this.status();
        this.#initialized = true;
        DisposableRegistry.registerShutdownCleanup("MoneyShard.lifecycle", () => {
            this.#initialized = false;
            this.#locked = false;
            this.#lastMigration = null;
        });

        const desired = ShardUtils.clampCount(CONFIG.DATABASE?.SHARDING?.MODULES?.MONEY?.SHARD_COUNT || 16, 16);
        const base = Database.collection(this.BASE_COLLECTION, DEFAULT_MONEY_DB, { validate: validateMoneyData });
        const meta = base.shardMeta || {};
        if (meta.locked && meta.algorithm === ShardUtils.HASH_ALGORITHM) {
            this.#applyMeta(meta, desired);
            Logger.startup("MoneyShard", `Locked routing loaded: ${this.#activeBase}, ${this.#shardCount} shards, ${this.#algorithm}`);
            return this.status();
        }

        const legacy = this.#detectLegacy(desired, base);
        if (legacy.totalPlayers > 0 || (meta.enabled && meta.algorithm && meta.algorithm !== ShardUtils.HASH_ALGORITHM)) {
            const migration = this.#migrateLegacyToStandard(desired, legacy);
            this.#lastMigration = migration;
            if (!migration.success) throw new Error(`Money shard hash migration failed: ${migration.error}`);
            this.#activeBase = migration.activeBase;
            this.#shardCount = desired;
            this.#enabled = desired > 1;
            this.#algorithm = ShardUtils.HASH_ALGORITHM;
            this.#locked = true;
            Logger.startup("MoneyShard", `Rehashed ${migration.migratedPlayers} player(s) to ${this.#activeBase} using ${this.#algorithm}`);
            return this.status();
        }

        // Fresh world: lock standard routing before the first player record.
        const tx = Database.transaction(this.BASE_COLLECTION, data => {
            data.shardMeta = {
                enabled: desired > 1, shardCount: desired, algorithm: ShardUtils.HASH_ALGORITHM,
                activeBase: this.BASE_COLLECTION, locked: true, migratedAt: Date.now(), sourceAlgorithm: "fresh"
            };
            data.stats.lastUpdated = Date.now();
        });
        if (!tx.success || !Database.flushCritical(this.BASE_COLLECTION, "money_shard_lock").ok) throw new Error(tx.error || "Failed to persist money shard lock");
        this.#applyMeta(Database.collection(this.BASE_COLLECTION).shardMeta, desired);
        Logger.startup("MoneyShard", `Fresh routing locked: ${desired} shards, ${this.#algorithm}`);
        return this.status();
    }

    static #applyMeta(meta, desired) {
        this.#shardCount = ShardUtils.clampCount(meta.shardCount || desired, desired);
        this.#enabled = meta.enabled !== false && this.#shardCount > 1;
        this.#activeBase = String(meta.activeBase || this.BASE_COLLECTION);
        this.#algorithm = String(meta.algorithm || ShardUtils.HASH_ALGORITHM);
        this.#locked = !!meta.locked;
        if (this.#shardCount !== desired) Logger.warn("MoneyShard", `Configured shard count ${desired} ignored; persisted locked count is ${this.#shardCount}`);
    }

    static #detectLegacy(count, base) {
        const sources = [];
        const basePlayers = Object.keys(base.players || {}).length;
        if (basePlayers || Object.keys(base.appliedJournals || {}).length) sources.push({ name: this.BASE_COLLECTION, data: base });
        for (let i = 0; i < count; i++) {
            const name = `${this.BASE_COLLECTION}_shard_${i}`;
            if (!Database.hasCollection(name) && !Database.hasPersistedStorage(name)) continue;
            const data = Database.collection(name, DEFAULT_MONEY_DB, { validate: validateMoneyData });
            if (Object.keys(data.players || {}).length || Object.keys(data.appliedJournals || {}).length) sources.push({ name, data });
        }
        return { sources, totalPlayers: sources.reduce((sum, source) => sum + Object.keys(source.data.players || {}).length, 0) };
    }

    static #migrateLegacyToStandard(count, legacy) {
        const activeBase = "money_v2";
        const buckets = Array.from({ length: count }, () => ({ players: {}, appliedJournals: {} }));
        const uniquePlayers = new Set();
        for (const source of legacy.sources) {
            const destinationIndexes = new Set();
            for (const [playerId, record] of Object.entries(source.data.players || {})) {
                const index = ShardUtils.hashIndex(playerId, count);
                buckets[index].players[playerId] = record;
                destinationIndexes.add(index);
                uniquePlayers.add(playerId);
            }
            // Preserve recovery markers in every destination fed by this source.
            for (const index of destinationIndexes) Object.assign(buckets[index].appliedJournals, source.data.appliedJournals || {});
        }

        const written = [];
        for (let i = 0; i < count; i++) {
            if (!Object.keys(buckets[i].players).length && !Object.keys(buckets[i].appliedJournals).length) continue;
            const name = `${activeBase}_shard_${i}`;
            Database.collection(name, DEFAULT_MONEY_DB, { validate: validateMoneyData });
            const tx = Database.transaction(name, data => {
                data.players = { ...(data.players || {}), ...buckets[i].players };
                data.appliedJournals = { ...(data.appliedJournals || {}), ...buckets[i].appliedJournals };
                data.stats.totalKnownPlayers = Object.keys(data.players).length;
                data.stats.lastUpdated = Date.now();
            });
            if (!tx.success || !Database.flushCritical(name, "money_hash_migration_target").ok) return { success: false, error: tx.error || `Failed to flush ${name}`, written };
            written.push(name);
        }

        let verified = 0;
        for (const name of written) verified += Object.keys(Database.collection(name).players || {}).length;
        if (verified < uniquePlayers.size) return { success: false, error: `Verification count ${verified} < ${uniquePlayers.size}`, written };

        const baseTx = Database.transaction(this.BASE_COLLECTION, data => {
            data.players = {};
            data.shardMeta = {
                enabled: count > 1, shardCount: count, algorithm: ShardUtils.HASH_ALGORITHM,
                activeBase, locked: true, migratedAt: Date.now(), sourceAlgorithm: ShardUtils.LEGACY_HASH_ALGORITHM
            };
            data.stats.totalKnownPlayers = 0;
            data.stats.lastUpdated = Date.now();
        });
        if (!baseTx.success || !Database.flushCritical(this.BASE_COLLECTION, "money_hash_migration_commit").ok) return { success: false, error: baseTx.error || "Failed to commit routing metadata", written };
        return { success: true, activeBase, migratedPlayers: uniquePlayers.size, written, verified };
    }

    static refreshRouting() {
        const base = Database.collection(this.BASE_COLLECTION, DEFAULT_MONEY_DB, { validate: validateMoneyData });
        const meta = base.shardMeta || {};
        if (!meta.locked || meta.algorithm !== ShardUtils.HASH_ALGORITHM) {
            Logger.error("MoneyShard", "Restored money shard metadata is not locked to the supported hash algorithm.");
            return false;
        }
        this.#applyMeta(meta, this.#shardCount);
        return true;
    }

    static enable(n = 16) {
        n = ShardUtils.clampCount(n, 16);
        if (this.#locked && n !== this.#shardCount) {
            Logger.error("MoneyShard", `Cannot change locked shard count ${this.#shardCount} to ${n} without migration.`);
            return false;
        }
        this.#shardCount = n; this.#enabled = n > 1;
        return true;
    }

    static disable() {
        if (this.#locked) { Logger.error("MoneyShard", "Cannot disable locked money sharding without consolidation migration."); return false; }
        this.#enabled = false;
        return true;
    }

    static shardIndex(playerId) { return playerId ? ShardUtils.hashIndex(playerId, this.#shardCount) : 0; }
    static collectionFor(playerId) {
        if (!this.#enabled || this.#shardCount === 1) return this.#activeBase;
        return `${this.#activeBase}_shard_${this.shardIndex(playerId)}`;
    }
    static allCollections() {
        if (!this.#enabled || this.#shardCount === 1) return [this.BASE_COLLECTION, this.#activeBase].filter((v, i, a) => a.indexOf(v) === i);
        return [this.BASE_COLLECTION, ...ShardUtils.allHashShardNames(this.#activeBase, this.#shardCount)];
    }
    static migrate() { return this.initialize(); }
    static status() {
        return { initialized: this.#initialized, enabled: this.#enabled, shardCount: this.#shardCount, algorithm: this.#algorithm, activeBase: this.#activeBase, locked: this.#locked, lastMigration: this.#lastMigration };
    }
    static aggregateStats() {
        const out = { totalPlayers: 0, shards: [], ...this.status() };
        for (const name of this.allCollections()) {
            if (name === this.BASE_COLLECTION) continue;
            const db = Database.collection(name, DEFAULT_MONEY_DB, { validate: validateMoneyData });
            const players = Object.keys(db.players || {}).length;
            out.totalPlayers += players;
            out.shards.push({ name, players, size: Database.stats(name)?.size || 0 });
        }
        return out;
    }
}

export default MoneyShard;
