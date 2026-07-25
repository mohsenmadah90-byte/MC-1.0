// MCity Dashboard V2 - Central Dynamic Property Database
// Phase 1: Database Core & Chunking Hardening
// Phase 5 Polish: Integrated schema migrations on load.
// Phase 6 (v1.5.6): Reset validation and pending collection metadata.
// Hotfix 2 (v1.6.2): Crash-atomic double-buffer dynamic property writes.
// Patch 4 (v1.6.8): Storage maintenance verification/compact/cleanup tools.

import { world } from "@minecraft/server";
import { CONFIG } from "../config.js";
import { Logger } from "./logger.js";
import { Migrations } from "./migrations.js";
import { RuntimeHandleRegistry } from "./runtimeHandleRegistry.js";
import { ShardUtils } from "./shardUtils.js";

export class Database {
    static #collections = new Map();
    static #prefix = CONFIG.DATABASE.PREFIX || "mcity2:";
    static #initialized = false;
    static #intervals = new Set();
    static #proxyTargets = new WeakMap();
    static #config = { ...CONFIG.DATABASE };
    static #isSaving = false;
    // Phase 2.1: synchronous transaction ownership and observability.
    static #transactionStack = [];
    static #transactionMetrics = {
        attempted: 0,
        committed: 0,
        noChange: 0,
        rolledBack: 0,
        rejectedAsync: 0,
        rejectedGenerator: 0,
        rejectedNested: 0,
        directMutations: 0
    };
    // Phase 2.2: coalescing background save queue.
    static #saveQueue = new Map();
    static #saveWorkerId = null;
    static #saveQueueMetrics = {
        requested: 0,
        coalesced: 0,
        completed: 0,
        failed: 0,
        skipped: 0,
        maxDepth: 0,
        lastDrainAt: 0
    };
    static #readDiagnostics = new Map();
    static #migrationDiagnostics = new Map();
    static #crcTable = null;
    // Phase 2.5 generation catalog and maintenance gate.
    static #catalog = null;
    static #catalogStatus = "uninitialized";
    static #runtimeMode = "NORMAL";
    static #internalWriteDepth = 0;
    static #refreshHandlers = new Map();
    /** Phase 3 Scalability: Priority map for save ordering. Lower number = higher priority. */
    static #savePriority = new Map([
        ["money", 0],
        ["land", 1],
        ["market", 2],
        ["players", 3],
        ["finance", 4]
    ]);

    constructor() { throw new Error("Database is static only."); }

    /**
     * Phase 3 Scalability: Generic shard helper for any collection.
     * Returns the shard collection name for a given key and shard count.
     * Uses FNV-1a hash for even distribution.
     */
    static shardName(baseCollection, key, shardCount = 16) {
        return ShardUtils.hashShardName(baseCollection, key, shardCount);
    }

    /**
     * Phase 3 Scalability: Set save priority for a collection.
     * Collections with lower priority numbers are saved first.
     */
    static setSavePriority(collectionName, priority) {
        this.#savePriority.set(collectionName, priority);
    }

    static #catalogKey() { return `${this.#prefix}__generation_catalog`; }
    static #generationKey(generation, name) { return `${this.#prefix}__gen:${generation}:${name}`; }
    static #newCatalog() {
        const now = Date.now();
        return {
            formatVersion: 1,
            activeGeneration: "g0",
            previousGeneration: "",
            generations: { g0: { id: "g0", status: "active", createdAt: now, committedAt: now, collections: {} } },
            maintenance: null,
            updatedAt: now
        };
    }
    static #loadGenerationCatalog() {
        const key = this.#catalogKey();
        try {
            const raw = world.getDynamicProperty(key);
            if (raw === undefined) {
                this.#catalog = this.#newCatalog();
                this.#catalogStatus = "ready";
                this.#runtimeMode = "NORMAL";
                this.#persistCatalog();
                return;
            }
            if (typeof raw !== "string") throw new Error("Generation catalog is not a string");
            const parsed = JSON.parse(raw);
            if (!parsed || parsed.formatVersion !== 1 || !parsed.activeGeneration || !parsed.generations?.[parsed.activeGeneration]) throw new Error("Generation catalog shape is invalid");
            this.#catalog = parsed;
            this.#catalogStatus = "ready";
            this.#runtimeMode = parsed.maintenance?.mode || "NORMAL";
        } catch (error) {
            this.#catalog = this.#newCatalog();
            this.#catalogStatus = "quarantined";
            this.#runtimeMode = "DEGRADED_READ_ONLY";
            Logger.error("Database", "Generation catalog is corrupt; writes disabled and raw catalog preserved", error);
        }
    }
    static #persistCatalog() {
        if (!this.#catalog || this.#catalogStatus === "quarantined") return false;
        this.#catalog.updatedAt = Date.now();
        world.setDynamicProperty(this.#catalogKey(), JSON.stringify(this.#catalog));
        return true;
    }
    static runtimeStatus() {
        return {
            mode: this.#runtimeMode,
            catalogStatus: this.#catalogStatus,
            activeGeneration: this.#catalog?.activeGeneration || "g0",
            previousGeneration: this.#catalog?.previousGeneration || "",
            maintenance: this.#catalog?.maintenance ? { ...this.#catalog.maintenance } : null,
            generations: Object.values(this.#catalog?.generations || {}).map(g => ({ id: g.id, status: g.status, createdAt: g.createdAt, committedAt: g.committedAt || 0, collectionCount: Object.keys(g.collections || {}).length }))
        };
    }
    static enterMaintenance(reason = "maintenance", actor = "system", mode = "MAINTENANCE") {
        if (this.#runtimeMode !== "NORMAL") return { success: false, error: `Database already in mode ${this.#runtimeMode}` };
        this.#runtimeMode = mode;
        this.#catalog.maintenance = { mode, reason: String(reason).substring(0, 160), actor: String(actor).substring(0, 64), startedAt: Date.now() };
        return { success: this.#persistCatalog(), mode };
    }
    static exitMaintenance() {
        if (this.#catalogStatus === "quarantined") return { success: false, error: "Catalog is quarantined" };
        this.#runtimeMode = "NORMAL";
        this.#catalog.maintenance = null;
        return { success: this.#persistCatalog(), mode: "NORMAL" };
    }
    static registerRefreshHandler(id, callback) {
        if (!id || typeof callback !== "function") return false;
        this.#refreshHandlers.set(String(id), callback);
        return true;
    }
    static unregisterRefreshHandler(id) { return this.#refreshHandlers.delete(String(id)); }
    static #runRefreshBarrier(context) {
        const failures = [];
        this.#internalWriteDepth++;
        try {
            for (const [id, callback] of this.#refreshHandlers.entries()) {
                try {
                    const result = callback(context);
                    if (result && typeof result.then === "function") throw new Error("Refresh barrier handlers must be synchronous");
                } catch (error) { failures.push({ id, error: String(error?.message || error) }); }
            }
        } finally { this.#internalWriteDepth--; }
        return { success: failures.length === 0, failures, handlers: this.#refreshHandlers.size };
    }
    static beginGenerationRestore(label = "restore", actor = "system") {
        const gate = this.enterMaintenance(label, actor, "RESTORING");
        if (!gate.success) return gate;
        const id = `g_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
        this.#catalog.generations[id] = { id, status: "staging", createdAt: Date.now(), committedAt: 0, parent: this.#catalog.activeGeneration, label: String(label).substring(0, 120), collections: {} };
        this.#persistCatalog();
        return { success: true, generation: id, previousGeneration: this.#catalog.activeGeneration };
    }
    static stageGeneration(generation, snapshots = {}) {
        const record = this.#catalog?.generations?.[generation];
        if (this.#runtimeMode !== "RESTORING" || !record || record.status !== "staging") return { success: false, error: "Restore generation is not staging" };
        const names = new Set([...Object.keys(this.#catalog.generations[this.#catalog.activeGeneration]?.collections || {}), ...this.listCollections(), ...Object.keys(snapshots || {})]);
        const staged = [], failed = [];
        for (const name of names) {
            try {
                let source;
                if (Object.prototype.hasOwnProperty.call(snapshots, name)) source = snapshots[name];
                else if (this.#collections.has(name)) source = this.#clone(this.#collections.get(name).rawData);
                else {
                    const raw = this.#readString(this.#generationKey(this.#catalog.activeGeneration, name));
                    if (typeof raw !== "string") throw new Error("Active generation source missing");
                    source = JSON.parse(raw);
                }
                const meta = this.getCollectionMeta(name);
                const normalized = this.#validateWithName(name, this.#clone(source), meta?.defaultData || {}, meta?.validator || null);
                const json = JSON.stringify(normalized);
                const hardLimit = Math.min(this.#config.MAX_COLLECTION_SIZE || (3 * 1024 * 1024), 1_048_576);
                if (json.length > hardLimit) throw new Error(`Staged collection exceeds ${hardLimit} bytes`);
                const revision = Math.max(1, (this.#collections.get(name)?.revision || 0) + 1);
                const key = this.#generationKey(generation, name);
                this.#writeStringSync(key, json, { revision, schemaVersion: normalized.schemaVersion || 1 });
                record.collections[name] = { name, revision, schemaVersion: normalized.schemaVersion || 1, length: json.length, checksum: this.#checksum(json) };
                staged.push(name);
            } catch (error) { failed.push({ name, error: String(error?.message || error) }); break; }
        }
        record.status = failed.length ? "failed" : "staged";
        record.stagedAt = Date.now();
        record.error = failed[0]?.error || "";
        this.#persistCatalog();
        return { success: failed.length === 0, generation, staged, failed };
    }
    static abortGenerationRestore(generation, reason = "aborted") {
        const record = this.#catalog?.generations?.[generation];
        if (record && record.status !== "active") { record.status = "aborted"; record.error = String(reason).substring(0, 300); }
        this.#persistCatalog();
        return this.exitMaintenance();
    }
    static verifyGeneration(generation) {
        const record = this.#catalog?.generations?.[generation];
        if (!record) return { success: false, error: "Generation not found", collections: [] };
        const results = [];
        for (const [name, expected] of Object.entries(record.collections || {})) {
            try {
                const raw = this.#readString(this.#generationKey(generation, name));
                if (typeof raw !== "string") throw new Error("Missing payload");
                if (raw.length !== expected.length || this.#checksum(raw) !== expected.checksum) throw new Error("Manifest checksum/length mismatch");
                JSON.parse(raw);
                results.push({ name, ok: true });
            } catch (error) { results.push({ name, ok: false, error: String(error?.message || error) }); }
        }
        return { success: results.length > 0 && results.every(item => item.ok), generation, collections: results };
    }
    static commitGeneration(generation, context = {}) {
        const record = this.#catalog?.generations?.[generation];
        if (this.#runtimeMode !== "RESTORING" || !record || record.status !== "staged") return { success: false, error: "Generation is not ready to commit" };
        const verify = this.verifyGeneration(generation);
        if (!verify.success) return { success: false, error: "Generation verification failed", verify };
        const previous = this.#catalog.activeGeneration;
        this.#catalog.previousGeneration = previous;
        this.#catalog.activeGeneration = generation;
        record.status = "active"; record.committedAt = Date.now();
        if (this.#catalog.generations[previous]) this.#catalog.generations[previous].status = "rollback";
        if (!this.#persistCatalog()) return { success: false, error: "Catalog commit failed" };
        const reload = this.#reloadLoadedCollections(generation);
        const barrier = this.#runRefreshBarrier({ ...context, generation, previousGeneration: previous, restored: reload.reloaded, at: Date.now() });
        let refreshFlush = { ok: true, success: [], failed: [], missing: [] };
        if (reload.success && barrier.success) {
            const dirty = this.listCollections().filter(name => this.stats(name)?.dirty);
            this.#internalWriteDepth++;
            try { if (dirty.length) refreshFlush = this.flush(dirty, { force: true }); }
            finally { this.#internalWriteDepth--; }
        }
        if (!reload.success || !barrier.success || !refreshFlush.ok) {
            this.#catalog.activeGeneration = previous;
            this.#catalog.previousGeneration = generation;
            record.status = "failed_refresh";
            if (this.#catalog.generations[previous]) this.#catalog.generations[previous].status = "active";
            this.#persistCatalog();
            this.#reloadLoadedCollections(previous);
            this.#runRefreshBarrier({ generation: previous, rolledBackFrom: generation, restored: this.listCollections(), at: Date.now() });
            this.exitMaintenance();
            return { success: false, error: "Refresh barrier/flush failed; generation rolled back", reload, barrier, refreshFlush, rolledBack: true };
        }
        this.exitMaintenance();
        return { success: true, generation, previousGeneration: previous, verify, reload, barrier, refreshFlush };
    }
    static rollbackGeneration(targetGeneration = null, context = {}) {
        const target = targetGeneration || this.#catalog?.previousGeneration;
        if (!target || !this.#catalog?.generations?.[target]) return { success: false, error: "Rollback generation unavailable" };
        const entered = this.#runtimeMode === "NORMAL" ? this.enterMaintenance("generation_rollback", context.actor || "system", "RESTORING") : { success: this.#runtimeMode === "RESTORING" };
        if (!entered.success) return entered;
        const verify = this.verifyGeneration(target);
        if (!verify.success) return { success: false, error: "Rollback generation failed verification", verify };
        const previous = this.#catalog.activeGeneration;
        this.#catalog.activeGeneration = target;
        this.#catalog.previousGeneration = previous;
        this.#catalog.generations[target].status = "active";
        if (this.#catalog.generations[previous]) this.#catalog.generations[previous].status = "rollback";
        this.#persistCatalog();
        const reload = this.#reloadLoadedCollections(target);
        const barrier = this.#runRefreshBarrier({ ...context, generation: target, rolledBackFrom: previous, restored: reload.reloaded, at: Date.now() });
        let refreshFlush = { ok: true, success: [], failed: [], missing: [] };
        if (reload.success && barrier.success) {
            const dirty = this.listCollections().filter(name => this.stats(name)?.dirty);
            this.#internalWriteDepth++;
            try { if (dirty.length) refreshFlush = this.flush(dirty, { force: true }); }
            finally { this.#internalWriteDepth--; }
        }
        if (reload.success && barrier.success && refreshFlush.ok) this.exitMaintenance();
        return { success: reload.success && barrier.success && refreshFlush.ok, generation: target, previousGeneration: previous, reload, barrier, refreshFlush };
    }
    static #reloadLoadedCollections(generation) {
        const reloaded = [], failed = [];
        this.#internalWriteDepth++;
        try {
            for (const [name, col] of this.#collections.entries()) {
                try {
                    const key = this.#generationKey(generation, name);
                    const raw = this.#readString(key);
                    if (typeof raw !== "string") throw new Error("Generation payload missing");
                    const normalized = this.#validateWithName(name, JSON.parse(raw), col.defaultData || {}, col.options?.validate);
                    const readInfo = this.#readDiagnostics.get(key) || {};
                    const oldMeta = this.#proxyTargets.get(col.rawData);
                    if (oldMeta?.proxy) { this.#proxyTargets.delete(col.rawData); this.#proxyTargets.delete(oldMeta.proxy); }
                    col.rawData = normalized;
                    col.data = this.#trackingProxy(name, normalized);
                    col.key = key; col.generation = generation; col.legacyKey = this.#prefix + name; col.needsGenerationMigration = false;
                    col.revision = Math.max(0, Math.floor(Number(readInfo.revision) || 0));
                    col.persistedRevision = col.revision; col.dirty = false; col.dirtySince = 0;
                    col.estimatedBytes = raw.length; col.persistedBytes = raw.length; col.sizeStale = false;
                    col.status = readInfo.degraded ? "degraded" : "ready"; col.quarantine = null; col.readSource = readInfo.source || "none";
                    col.migration = this.#migrationDiagnostics.get(name) || null;
                    reloaded.push(name);
                } catch (error) { failed.push({ name, error: String(error?.message || error) }); }
            }
        } finally { this.#internalWriteDepth--; }
        return { success: failed.length === 0, reloaded, failed };
    }
    static #recordCatalogCollection(col, json) {
        if (!this.#catalog || this.#catalogStatus !== "ready") return;
        const generation = this.#catalog.generations[col.generation] || (this.#catalog.generations[col.generation] = { id: col.generation, status: "active", createdAt: Date.now(), committedAt: Date.now(), collections: {} });
        generation.collections[col.name] = { name: col.name, revision: col.persistedRevision, schemaVersion: col.rawData?.schemaVersion || 1, length: json.length, checksum: this.#checksum(json) };
        this.#persistCatalog();
    }

    static initialize(customConfig = {}) {
        if (this.#initialized) return;
        this.#config = { ...CONFIG.DATABASE, ...customConfig };
        this.#prefix = this.#config.PREFIX || "mcity2:";
        this.#loadGenerationCatalog();
        // Phase 5: ensure migrations are registered before any collection loads.
        Migrations.initialize();

        // Background Auto-Save using system.runJob to prevent tick lag
        const saveId = RuntimeHandleRegistry.interval("Database.autosave", () => {
            this.requestSaveAll(false, "autosave");
        }, this.#config.SAVE_INTERVAL_TICKS || 6000);
        this.#intervals.add(saveId);

        const cacheId = RuntimeHandleRegistry.interval("Database.cacheCleanup", () => {
            // Reserved for future cache cleanup
        }, this.#config.CACHE_CLEANUP_INTERVAL_TICKS || 1200);
        this.#intervals.add(cacheId);

        this.#initialized = true;
        Logger.startup("Database", `Initialized with prefix '${this.#prefix}'`);
    }

    static collection(name, defaultData = null, options = null) {
        if (!name || typeof name !== "string") throw new Error("Collection name must be a non-empty string.");
        if (!this.#initialized) this.initialize();

        // Phase 2 Lazy Loading: if a pending registration exists for this name
        // and the caller didn't supply defaults, use the pending ones. This
        // lets services call `db()` (no args) and still get the right defaults
        // + validator from a prior `registerLazy` call.
        if (!this.#collections.has(name) && this.#pending.has(name) && (defaultData === null || Object.keys(defaultData).length === 0)) {
            const pending = this.#pending.get(name);
            defaultData = pending.defaultData;
            options = pending.options || {};
            this.#pending.delete(name);
        }

        if (!this.#collections.has(name)) {
            if (defaultData === null) defaultData = {};
            if (options === null) options = {};
            const generation = this.#catalog?.activeGeneration || "g0";
            const key = this.#generationKey(generation, name);
            const legacyKey = this.#prefix + name;
            let data = this.#clone(defaultData);
            let loadError = null;
            let usedLegacyGeneration = false;

            try {
                let raw = this.#readString(key);
                if (typeof raw !== "string") {
                    raw = this.#readString(legacyKey);
                    if (typeof raw === "string") {
                        usedLegacyGeneration = true;
                        const legacyInfo = this.#readDiagnostics.get(legacyKey) || {};
                        this.#readDiagnostics.set(key, { ...legacyInfo, source: `legacy_generation:${legacyInfo.source || "legacy"}`, degraded: false });
                    }
                }
                if (typeof raw === "string") {
                    const parsed = JSON.parse(raw);
                    data = this.#validateWithName(name, parsed, defaultData, options.validate);
                } else {
                    // New collections also receive the latest schemaVersion.
                    data = this.#validateWithName(name, this.#clone(defaultData), defaultData, options.validate);
                }
            } catch (error) {
                loadError = error;
                Logger.error("Database", `Collection '${name}' load/migration failed; entering quarantine with source storage preserved`, error);
                data = this.#clone(defaultData);
                data.schemaVersion = Migrations.latestVersion(name);
            }

            const rawData = data; // Keep a reference to the unproxied raw data.
            const loadedSize = this.#estimate(rawData);
            const readInfo = this.#readDiagnostics.get(key) || {};
            const initialRevision = Math.max(0, Math.floor(Number(readInfo.revision) || 0));
            const proxy = this.#trackingProxy(name, rawData);

            this.#collections.set(name, {
                name,
                key,
                generation,
                legacyKey,
                needsGenerationMigration: usedLegacyGeneration,
                data: proxy,
                rawData,
                options,
                defaultData: this.#clone(defaultData),
                revision: initialRevision,
                persistedRevision: initialRevision,
                savingRevision: null,
                dirty: false,
                dirtySince: 0,
                sizeStale: false,
                estimatedBytes: loadedSize,
                persistedBytes: loadedSize,
                status: loadError ? "quarantined" : (readInfo.degraded ? "degraded" : "ready"),
                quarantine: loadError ? {
                    at: Date.now(),
                    error: String(loadError?.message || loadError).substring(0, 500),
                    attempts: readInfo.attempts || []
                } : null,
                readSource: readInfo.source || "none",
                migration: this.#migrationDiagnostics.get(name) || null,
                lastSaveError: "",
                loadedAt: Date.now(),
                lastSave: 0,
                lastMutationAt: 0,
                directMutationCount: 0,
                transactionCommitCount: 0,
                mutationSources: {}
            });
            Logger.info("Database", `Collection '${name}' loaded (${loadedSize} bytes, revision ${initialRevision}, generation ${generation}${usedLegacyGeneration ? ", legacy-source" : ""}, status ${loadError ? "quarantined" : (readInfo.degraded ? "degraded" : "ready")})`);
        }

        return this.#collections.get(name).data;
    }

    /**
     * Phase 2 Performance: Register a collection with its default data and
     * validator WITHOUT loading it from disk yet. The next call to
     * `collection(name)` (or `transaction(name, ...)`) will trigger the
     * actual load.
     *
     * This is useful for services that want to declare their collections up
     * front (so `Database.saveAll()` and `Database.listCollections()` know
     * about them) but defer the JSON parse + validate cost until first use.
     *
     * Calling `collection(name)` after `registerLazy(name, ...)` returns
     * the loaded collection. The defaults and validator passed here are
     * reused at that point — callers don't need to pass them again.
     */
    static registerLazy(name, defaultData = {}, options = {}) {
        if (!name || typeof name !== "string") throw new Error("Collection name must be a non-empty string.");
        if (!this.#initialized) this.initialize();
        if (this.#collections.has(name)) return;  // already loaded or pending — no-op

        // Stash the defaults/options in a pending slot. The next `collection(name)`
        // call will pick them up if it doesn't pass its own.
        this.#pending.set(name, { defaultData: this.#clone(defaultData), options });
    }

    /** @type {Map<string, {defaultData: any, options: any}>} */
    static #pending = new Map();

    static hasCollection(name) {
        return this.#collections.has(name);
    }

    static hasPersistedStorage(name, generation = null) {
        if (!this.#initialized) this.initialize();
        const gen = generation || this.#catalog?.activeGeneration || "g0";
        const candidates = [this.#generationKey(gen, name), this.#prefix + name];
        for (const key of candidates) {
            try {
                if (world.getDynamicProperty(`${key}:__active`) !== undefined
                    || world.getDynamicProperty(key) !== undefined
                    || world.getDynamicProperty(`${key}:__meta`) !== undefined) return true;
            } catch {}
        }
        return false;
    }

    static markDirty(name) {
        const col = this.#collections.get(name);
        if (!col) return false;
        // Legacy callers usually invoke markDirty after proxy mutations. Do
        // not increment twice if the collection is already dirty. If no proxy
        // mutation was observed, markDirty represents one legacy mutation.
        if (!col.dirty) this.#recordMutation(name, "legacy_markDirty");
        else {
            col.sizeStale = true;
            col.lastMutationAt = Date.now();
        }
        return true;
    }

    static #recordMutation(name, source = "direct") {
        const col = this.#collections.get(name);
        if (!col) return false;
        if (this.#runtimeMode !== "NORMAL" && this.#internalWriteDepth === 0) {
            const error = new Error(`Database writes are blocked while mode=${this.#runtimeMode}.`);
            error.code = "DB_MAINTENANCE";
            throw error;
        }
        if (col.status === "quarantined") {
            const error = new Error(`Collection '${name}' is quarantined and cannot be mutated.`);
            error.code = "DB_COLLECTION_QUARANTINED";
            throw error;
        }
        // A live proxy write to the same collection while its transaction is
        // active would be overwritten by the working clone. Fail closed.
        if (this.#transactionStack.includes(name)) {
            const error = new Error(`Live mutation of '${name}' attempted during its active transaction.`);
            error.code = "DB_LIVE_MUTATION_DURING_TX";
            throw error;
        }
        col.revision++;
        col.dirty = true;
        if (!col.dirtySince) col.dirtySince = Date.now();
        col.sizeStale = true;
        col.lastMutationAt = Date.now();
        col.directMutationCount++;
        col.mutationSources[source] = (col.mutationSources[source] || 0) + 1;
        this.#transactionMetrics.directMutations++;
        return true;
    }

    /**
     * Phase 7.6 (v0.23.0) (S10): Append-only fast path for high-volume
     * collections like audit events.
     *
     * `Database.transaction` deep-clones the entire collection on every call,
     * which is expensive for audit (3000+ events, 100-300KB per clone at
     * 500/sec = 50-150MB/sec of allocation). This method bypasses the clone
     * by appending directly to the raw data's array field and marking dirty.
     *
     * IMPORTANT: This is NOT atomic — if the server crashes between the
     * append and the next save, the event may be lost. For audit events
     * this is an acceptable trade-off (audit is best-effort, not financial).
     * Do NOT use this for financial transactions.
     *
     * @param {string} name - collection name
     * @param {string} arrayField - the field name in the collection's data
     *        that holds the array to append to (e.g. "events")
     * @param {*} item - the item to append (must be JSON-serializable)
     * @param {function|null} counterCallback - optional callback that receives
     *        the raw data object for counter/stat updates (no clone, mutate
     *        in place)
     * @returns {boolean} true if appended, false if collection/array missing
     */
    static appendArray(name, arrayField, item, counterCallback = null) {
        const col = this.#collections.get(name);
        if (!col) return false;
        const raw = col.rawData;
        if (!raw || !Array.isArray(raw[arrayField])) return false;
        raw[arrayField].push(item);
        // Cap the array to 2× the configured max to avoid unbounded growth.
        // The caller (AuditService) handles the real cap via RingBuffer.
        const cap = (name === "audit") ? 6000 : 10000;
        if (raw[arrayField].length > cap) {
            raw[arrayField] = raw[arrayField].slice(-Math.floor(cap / 2));
        }
        // Optional counter update (in-place, no clone).
        if (typeof counterCallback === "function") {
            try { counterCallback(raw); } catch (e) {
                Logger.debug("Database", `appendArray counter callback failed for ${name}`, e);
            }
        }
        this.#recordMutation(name, "appendArray");
        return true;
    }

    static transaction(name, callback) {
        this.#transactionMetrics.attempted++;
        const col = this.#collections.get(name);
        const revisionBefore = col?.revision ?? null;
        if (!col) return this.#transactionFailure("DB_COLLECTION_NOT_LOADED", `Collection '${name}' not loaded.`, revisionBefore);
        if (this.#runtimeMode !== "NORMAL" && this.#internalWriteDepth === 0) return this.#transactionFailure("DB_MAINTENANCE", `Database writes are blocked while mode=${this.#runtimeMode}.`, revisionBefore);
        if (col.status === "quarantined") return this.#transactionFailure("DB_COLLECTION_QUARANTINED", `Collection '${name}' is quarantined and read-only until explicit reset/restore.`, revisionBefore);
        if (typeof callback !== "function") return this.#transactionFailure("DB_INVALID_CALLBACK", "Transaction callback must be a function.", revisionBefore);
        if (this.#transactionStack.includes(name)) {
            this.#transactionMetrics.rejectedNested++;
            return this.#transactionFailure("DB_NESTED_WRITE", `Nested write transaction on '${name}' is not allowed.`, revisionBefore);
        }

        const workingRaw = this.#clone(col.rawData);
        let changed = false;
        this.#transactionStack.push(name);
        try {
            const workingProxy = this.#trackingProxy(`temp_tx_${name}`, workingRaw, () => { changed = true; });
            const value = callback(workingProxy);

            if (value && typeof value.then === "function") {
                this.#transactionMetrics.rejectedAsync++;
                // Prevent a rejected async callback from becoming an unhandled
                // rejection after the transaction is correctly refused.
                Promise.resolve(value).catch(error => Logger.debug("Database", `Rejected async transaction callback later failed on '${name}'`, error));
                const error = new Error(`Async transaction callback is forbidden for '${name}'.`);
                error.code = "DB_ASYNC_CALLBACK";
                throw error;
            }
            if (value && typeof value.next === "function") {
                this.#transactionMetrics.rejectedGenerator++;
                const error = new Error(`Generator transaction callback is forbidden for '${name}'. Use the batch task API planned for Phase 2.3.`);
                error.code = "DB_GENERATOR_CALLBACK";
                throw error;
            }

            const output = this.#snapshotTransactionValue(value);
            if (!changed) {
                this.#transactionMetrics.noChange++;
                return {
                    success: true,
                    value: output,
                    result: output,
                    changed: false,
                    revisionBefore,
                    revisionAfter: revisionBefore,
                    errorCode: null,
                    errorMessage: null,
                    error: null
                };
            }

            this.#commitTransaction(col, workingRaw, { incrementRevision: true, source: "transaction" });
            this.#transactionMetrics.committed++;
            return {
                success: true,
                value: output,
                result: output,
                changed: true,
                revisionBefore,
                revisionAfter: col.revision,
                errorCode: null,
                errorMessage: null,
                error: null
            };
        } catch (error) {
            this.#transactionMetrics.rolledBack++;
            const code = error?.code || "DB_CALLBACK_ERROR";
            Logger.error("Database", `Transaction failed on '${name}' [${code}]`, error);
            return this.#transactionFailure(code, error?.message || String(error), revisionBefore);
        } finally {
            const index = this.#transactionStack.lastIndexOf(name);
            if (index >= 0) this.#transactionStack.splice(index, 1);
        }
    }

    static #snapshotTransactionValue(value) {
        if (!value || typeof value !== "object") return value;
        return this.#clone(this.#unwrap(value));
    }

    static #transactionFailure(errorCode, errorMessage, revisionBefore = null) {
        return {
            success: false,
            value: undefined,
            result: undefined,
            changed: false,
            revisionBefore,
            revisionAfter: revisionBefore,
            errorCode,
            errorMessage,
            // Backward-compatible alias used by existing services.
            error: errorMessage
        };
    }

    // Long-lived snapshot transactions were removed in Phase 2.3.
    // Use BatchTaskService with short Database.transaction batches.

    /**
     * Phase 1 Critical Fix: Centralized commit logic to avoid duplicating
     * proxy rebuilding. Also clears stale proxy references that previously
     * caused memory leaks in #proxyTargets WeakMap.
     */
    static #commitTransaction(col, workingRaw, options = {}) {
        const oldProxyMeta = this.#proxyTargets.get(col.rawData);
        if (oldProxyMeta?.proxy) {
            this.#proxyTargets.delete(col.rawData);
            this.#proxyTargets.delete(oldProxyMeta.proxy);
        }
        col.rawData = workingRaw;
        col.data = this.#trackingProxy(col.name, workingRaw);
        if (options.incrementRevision !== false) col.revision++;
        col.dirty = true;
        if (!col.dirtySince) col.dirtySince = Date.now();
        col.sizeStale = true;
        col.lastMutationAt = Date.now();
        col.transactionCommitCount++;
        const source = options.source || "transaction";
        col.mutationSources[source] = (col.mutationSources[source] || 0) + 1;
    }

    // Synchronous save (use cautiously on large DBs, prefers saveAllJob for background)
    //
    // Phase 4 Fix: Save coordination with the background save queue.
    //
    // PROBLEM (pre-Phase 4):
    //   `#isSaving` was a boolean, not a real mutex. If a sync `save(name)`
    //   ran while the background save worker was mid-write for the SAME collection, the
    //   sync save could clobber `key:__meta` while the job was incrementally
    //   writing chunks — leaving stale orphan chunks from the previous write.
    //   This was rare (the job yields between chunks, so the window is small)
    //   but could corrupt collection state on crash.
    //
    // SOLUTION (Phase 4):
    //   1. A `#syncSaving` Set tracks collection names currently being
    //      saved synchronously. The job skips any collection in this set
    //      (it will be saved on the next job cycle).
    //   2. If `#isSaving` is true AND the job is currently writing the
    //      requested collection, sync `save()` skips and returns false
    //      (caller should retry or defer). A `#jobSavingCollection` field
    //      tracks which collection the job is currently processing.
    //   3. The window is very small (one collection per job iteration), so
    //      in practice sync saves almost always proceed immediately. The
    //      guard only activates during the actual write of that specific
    //      collection, preventing the clobber scenario.
    static #syncSaving = new Set();  // collections currently in sync save
    static #jobSavingCollection = null;  // collection the job is currently writing

    static save(name, force = false) {
        const col = this.#collections.get(name);
        if (!col) return false;
        if (this.#runtimeMode !== "NORMAL" && this.#internalWriteDepth === 0) return false;
        if (col.status === "quarantined") {
            col.lastSaveError = "Quarantined collection cannot be saved without explicit reset/restore.";
            return false;
        }
        if (!force && !col.dirty) return true;

        // Phase 4 Fix: If the async job is currently writing THIS collection,
        // skip the sync save to prevent clobbering. The collection will be
        // saved on the next job cycle (its dirty flag is still set if the
        // job hasn't cleared it yet, or was re-set by a mutation during the
        // job window).
        if (this.#isSaving && this.#jobSavingCollection === name) {
            Logger.debug("Database", `Sync save skipped for '${name}' — async job is writing it. Will save on next cycle.`);
            // Re-mark dirty so the next job cycle picks it up.
            col.dirty = true;
            return false;
        }

        // Phase 4 Fix: Track this collection as being sync-saved so the
        // job can skip it if the job reaches this collection during our write.
        this.#syncSaving.add(name);
        col.savingRevision = col.revision;
        col.status = "saving";
        col.lastSaveError = "";
        try {
            // Stringify rawData to completely bypass Proxy overhead. Massive performance boost!
            const json = JSON.stringify(col.rawData);
            // Phase 5 Deep Fix: Respect MAX_COLLECTION_SIZE from config while enforcing
            // an absolute ceiling of 1MB for Bedrock Dynamic Property safety.
            const configuredLimit = this.#config.MAX_COLLECTION_SIZE || (3 * 1024 * 1024);
            const ABSOLUTE_CEILING = 1_048_576; // 1MB — Bedrock DP hard safety cap
            const HARD_LIMIT = Math.min(configuredLimit, ABSOLUTE_CEILING);
            if (json.length > HARD_LIMIT) {
                col.status = "oversize";
                col.lastSaveError = `Collection size ${json.length} exceeds limit ${HARD_LIMIT}`;
                col.estimatedBytes = json.length;
                col.sizeStale = false;
                Logger.error("Database", `Collection '${name}' exceeded safe limit (${json.length} bytes > ${HARD_LIMIT}). Save refused; collection remains dirty.`);
                return false;
            }
            this.#writeStringSync(col.key, json, { revision: col.savingRevision, schemaVersion: col.rawData?.schemaVersion || 1 });
            col.persistedRevision = col.savingRevision;
            col.dirty = col.revision !== col.persistedRevision;
            col.dirtySince = col.dirty ? (col.dirtySince || Date.now()) : 0;
            col.lastSave = Date.now();
            col.persistedBytes = json.length;
            col.estimatedBytes = json.length;
            col.sizeStale = false;
            if (col.needsGenerationMigration && col.legacyKey !== col.key) {
                this.#clearAllStorage(col.legacyKey);
                col.needsGenerationMigration = false;
            }
            this.#recordCatalogCollection(col, json);
            return true;
        } catch (error) {
            col.status = "degraded";
            col.lastSaveError = String(error?.message || error).substring(0, 500);
            Logger.error("Database", `Save failed for '${name}'`, error);
            return false;
        } finally {
            col.savingRevision = null;
            if (col.status === "saving") col.status = "ready";
            this.#syncSaving.delete(name);
        }
    }

    static saveAll(force = false) {
        const result = { success: [], failed: [], skipped: [] };
        for (const [name, col] of this.#collections.entries()) {
            if (!force && !col.dirty) { result.skipped.push(name); continue; }
            if (this.save(name, force)) result.success.push(name); else result.failed.push(name);
        }
        if (result.success.length) Logger.info("Database", `Saved synchronously: ${result.success.join(", ")}`);
        return result;
    }

    static requestSave(name, options = {}) {
        const col = this.#collections.get(name);
        if (!col || col.status === "quarantined") return false;
        const force = !!options.force;
        if (!force && !col.dirty) {
            this.#saveQueueMetrics.skipped++;
            return true;
        }
        this.#saveQueueMetrics.requested++;
        const existing = this.#saveQueue.get(name);
        if (existing) {
            existing.force = existing.force || force;
            existing.reasons.add(String(options.reason || "request"));
            this.#saveQueueMetrics.coalesced++;
        } else {
            this.#saveQueue.set(name, {
                name,
                force,
                requestedAt: Date.now(),
                reasons: new Set([String(options.reason || "request")])
            });
            this.#saveQueueMetrics.maxDepth = Math.max(this.#saveQueueMetrics.maxDepth, this.#saveQueue.size);
        }
        this.#startSaveWorker();
        return true;
    }

    static requestSaveAll(force = false, reason = "save_all") {
        let queued = 0, skipped = 0;
        for (const [name, col] of this.#collections.entries()) {
            if (!force && !col.dirty) { skipped++; continue; }
            if (this.requestSave(name, { force, reason })) queued++;
        }
        return { queued, skipped, depth: this.#saveQueue.size };
    }

    static saveQueueStats() {
        const entries = [...this.#saveQueue.values()];
        const oldest = entries.length ? Math.min(...entries.map(entry => entry.requestedAt)) : 0;
        return {
            ...this.#saveQueueMetrics,
            depth: this.#saveQueue.size,
            active: this.#isSaving,
            workerId: this.#saveWorkerId,
            currentCollection: this.#jobSavingCollection,
            oldestWaitMs: oldest ? Math.max(0, Date.now() - oldest) : 0,
            queuedCollections: entries.map(entry => entry.name)
        };
    }

    static flush(names, options = {}) {
        const list = Array.isArray(names) ? names : [names];
        const result = { success: [], failed: [], missing: [] };
        for (const name of list) {
            if (!this.#collections.has(name)) { result.missing.push(name); continue; }
            this.#saveQueue.delete(name);
            if (this.save(name, options.force !== false)) result.success.push(name);
            else result.failed.push(name);
        }
        return { ...result, ok: result.failed.length === 0 && result.missing.length === 0 };
    }

    static flushCritical(names, reason = "critical") {
        const result = this.flush(names, { force: true, reason });
        if (!result.ok) Logger.error("Database", `Critical flush '${reason}' failed: ${result.failed.concat(result.missing).join(", ")}`);
        return result;
    }

    static #priorityFor(name) {
        if (this.#savePriority.has(name)) return this.#savePriority.get(name);
        for (const [base, priority] of this.#savePriority.entries()) {
            if (name.startsWith(`${base}_shard_`)) return priority;
        }
        return 99;
    }

    static #startSaveWorker() {
        if (this.#isSaving || this.#saveWorkerId !== null || this.#saveQueue.size === 0) return;
        this.#saveWorkerId = RuntimeHandleRegistry.job("Database.saveQueue", this.#saveQueueJob());
    }

    static *#saveQueueJob() {
        this.#isSaving = true;
        try {
            while (this.#saveQueue.size > 0) {
                const entry = [...this.#saveQueue.values()].sort((a, b) => {
                    return this.#priorityFor(a.name) - this.#priorityFor(b.name) || a.requestedAt - b.requestedAt;
                })[0];
                this.#saveQueue.delete(entry.name);
                const col = this.#collections.get(entry.name);
                if (!col || col.status === "quarantined") {
                    this.#saveQueueMetrics.failed++;
                    continue;
                }
                if (!entry.force && !col.dirty) {
                    this.#saveQueueMetrics.skipped++;
                    continue;
                }
                if (this.#syncSaving.has(entry.name)) {
                    this.#saveQueue.set(entry.name, entry);
                    yield;
                    continue;
                }

                this.#jobSavingCollection = entry.name;
                col.savingRevision = col.revision;
                col.status = "saving";
                col.lastSaveError = "";
                try {
                    const json = JSON.stringify(col.rawData);
                    const configuredLimit = this.#config.MAX_COLLECTION_SIZE || (3 * 1024 * 1024);
                    const hardLimit = Math.min(configuredLimit, 1_048_576);
                    if (json.length > hardLimit) {
                        col.status = "oversize";
                        col.lastSaveError = `Collection size ${json.length} exceeds limit ${hardLimit}`;
                        col.estimatedBytes = json.length;
                        col.sizeStale = false;
                        this.#saveQueueMetrics.failed++;
                        Logger.error("Database", `Queued save refused for '${entry.name}': ${col.lastSaveError}`);
                        continue;
                    }

                    yield* this.#writeStringJob(col.key, json, {
                        revision: col.savingRevision,
                        schemaVersion: col.rawData?.schemaVersion || 1
                    });

                    col.persistedRevision = col.savingRevision;
                    col.dirty = col.revision !== col.persistedRevision;
                    col.dirtySince = col.dirty ? (col.dirtySince || Date.now()) : 0;
                    col.lastSave = Date.now();
                    col.persistedBytes = json.length;
                    if (!col.dirty) {
                        col.estimatedBytes = json.length;
                        col.sizeStale = false;
                    }
                    if (col.needsGenerationMigration && col.legacyKey !== col.key) {
                        this.#clearAllStorage(col.legacyKey);
                        col.needsGenerationMigration = false;
                    }
                    this.#recordCatalogCollection(col, json);
                    this.#saveQueueMetrics.completed++;
                    if (col.dirty) this.requestSave(entry.name, { reason: "newer_revision" });
                } catch (error) {
                    col.status = "degraded";
                    col.lastSaveError = String(error?.message || error).substring(0, 500);
                    col.dirty = true;
                    this.#saveQueueMetrics.failed++;
                    Logger.error("Database", `Queued save failed for '${entry.name}'`, error);
                } finally {
                    col.savingRevision = null;
                    if (col.status === "saving") col.status = "ready";
                    this.#jobSavingCollection = null;
                }
                yield;
            }
        } finally {
            this.#isSaving = false;
            this.#saveWorkerId = null;
            this.#saveQueueMetrics.lastDrainAt = Date.now();
            if (this.#saveQueue.size > 0) this.#startSaveWorker();
        }
    }

    static reset(name, data = {}) {
        const col = this.#collections.get(name);
        if (!col) return false;
        if (this.#runtimeMode !== "NORMAL" && this.#internalWriteDepth === 0) return false;
        // Phase 6 (v1.5.6): reset() is used by backup restore and admin tools.
        // Keep it schema-aware so malformed raw data cannot bypass the
        // collection validator and sit in memory until a later load silently
        // self-heals to defaults. BackupService already passes normalized
        // data, so this is a defensive second layer.
        try {
            const validated = this.#validateWithName(name, data, col.defaultData || {}, col.options?.validate);
            const newRaw = this.#clone(validated);
            col.status = "ready";
            col.quarantine = null;
            col.migration = this.#migrationDiagnostics.get(name) || null;
            col.lastSaveError = "";
            this.#commitTransaction(col, newRaw, { incrementRevision: true, source: "reset" });
            return this.save(name, true);
        } catch (error) {
            col.lastSaveError = String(error?.message || error).substring(0, 500);
            Logger.error("Database", `Validated reset rejected for '${name}'; existing source preserved`, error);
            return false;
        }
    }

    static drop(name) {
        const col = this.#collections.get(name);
        if (!col) return false;
        try {
            this.#clearAllStorage(col.key);
            this.#collections.delete(name);
            Logger.warn("Database", `Dropped collection '${name}'`);
            return true;
        } catch (error) {
            Logger.error("Database", `Failed to drop '${name}'`, error);
            return false;
        }
    }

    static listCollections() {
        return [...this.#collections.keys()];
    }

    /**
     * Phase 2 Fix: Expose a collection's registered validator and default data.
     *
     * Used by `BackupService.#validateBeforeReset` to run the real schema
     * validator on reconstructed backup data before calling `Database.reset`
     * (which bypasses validation). Previously, the validator was private
     * and `#validateBeforeReset` was effectively a no-op (only checked
     * `typeof === "object"`), allowing malformed backups to corrupt live
     * state via `Database.reset`.
     *
     * Returns `{ validator, defaultData }` or `null` if the collection
     * is not registered.
     */
    static getCollectionMeta(name) {
        const col = this.#collections.get(name);
        if (col) {
            return {
                validator: typeof col.options?.validate === "function" ? col.options.validate : null,
                defaultData: col.defaultData ? this.#clone(col.defaultData) : null,
                loaded: true,
                revision: col.revision,
                persistedRevision: col.persistedRevision,
                status: col.status
            };
        }
        // Phase 6 (v1.5.6): also expose metadata for collections registered
        // through registerLazy() but not loaded yet. This lets backup restore
        // validate lazy collections instead of falling back to structural-only
        // checks just because the collection has not been touched this session.
        const pending = this.#pending.get(name);
        if (!pending) return null;
        return {
            validator: typeof pending.options?.validate === "function" ? pending.options.validate : null,
            defaultData: pending.defaultData ? this.#clone(pending.defaultData) : null,
            loaded: false
        };
    }

    static stats(name) {
        const col = this.#collections.get(name);
        if (!col) return null;
        const liveSize = this.#refreshEstimate(col);
        return {
            name,
            generation: col.generation,
            needsGenerationMigration: col.needsGenerationMigration,
            status: col.status,
            quarantined: col.status === "quarantined",
            quarantine: col.quarantine ? { ...col.quarantine } : null,
            readSource: col.readSource,
            schemaVersion: Math.max(1, Math.floor(Number(col.rawData?.schemaVersion) || 1)),
            migration: col.migration ? { ...col.migration } : null,
            lastSaveError: col.lastSaveError,
            dirty: col.dirty,
            dirtySince: col.dirtySince,
            revision: col.revision,
            persistedRevision: col.persistedRevision,
            savingRevision: col.savingRevision,
            loadedAt: col.loadedAt,
            lastSave: col.lastSave,
            lastMutationAt: col.lastMutationAt,
            size: liveSize,
            liveSize,
            persistedSize: col.persistedBytes,
            sizeStale: col.sizeStale,
            itemCount: this.#count(col.rawData),
            directMutationCount: col.directMutationCount,
            transactionCommitCount: col.transactionCommitCount,
            mutationSources: { ...col.mutationSources }
        };
    }

    static quarantineInfo(name) {
        const col = this.#collections.get(name);
        if (!col) return null;
        return {
            name,
            quarantined: col.status === "quarantined",
            status: col.status,
            details: col.quarantine ? { ...col.quarantine } : null,
            storage: this.storageStats(name)
        };
    }

    static exportQuarantine(name) {
        const col = this.#collections.get(name);
        if (!col || col.status !== "quarantined") return { success: false, error: "Collection is not quarantined." };
        const key = col.key;
        return {
            success: true,
            name,
            exportedAt: Date.now(),
            quarantine: col.quarantine ? { ...col.quarantine } : null,
            active: this.#activeSlot(key),
            legacyGenerationSource: col.legacyKey && col.legacyKey !== key ? this.#dumpStorageBase(col.legacyKey) : null,
            legacy: this.#dumpStorageBase(key),
            slotA: this.#dumpStorageBase(this.#slotBase(key, "a")),
            slotB: this.#dumpStorageBase(this.#slotBase(key, "b"))
        };
    }

    static recoverQuarantine(name, candidate = "a") {
        const col = this.#collections.get(name);
        if (!col || col.status !== "quarantined") return { success: false, error: "Collection is not quarantined." };
        const base = candidate === "legacy"
            ? (col.needsGenerationMigration && col.legacyKey ? col.legacyKey : col.key)
            : this.#slotBase(col.key, candidate === "b" ? "b" : "a");
        try {
            const raw = this.#readStringFromBase(base);
            if (typeof raw !== "string") throw new Error("Candidate has no verified payload.");
            const parsed = JSON.parse(raw);
            const restored = this.reset(name, parsed);
            return restored ? { success: true, candidate, revision: this.#collections.get(name)?.revision || 0 } : { success: false, error: "Candidate validation/reset failed." };
        } catch (error) {
            return { success: false, error: String(error?.message || error) };
        }
    }

    static #dumpStorageBase(baseKey) {
        const metaRaw = (() => { try { return world.getDynamicProperty(baseKey + ":__meta"); } catch { return undefined; } })();
        const direct = (() => { try { return world.getDynamicProperty(baseKey); } catch { return undefined; } })();
        let count = 0;
        try { const meta = typeof metaRaw === "string" ? JSON.parse(metaRaw) : null; count = Math.max(0, Math.min(256, Math.floor(Number(meta?.chunks) || 0))); } catch { count = 0; }
        const chunks = [];
        for (let i = 0; i < count; i++) {
            try { chunks.push(world.getDynamicProperty(`${baseKey}:__chunk:${i}`)); } catch { chunks.push(undefined); }
        }
        return { baseKey, metaRaw, direct, chunks };
    }

    static transactionStats() {
        return {
            ...this.#transactionMetrics,
            activeStack: [...this.#transactionStack],
            mutableProxyCollections: [...this.#collections.values()].filter(col => col.directMutationCount > 0).map(col => ({
                name: col.name,
                directMutationCount: col.directMutationCount,
                revision: col.revision
            }))
        };
    }

    static #refreshEstimate(col) {
        if (col.sizeStale) {
            col.estimatedBytes = this.#estimate(col.rawData);
            col.sizeStale = false;
        }
        return col.estimatedBytes;
    }

    static storageStats(name) {
        const col = this.#collections.get(name);
        if (!col) return null;
        const key = col.key;
        const active = this.#activeSlot(key);
        return {
            name,
            key,
            active,
            readable: this.verifyStorage(name).ok,
            legacy: this.#storageBaseStats(key),
            slotA: this.#storageBaseStats(this.#slotBase(key, "a")),
            slotB: this.#storageBaseStats(this.#slotBase(key, "b")),
            dirty: col.dirty,
            revision: col.revision,
            persistedRevision: col.persistedRevision,
            memorySize: this.#refreshEstimate(col),
            persistedSize: col.persistedBytes
        };
    }

    static verifyStorage(name) {
        const col = this.#collections.get(name);
        if (!col) return { ok: false, error: `Collection '${name}' not loaded.` };
        const key = col.key;
        const active = this.#activeSlot(key);
        const attempts = [];
        const tryBase = (label, base) => {
            try {
                const raw = this.#readStringFromBase(base);
                if (typeof raw !== "string") throw new Error("No string payload");
                JSON.parse(raw);
                const meta = this.#chunkMeta(base) || {};
                attempts.push({ label, ok: true, length: raw.length, revision: Number(meta.revision) || 0, checksum: meta.checksum || "legacy" });
                return true;
            } catch (e) {
                attempts.push({ label, ok: false, error: e?.message || String(e) });
                return false;
            }
        };
        if (active && tryBase(`slot_${active}`, this.#slotBase(key, active))) return { ok: true, active, attempts };
        if (active) {
            const other = this.#inactiveSlot(active);
            if (tryBase(`slot_${other}`, this.#slotBase(key, other))) return { ok: true, active, fallback: other, attempts };
        }
        if (tryBase("legacy", key)) return { ok: true, active, fallback: "legacy", attempts };
        return { ok: false, active, attempts };
    }

    static compactStorage(name) {
        const col = this.#collections.get(name);
        if (!col) return { success: false, error: `Collection '${name}' not loaded.` };
        const saved = this.save(name, true);
        const verify = this.verifyStorage(name);
        return { success: !!saved && verify.ok, saved: !!saved, verify, stats: this.storageStats(name) };
    }

    static cleanupOrphanStorage(name) {
        const col = this.#collections.get(name);
        if (!col) return { success: false, error: `Collection '${name}' not loaded.` };
        const key = col.key;
        const active = this.#activeSlot(key);
        const before = this.storageStats(name);
        let clearedLegacy = false, clearedInactive = false;
        if (active) {
            this.#clearLegacyStorage(key);
            clearedLegacy = true;
            const other = this.#inactiveSlot(active);
            const activeOk = this.#storageBaseReadable(this.#slotBase(key, active));
            const otherOk = this.#storageBaseReadable(this.#slotBase(key, other));
            // Keep a readable inactive slot as a fallback copy. Only remove it
            // if it is unreadable/orphaned.
            if (activeOk && !otherOk) { this.#clearSlotStorage(key, other); clearedInactive = true; }
        } else {
            // No active pointer: compact migrates legacy to double-buffer.
            const compact = this.compactStorage(name);
            return { success: compact.success, migratedLegacy: true, before, after: this.storageStats(name), compact };
        }
        return { success: true, clearedLegacy, clearedInactive, before, after: this.storageStats(name) };
    }

    static verifyAllStorage() {
        const out = {};
        for (const name of this.listCollections()) out[name] = this.verifyStorage(name);
        return out;
    }

    static shutdown() {
        Logger.info("Database", "Shutdown requested");
        if (this.#saveWorkerId !== null) RuntimeHandleRegistry.clear(this.#saveWorkerId);
        this.#saveWorkerId = null;
        this.#isSaving = false;
        this.#jobSavingCollection = null;
        this.saveAll(true); // Force sync save on shutdown
        for (const id of this.#intervals) RuntimeHandleRegistry.clear(id);
        this.#intervals.clear();
        this.#collections.clear();
        this.#pending.clear();  // Phase 2: clear pending lazy registrations
        // Phase 4 Fix: Clear save coordination state.
        this.#syncSaving.clear();
        this.#jobSavingCollection = null;
        this.#isSaving = false;
        this.#transactionStack = [];
        this.#saveQueue.clear();
        this.#saveWorkerId = null;
        this.#saveQueueMetrics = { requested: 0, coalesced: 0, completed: 0, failed: 0, skipped: 0, maxDepth: 0, lastDrainAt: 0 };
        this.#readDiagnostics.clear();
        this.#migrationDiagnostics.clear();
        this.#refreshHandlers.clear();
        this.#catalog = null;
        this.#catalogStatus = "uninitialized";
        this.#runtimeMode = "NORMAL";
        this.#internalWriteDepth = 0;
        this.#transactionMetrics = {
            attempted: 0, committed: 0, noChange: 0, rolledBack: 0,
            rejectedAsync: 0, rejectedGenerator: 0, rejectedNested: 0,
            directMutations: 0
        };
        this.#initialized = false;
        Logger.info("Database", "Shutdown complete");
    }

    static #validate(data, defaultData, validator) {
        if (!data || typeof data !== "object") return this.#clone(defaultData);
        let result;
        if (typeof validator === "function") {
            try { result = validator(data, this.#clone(defaultData)); }
            catch (error) { Logger.warn("Database", "Validator failed; using default", error); return this.#clone(defaultData); }
        } else {
            result = data;
        }
        // Phase 5: run schema migrations on the validated data. This is
        // idempotent — if data is already at the latest version, migrate()
        // is a no-op.
        try {
            // The validator may have been called with the collection name
            // unavailable here, so we use a generic migrate call. Each
            // collection's validator wraps migrate() if it wants collection-
            // specific migrations. For collections without a validator, we
            // skip migration entirely (their data shape is unstructured).
            // The collection() method passes the name via a closure when
            // needed — see #validateWithName below.
            return result;
        } catch (error) {
            Logger.warn("Database", "Migration failed; using validated data as-is", error);
            return result;
        }
    }

    /** Phase 2.4 pipeline: clone raw -> migrate atomically -> validate latest shape. */
    static #validateWithName(name, data, defaultData, validator) {
        if (!data || typeof data !== "object" || Array.isArray(data)) {
            const error = new Error(`Collection '${name}' source is not a plain object.`);
            error.code = "DB_INVALID_SOURCE_SHAPE";
            throw error;
        }
        const migration = Migrations.migrateWithReport(name, data);
        this.#migrationDiagnostics.set(name, migration.report);
        if (!migration.success) {
            const error = new Error(`Migration failed for '${name}': ${migration.report.error}`);
            error.code = migration.report.errorCode || "DB_MIGRATION_FAILED";
            error.migrationReport = migration.report;
            throw error;
        }

        let normalized;
        try {
            normalized = typeof validator === "function"
                ? validator(migration.data, this.#clone(defaultData))
                : this.#clone(migration.data);
        } catch (cause) {
            const error = new Error(`Latest-schema validator failed for '${name}': ${cause?.message || cause}`);
            error.code = "DB_VALIDATION_FAILED";
            error.cause = cause;
            throw error;
        }
        if (!normalized || typeof normalized !== "object" || Array.isArray(normalized)) {
            const error = new Error(`Validator for '${name}' returned a non-object result.`);
            error.code = "DB_VALIDATION_RESULT_INVALID";
            throw error;
        }
        // Validators may reconstruct defaults and omit schemaVersion. The
        // Database pipeline is authoritative for version preservation.
        normalized.schemaVersion = Math.max(1, Math.floor(Number(migration.data.schemaVersion) || Migrations.latestVersion(name)));
        return normalized;
    }

    static #trackingProxy(name, target, onMutation = null, rootTarget = target) {
        if (!target || typeof target !== "object") return target;
        const existing = this.#proxyTargets.get(target);
        if (existing?.proxy) return existing.proxy;

        const assertWritable = () => {
            if (typeof onMutation === "function") return;
            const col = this.#collections.get(name);
            if (this.#runtimeMode !== "NORMAL" && this.#internalWriteDepth === 0) {
                const error = new Error(`Database writes are blocked while mode=${this.#runtimeMode}.`);
                error.code = "DB_MAINTENANCE";
                throw error;
            }
            if (col?.status === "quarantined") {
                const error = new Error(`Collection '${name}' is quarantined and cannot be mutated.`);
                error.code = "DB_COLLECTION_QUARANTINED";
                throw error;
            }
            if (col && col.rawData !== rootTarget) {
                const error = new Error(`Stale mutable proxy for '${name}' cannot be changed after a transaction replaced the collection root.`);
                error.code = "DB_STALE_PROXY";
                throw error;
            }
            if (this.#transactionStack.includes(name)) {
                const error = new Error(`Live mutation of '${name}' attempted during its active transaction.`);
                error.code = "DB_LIVE_MUTATION_DURING_TX";
                throw error;
            }
        };
        const notify = () => {
            if (typeof onMutation === "function") onMutation();
            else this.#recordMutation(name, "proxy");
        };
        const handler = {
            get: (obj, prop, receiver) => {
                const value = Reflect.get(obj, prop, receiver);
                if (value && typeof value === "object") return this.#trackingProxy(name, value, onMutation, rootTarget);
                return value;
            },
            set: (obj, prop, value) => {
                const raw = this.#unwrap(value);
                const changed = obj[prop] !== raw;
                if (changed) assertWritable();
                // Use the raw target as receiver so an explicit defineProperty
                // trap cannot double-count a normal assignment.
                const ok = Reflect.set(obj, prop, raw, obj);
                if (ok && changed) notify();
                return ok;
            },
            defineProperty: (obj, prop, descriptor) => {
                const previous = Object.getOwnPropertyDescriptor(obj, prop);
                const next = { ...descriptor };
                if (Object.prototype.hasOwnProperty.call(next, "value")) next.value = this.#unwrap(next.value);
                const changed = !previous || previous.value !== next.value || previous.writable !== next.writable
                    || previous.enumerable !== next.enumerable || previous.configurable !== next.configurable;
                if (changed) assertWritable();
                const ok = Reflect.defineProperty(obj, prop, next);
                if (ok && changed) notify();
                return ok;
            },
            deleteProperty: (obj, prop) => {
                const existed = Object.prototype.hasOwnProperty.call(obj, prop);
                if (existed) assertWritable();
                const ok = Reflect.deleteProperty(obj, prop);
                if (ok && existed) notify();
                return ok;
            }
        };

        const proxy = new Proxy(target, handler);
        this.#proxyTargets.set(target, { proxy, onMutation, rootTarget });
        this.#proxyTargets.set(proxy, { target, proxy, onMutation, rootTarget });
        return proxy;
    }

    static #unwrap(value) {
        if (value && typeof value === "object") {
            const meta = this.#proxyTargets.get(value);
            if (meta?.target) return meta.target;
        }
        return value;
    }

    static #readString(key) {
        const active = this.#activeSlot(key);
        const attempts = [];
        const attempt = (label, baseKey) => {
            try {
                const value = this.#readStringFromBase(baseKey);
                if (typeof value !== "string") throw new Error("No string payload");
                const meta = this.#chunkMeta(baseKey) || {};
                attempts.push({ label, ok: true, length: value.length, revision: Number(meta.revision) || 0 });
                return { value, meta };
            } catch (error) {
                attempts.push({ label, ok: false, error: String(error?.message || error).substring(0, 300) });
                return null;
            }
        };

        if (active) {
            const primary = attempt(`slot_${active}`, this.#slotBase(key, active));
            if (primary) {
                this.#readDiagnostics.set(key, { source: `slot_${active}`, degraded: false, revision: Number(primary.meta.revision) || 0, attempts });
                return primary.value;
            }
            const other = this.#inactiveSlot(active);
            const fallback = attempt(`slot_${other}`, this.#slotBase(key, other));
            if (fallback) {
                Logger.warn("Database", `Active slot '${active}' failed for ${key}; loaded verified fallback '${other}'`);
                this.#readDiagnostics.set(key, { source: `slot_${other}`, degraded: true, revision: Number(fallback.meta.revision) || 0, attempts });
                return fallback.value;
            }
        }

        const legacy = attempt("legacy", key);
        if (legacy) {
            this.#readDiagnostics.set(key, { source: "legacy", degraded: !!active, revision: Number(legacy.meta.revision) || 0, attempts });
            return legacy.value;
        }

        // A completely new collection has no payload anywhere. That is not corruption.
        const anyStorage = !!active || attempts.some(item => item.error !== "No string payload");
        if (!anyStorage) {
            this.#readDiagnostics.set(key, { source: "none", degraded: false, revision: 0, attempts });
            return undefined;
        }

        this.#readDiagnostics.set(key, { source: "none", degraded: true, revision: 0, attempts });
        throw new Error(`No verified storage candidate for ${key}: ${attempts.map(a => `${a.label}=${a.error || "invalid"}`).join("; ")}`);
    }

    static #readStringFromBase(baseKey) {
        let meta = null;
        const metaRaw = world.getDynamicProperty(baseKey + ":__meta");
        if (metaRaw !== undefined) {
            if (typeof metaRaw !== "string") throw new Error(`Metadata for ${baseKey} is not a string`);
            try { meta = JSON.parse(metaRaw); }
            catch (error) { throw new Error(`Invalid metadata JSON for ${baseKey}: ${error?.message || error}`); }
        }
        let value;
        if (meta?.chunked) {
            if (!Number.isInteger(meta.chunks) || meta.chunks <= 0) throw new Error(`Invalid chunk count for ${baseKey}`);
            let out = "";
            for (let i = 0; i < meta.chunks; i++) {
                const part = world.getDynamicProperty(`${baseKey}:__chunk:${i}`);
                if (typeof part !== "string") throw new Error(`Missing chunk ${i}`);
                out += part;
            }
            value = out;
        } else {
            value = world.getDynamicProperty(baseKey);
        }
        if (value === undefined) return undefined;
        if (typeof value !== "string") throw new Error(`Payload for ${baseKey} is not a string`);

        if (Number.isInteger(meta?.length) && value.length !== meta.length) {
            throw new Error(`Length mismatch ${value.length} != ${meta.length}`);
        }
        if (meta?.formatVersion >= 2) {
            if (meta.complete !== true) throw new Error("Slot metadata is not marked complete");
            const actual = this.#checksum(value);
            if (meta.checksum !== actual) throw new Error(`Checksum mismatch ${actual} != ${meta.checksum}`);
        }
        // Collections are JSON documents. Parse verification here enables
        // active-slot fallback even when length/checksum metadata looks valid.
        try { JSON.parse(value); }
        catch (error) { throw new Error(`Invalid JSON payload: ${error?.message || error}`); }
        return value;
    }

    static #activeSlot(key) {
        try {
            const v = world.getDynamicProperty(key + ":__active");
            return v === "a" || v === "b" ? v : null;
        } catch { return null; }
    }

    static #slotBase(key, slot) { return `${key}:__slot:${slot}`; }
    static #inactiveSlot(active) { return active === "a" ? "b" : "a"; }

    // Synchronous write (explicit/critical flush and shutdown).
    static #writeStringSync(key, value, context = {}) {
        const active = this.#activeSlot(key);
        const target = active ? this.#inactiveSlot(active) : "a";
        const targetBase = this.#slotBase(key, target);
        this.#writeStringToBaseSync(targetBase, value, context);
        this.#verifyWrittenBase(targetBase, value, context);
        // Single commit point: readers switch only after the inactive slot is verified.
        world.setDynamicProperty(key + ":__active", target);
        this.#clearLegacyStorage(key);
    }

    static #slotMetadata(value, context, chunked, chunks) {
        return {
            formatVersion: 2,
            complete: true,
            slotStorage: true,
            chunked: !!chunked,
            chunks: chunked ? chunks : 0,
            length: value.length,
            checksum: this.#checksum(value),
            revision: Math.max(0, Math.floor(Number(context.revision) || 0)),
            schemaVersion: Math.max(1, Math.floor(Number(context.schemaVersion) || 1)),
            updatedAt: Date.now()
        };
    }

    static #writeStringToBaseSync(baseKey, value, context = {}) {
        const chunkSize = Math.max(1024, Math.floor(this.#config.DYNAMIC_PROPERTY_CHUNK_SIZE || 30000));
        const oldMeta = this.#chunkMeta(baseKey);
        if (value.length <= chunkSize) {
            world.setDynamicProperty(baseKey, value);
            this.#clearChunks(baseKey, oldMeta?.chunks || 0);
            world.setDynamicProperty(baseKey + ":__meta", JSON.stringify(this.#slotMetadata(value, context, false, 0)));
            return;
        }

        const chunks = [];
        for (let i = 0; i < value.length; i += chunkSize) chunks.push(value.slice(i, i + chunkSize));
        for (let i = 0; i < chunks.length; i++) world.setDynamicProperty(`${baseKey}:__chunk:${i}`, chunks[i]);
        this.#clearChunks(baseKey, oldMeta?.chunks || 0, chunks.length);
        world.setDynamicProperty(baseKey, undefined);
        world.setDynamicProperty(baseKey + ":__meta", JSON.stringify(this.#slotMetadata(value, context, true, chunks.length)));
    }

    static *#writeStringJob(key, value, context = {}) {
        const active = this.#activeSlot(key);
        const target = active ? this.#inactiveSlot(active) : "a";
        const targetBase = this.#slotBase(key, target);
        yield* this.#writeStringToBaseJob(targetBase, value, context);
        this.#verifyWrittenBase(targetBase, value, context);
        world.setDynamicProperty(key + ":__active", target);
        yield;
        this.#clearLegacyStorage(key);
    }

    static *#writeStringToBaseJob(baseKey, value, context = {}) {
        const chunkSize = Math.max(1024, Math.floor(this.#config.DYNAMIC_PROPERTY_CHUNK_SIZE || 30000));
        const oldMeta = this.#chunkMeta(baseKey);
        if (value.length <= chunkSize) {
            world.setDynamicProperty(baseKey, value);
            this.#clearChunks(baseKey, oldMeta?.chunks || 0);
            world.setDynamicProperty(baseKey + ":__meta", JSON.stringify(this.#slotMetadata(value, context, false, 0)));
            yield;
            return;
        }

        const chunks = [];
        for (let i = 0; i < value.length; i += chunkSize) chunks.push(value.slice(i, i + chunkSize));
        for (let i = 0; i < chunks.length; i++) {
            world.setDynamicProperty(`${baseKey}:__chunk:${i}`, chunks[i]);
            if (i % 5 === 0) yield;
        }
        this.#clearChunks(baseKey, oldMeta?.chunks || 0, chunks.length);
        yield;
        world.setDynamicProperty(baseKey, undefined);
        world.setDynamicProperty(baseKey + ":__meta", JSON.stringify(this.#slotMetadata(value, context, true, chunks.length)));
    }

    static #verifyWrittenBase(baseKey, expectedValue, context = {}) {
        const actual = this.#readStringFromBase(baseKey);
        if (actual !== expectedValue) throw new Error(`Post-write payload mismatch for ${baseKey}`);
        const meta = this.#chunkMeta(baseKey);
        if (!meta || meta.formatVersion !== 2 || meta.complete !== true) throw new Error(`Post-write metadata verification failed for ${baseKey}`);
        if (meta.checksum !== this.#checksum(expectedValue)) throw new Error(`Post-write checksum verification failed for ${baseKey}`);
        const expectedRevision = Math.max(0, Math.floor(Number(context.revision) || 0));
        if ((Number(meta.revision) || 0) !== expectedRevision) throw new Error(`Post-write revision mismatch for ${baseKey}`);
        return true;
    }

    static #chunkMeta(baseKey) {
        try {
            const raw = world.getDynamicProperty(baseKey + ":__meta");
            return typeof raw === "string" ? JSON.parse(raw) : null;
        } catch { return null; }
    }

    static #storageBaseStats(baseKey) {
        const meta = this.#chunkMeta(baseKey);
        const direct = (() => { try { const v = world.getDynamicProperty(baseKey); return typeof v === "string" ? v.length : 0; } catch { return 0; } })();
        let readable = false, length = direct, error = "";
        try {
            const raw = this.#readStringFromBase(baseKey);
            readable = typeof raw === "string";
            length = readable ? raw.length : length;
        } catch (e) { error = e?.message || String(e); }
        return {
            baseKey,
            exists: !!meta || direct > 0,
            readable,
            directLength: direct,
            formatVersion: meta?.formatVersion || 1,
            complete: meta?.complete !== false,
            revision: Number(meta?.revision) || 0,
            checksum: meta?.checksum || "",
            chunked: !!meta?.chunked,
            chunks: meta?.chunks || 0,
            metaLength: meta?.length || 0,
            length,
            error
        };
    }

    static #storageBaseReadable(baseKey) {
        try { return typeof this.#readStringFromBase(baseKey) === "string"; }
        catch { return false; }
    }

    static #clearChunks(baseKey, oldCount = 0, keepFrom = 0) {
        for (let i = keepFrom; i < oldCount; i++) {
            try { world.setDynamicProperty(`${baseKey}:__chunk:${i}`, undefined); } catch (error) {
                Logger.debug("Database", `Failed to clear chunk ${i} for ${baseKey}`, error);
            }
        }
    }

    static #clearLegacyStorage(key) {
        try {
            const meta = this.#chunkMeta(key);
            world.setDynamicProperty(key, undefined);
            world.setDynamicProperty(key + ":__meta", undefined);
            this.#clearChunks(key, meta?.chunks || 0);
        } catch (error) { Logger.debug("Database", `Failed to clear legacy storage for ${key}`, error); }
    }

    static #clearSlotStorage(key, slot) {
        const base = this.#slotBase(key, slot);
        try {
            const meta = this.#chunkMeta(base);
            world.setDynamicProperty(base, undefined);
            world.setDynamicProperty(base + ":__meta", undefined);
            this.#clearChunks(base, meta?.chunks || 0);
        } catch (error) { Logger.debug("Database", `Failed to clear slot ${slot} for ${key}`, error); }
    }

    static #clearAllStorage(key) {
        this.#clearLegacyStorage(key);
        this.#clearSlotStorage(key, "a");
        this.#clearSlotStorage(key, "b");
        try { world.setDynamicProperty(key + ":__active", undefined); } catch {}
    }

    static #checksum(value) {
        if (!this.#crcTable) {
            this.#crcTable = new Uint32Array(256);
            for (let n = 0; n < 256; n++) {
                let c = n;
                for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
                this.#crcTable[n] = c >>> 0;
            }
        }
        let crc = 0xFFFFFFFF;
        const text = String(value);
        for (let i = 0; i < text.length; i++) {
            const code = text.charCodeAt(i);
            crc = this.#crcTable[(crc ^ (code & 0xFF)) & 0xFF] ^ (crc >>> 8);
            crc = this.#crcTable[(crc ^ ((code >>> 8) & 0xFF)) & 0xFF] ^ (crc >>> 8);
        }
        return `crc32u16:${((crc ^ 0xFFFFFFFF) >>> 0).toString(16).padStart(8, "0")}`;
    }

    static #clone(obj) {
        if (obj === undefined || obj === null) return obj;
        // Phase 2 Performance: prefer structuredClone when available — it's
        // significantly faster than JSON.parse(JSON.stringify(...)) for large
        // objects because it skips the string serialization round-trip.
        // It also preserves types that JSON cannot (Date, RegExp, etc.),
        // though we don't currently use any of those in our DB shape.
        //
        // Falls back to JSON round-trip for environments without structuredClone
        // (e.g., older Bedrock script runtimes).
        if (typeof globalThis.structuredClone === "function") {
            try { return globalThis.structuredClone(obj); } catch (error) {
                Logger.debug("Database", "structuredClone failed, falling back to JSON", error);
            }
        }
        return JSON.parse(JSON.stringify(obj));
    }

    static #estimate(obj) {
        try { return JSON.stringify(obj).length; } catch { return 0; }
    }

    static #count(obj) {
        if (!obj || typeof obj !== "object") return obj ? 1 : 0;
        if (Array.isArray(obj)) return obj.length;
        return Object.keys(obj).length;
    }
}

export default Database;
