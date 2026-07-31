// MCity Dashboard V2 - Shard Migration Service
// v1.9.0: migration journal framework for future module sharding migrations.

import { CONFIG } from "../config.js";
import { Database } from "./database.js";
import { Logger } from "./logger.js";
import { ShardRegistry } from "./shardRegistry.js";
import { DEFAULT_SHARD_MIGRATION_DB, validateShardMigrationData } from "../schemas/shardMigrationSchema.js";
import { DisposableRegistry } from "./disposableRegistry.js";

const COLLECTION = CONFIG.DATABASE?.SHARDING?.MIGRATION_COLLECTION || "shard_migrations";
function now() { return Date.now(); }
function migrationId(name) { return `${String(name || "migration").replace(/[^a-z0-9_]/gi, "_").substring(0, 40)}_${Date.now()}_${Math.floor(Math.random() * 1000000)}`; }

export class ShardMigrationService {
    static #initialized = false;

    static initialize() {
        if (this.#initialized) return;
        this.#initialized = true;
        this.db();
        DisposableRegistry.registerShutdownCleanup("ShardMigrationService.lifecycle", () => { this.#initialized = false; });
        Logger.startup("ShardMigration", `Initialized (${ShardRegistry.enabledDefinitions().length} enabled shard domain(s))`);
    }

    static db() { return Database.collection(COLLECTION, DEFAULT_SHARD_MIGRATION_DB, { validate: validateShardMigrationData }); }
    static collectionName() { return COLLECTION; }

    static begin({ name, module, sourceCollection = "", targetCollections = [], shardType = "", shardCount = 1, meta = {} } = {}) {
        const id = migrationId(name || module || "shard");
        const rec = {
            id,
            name: name || id,
            module: module || "unknown",
            status: "planned",
            sourceCollection,
            targetCollections,
            shardType,
            shardCount,
            counts: {},
            checksum: "",
            startedAt: now(),
            updatedAt: now(),
            completedAt: 0,
            error: "",
            meta
        };
        const tx = Database.transaction(COLLECTION, data => {
            data.migrations[id] = rec;
            data.order = (data.order || []).filter(x => x !== id);
            data.order.push(id);
            data.stats.totalStarted = (data.stats.totalStarted || 0) + 1;
            data.stats.lastUpdated = now();
            return rec;
        });
        return tx.success ? tx.result : null;
    }

    static update(id, updates = {}) {
        const tx = Database.transaction(COLLECTION, data => {
            const m = data.migrations[id];
            if (!m) throw new Error("Migration not found");
            Object.assign(m, updates, { updatedAt: now() });
            data.stats.lastUpdated = now();
            return m;
        });
        return tx.success ? tx.result : null;
    }

    static startCopy(id, meta = {}) { return this.update(id, { status: "copying", ...meta }); }
    static markVerifying(id, counts = {}) { return this.update(id, { status: "verifying", counts }); }
    static markSwitched(id, counts = {}, checksum = "") { return this.complete(id, counts, checksum); }
    static retire(id, meta = {}) { return this.update(id, { status: "retired", completedAt: now(), ...meta }); }
    static rollback(id, reason = "rollback") { return this.update(id, { status: "rolled_back", error: String(reason).substring(0,300), completedAt: now() }); }
    static complete(id, counts = {}, checksum = "") {
        const tx = Database.transaction(COLLECTION, data => {
            const m = data.migrations[id];
            if (!m) throw new Error("Migration not found");
            m.status = "switched";
            m.counts = counts;
            m.checksum = checksum;
            m.completedAt = now();
            m.updatedAt = now();
            data.stats.totalCompleted = (data.stats.totalCompleted || 0) + 1;
            data.stats.lastUpdated = now();
            return m;
        });
        return tx.success ? tx.result : null;
    }

    static fail(id, error) {
        const tx = Database.transaction(COLLECTION, data => {
            const m = data.migrations[id];
            if (!m) throw new Error("Migration not found");
            m.status = "failed";
            m.error = String(error?.message || error || "unknown").substring(0, 300);
            m.updatedAt = now();
            data.stats.totalFailed = (data.stats.totalFailed || 0) + 1;
            data.stats.lastUpdated = now();
            return m;
        });
        return tx.success ? tx.result : null;
    }

    static list(limit = 50) {
        const db = this.db();
        return (db.order || []).map(id => db.migrations[id]).filter(Boolean).slice(-Math.max(1, Math.min(200, limit))).reverse();
    }

    static active() { return this.list(200).filter(m => !["committed", "failed", "rolled_back"].includes(m.status)); }
    static stats() {
        const db = this.db();
        return {
            collection: COLLECTION,
            stats: db.stats,
            active: this.active().length,
            total: Object.keys(db.migrations || {}).length,
            registry: ShardRegistry.status()
        };
    }
}

export default ShardMigrationService;
