// MCity Dashboard V2 - Durable Operation Journal and Outbox
// Phase 3.2: shardable, durable, recoverable cross-collection operation core.

import { CONFIG } from "../config.js";
import { Database } from "./database.js";
import { Logger } from "./logger.js";
import { ShardUtils } from "./shardUtils.js";
import { RuntimeHandleRegistry } from "./runtimeHandleRegistry.js";
import { DisposableRegistry } from "./disposableRegistry.js";
import { AppliedOperationStore } from "./appliedOperationStore.js";
import {
    DEFAULT_OPERATION_JOURNAL_DB,
    DEFAULT_OPERATION_JOURNAL_CATALOG_DB,
    validateOperationJournalData,
    validateOperationJournalCatalog,
    sanitizeOperation,
    isTerminalOperationStatus
} from "../schemas/operationJournalSchema.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const ALGORITHM = ShardUtils.HASH_ALGORITHM;
const TRANSITIONS = {
    created: new Set(["validated", "retry_scheduled", "cancelled", "dead_letter"]),
    validated: new Set(["debit_applied", "inventory_reserved", "obligation_persisted", "credit_applied", "delivery_applied", "accounting_applied", "completed", "retry_scheduled", "cancelled", "dead_letter"]),
    debit_applied: new Set(["obligation_persisted", "credit_applied", "accounting_applied", "completed", "retry_scheduled", "cancelled", "dead_letter"]),
    inventory_reserved: new Set(["obligation_persisted", "delivery_applied", "accounting_applied", "completed", "retry_scheduled", "cancelled", "dead_letter"]),
    obligation_persisted: new Set(["credit_applied", "delivery_applied", "accounting_applied", "completed", "retry_scheduled", "cancelled", "dead_letter"]),
    credit_applied: new Set(["accounting_applied", "completed", "retry_scheduled", "cancelled", "dead_letter"]),
    delivery_applied: new Set(["accounting_applied", "completed", "retry_scheduled", "cancelled", "dead_letter"]),
    accounting_applied: new Set(["completed", "retry_scheduled", "cancelled", "dead_letter"]),
    retry_scheduled: new Set(["created", "validated", "debit_applied", "inventory_reserved", "obligation_persisted", "credit_applied", "delivery_applied", "accounting_applied", "cancelled", "dead_letter"]),
    dead_letter: new Set(["retry_scheduled", "cancelled"]),
    completed: new Set(),
    cancelled: new Set()
};

function clone(value) {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
}
function text(value, max = 120) { return String(value || "").replace(/[\u0000-\u001f\u007f]/g, "").substring(0, max); }
function now() { return Date.now(); }
function isPromise(value) { return !!value && typeof value.then === "function"; }
function isGenerator(value) { return !!value && typeof value.next === "function" && typeof value.throw === "function"; }

export class OperationJournalService {
    static #initialized = false;
    static #intervalId = null;
    static #handlers = new Map();
    static #recovering = false;
    static #routing = null;
    static #routingError = "";
    static #shardCursor = 0;
    static #idCounter = 0;
    static #metricsCache = { at: 0, value: null };

    static config() {
        const configured = CONFIG.OPERATION_JOURNAL || {};
        const shardConfig = CONFIG.DATABASE?.SHARDING?.MODULES?.OPERATION_JOURNALS || {};
        return {
            catalog: text(configured.CATALOG_COLLECTION || "operation_journal_catalog", 64),
            base: text(shardConfig.BASE || configured.BASE || "operation_journals", 64),
            shardCount: ShardUtils.clampCount(shardConfig.SHARD_COUNT || configured.SHARD_COUNT || 8, 8),
            recoveryIntervalTicks: Math.max(20, Math.floor(Number(configured.RECOVERY_INTERVAL_TICKS) || 100)),
            recoveryBatch: Math.max(1, Math.min(100, Math.floor(Number(configured.RECOVERY_BATCH_SIZE) || 25))),
            maxAttempts: Math.max(1, Math.min(100, Math.floor(Number(configured.MAX_ATTEMPTS) || 8))),
            retryBaseMs: Math.max(100, Math.floor(Number(configured.RETRY_BASE_MS) || 5_000)),
            retryMaxMs: Math.max(1_000, Math.floor(Number(configured.RETRY_MAX_MS) || 10 * 60_000)),
            terminalRetentionMs: Math.max(DAY_MS, Math.floor(Number(configured.TERMINAL_RETENTION_DAYS) || 30) * DAY_MS),
            softShardLimitBytes: Math.max(100_000, Math.min(950_000, Math.floor(Number(configured.SOFT_SHARD_LIMIT_BYTES) || 850_000))),
            maxPayloadBytes: Math.max(1_000, Math.min(100_000, Math.floor(Number(configured.MAX_PAYLOAD_BYTES) || 16_000))),
            pruneBatch: Math.max(1, Math.min(200, Math.floor(Number(configured.PRUNE_BATCH_SIZE) || 25)))
        };
    }

    static initialize() {
        if (this.#initialized) return this.routingStatus();
        this.#initialized = true;
        const cfg = this.config();
        Database.setSavePriority(cfg.catalog, 0);
        const catalog = Database.collection(cfg.catalog, DEFAULT_OPERATION_JOURNAL_CATALOG_DB, { validate: validateOperationJournalCatalog });
        const existing = catalog.routing || {};
        if (existing.locked) {
            if (existing.base !== cfg.base || existing.shardCount !== cfg.shardCount || existing.algorithm !== ALGORITHM) {
                this.#routingError = `Locked operation routing is ${existing.base}/${existing.shardCount}/${existing.algorithm}; configured ${cfg.base}/${cfg.shardCount}/${ALGORITHM}`;
                this.#routing = clone(existing);
                Logger.error("OperationJournal", this.#routingError);
            } else {
                this.#routing = clone(existing);
                this.#routingError = "";
            }
        } else {
            const tx = Database.transaction(cfg.catalog, data => {
                data.routing = { enabled: true, base: cfg.base, shardCount: cfg.shardCount, algorithm: ALGORITHM, locked: true, lockedAt: now() };
                data.stats.lastUpdated = now();
                return data.routing;
            });
            if (!tx.success) {
                this.#routingError = tx.error || "Failed to lock operation routing";
                this.#routing = { enabled: true, base: cfg.base, shardCount: cfg.shardCount, algorithm: ALGORITHM, locked: false };
            } else {
                const flush = Database.flushCritical(cfg.catalog, "operation_routing_lock");
                if (!flush.ok) this.#routingError = "Failed to durably persist operation routing lock";
                this.#routing = clone(tx.result);
            }
        }
        for (const name of this.allShardCollections()) {
            Database.setSavePriority(name, 1);
            Database.collection(name, DEFAULT_OPERATION_JOURNAL_DB, { validate: validateOperationJournalData });
        }
        Database.registerRefreshHandler("OperationJournalService", () => this.refreshRouting());
        this.#intervalId = RuntimeHandleRegistry.interval("OperationJournal.recovery", () => {
            try { this.runRecoveryBatch(); } catch (error) { Logger.warn("OperationJournal", "Recovery interval failed", error); }
        }, cfg.recoveryIntervalTicks);
        DisposableRegistry.registerShutdownCleanup("OperationJournalService.lifecycle", () => this.shutdown());
        Logger.startup("OperationJournal", `Initialized (${this.#routing?.shardCount || cfg.shardCount} shards${this.#routingError ? ", routing error" : ""})`);
        return this.routingStatus();
    }

    static shutdown() {
        if (this.#intervalId !== null) RuntimeHandleRegistry.clear(this.#intervalId);
        this.#intervalId = null;
        this.#recovering = false;
        this.#routing = null;
        this.#routingError = "";
        this.#shardCursor = 0;
        this.#metricsCache = { at: 0, value: null };
        Database.unregisterRefreshHandler("OperationJournalService");
        this.#initialized = false;
    }

    static refreshRouting() {
        const cfg = this.config();
        const catalog = Database.collection(cfg.catalog, DEFAULT_OPERATION_JOURNAL_CATALOG_DB, { validate: validateOperationJournalCatalog });
        const routing = catalog.routing || {};
        this.#routing = clone(routing);
        this.#routingError = !routing.locked || routing.base !== cfg.base || routing.shardCount !== cfg.shardCount || routing.algorithm !== ALGORITHM
            ? `Operation routing mismatch after refresh (${routing.base}/${routing.shardCount}/${routing.algorithm})`
            : "";
        this.#shardCursor = 0;
        this.#metricsCache = { at: 0, value: null };
        return { success: !this.#routingError, routing: clone(this.#routing), error: this.#routingError };
    }

    static registerHandler(operationType, handler) {
        const type = text(operationType, 80);
        if (!type || !handler || typeof handler.recover !== "function") return false;
        this.#handlers.set(type, handler);
        return true;
    }
    static unregisterHandler(operationType) { return this.#handlers.delete(text(operationType, 80)); }

    static routingStatus() {
        if (!this.#initialized) this.initialize();
        return { ...(clone(this.#routing) || {}), error: this.#routingError, healthy: !this.#routingError };
    }

    static allShardCollections() {
        const routing = this.#routing || { base: this.config().base, shardCount: this.config().shardCount };
        return ShardUtils.allHashShardNames(routing.base, routing.shardCount);
    }

    static collectionFor(operationId) {
        const routing = this.#routing || { base: this.config().base, shardCount: this.config().shardCount };
        return ShardUtils.hashShardName(routing.base, text(operationId), routing.shardCount);
    }

    static dbFor(operationId) {
        const name = this.collectionFor(operationId);
        return Database.collection(name, DEFAULT_OPERATION_JOURNAL_DB, { validate: validateOperationJournalData });
    }

    static newId(prefix = "op") {
        this.#idCounter = (this.#idCounter + 1) % 1_000_000;
        const safe = text(prefix, 24).replace(/[^a-zA-Z0-9_]/g, "_") || "op";
        return `${safe}_${now().toString(36)}_${this.#idCounter.toString(36)}_${Math.floor(Math.random() * 0xffffff).toString(36)}`;
    }

    static #writeGate() {
        if (!this.#initialized) this.initialize();
        if (this.#routingError) return { ok: false, error: this.#routingError, code: "OP_ROUTING_MISMATCH" };
        const runtime = Database.runtimeStatus();
        if (runtime.mode !== "NORMAL") return { ok: false, error: `Database mode ${runtime.mode} rejects operation writes`, code: "OP_DATABASE_MODE" };
        return { ok: true };
    }

    static create(operationType, input = {}, options = {}) {
        const gate = this.#writeGate();
        if (!gate.ok) return { success: false, ...gate };
        const cfg = this.config();
        const operationId = text(options.operationId || input.operationId || this.newId(operationType), 120);
        const type = text(operationType || input.operationType, 80);
        if (!operationId || !type) return { success: false, code: "OP_INVALID_ID", error: "operationId and operationType are required" };
        let payloadBytes = 0;
        try { payloadBytes = JSON.stringify({ payload: input.payload || {}, itemPayload: input.itemPayload || {} }).length; }
        catch { return { success: false, code: "OP_PAYLOAD_SERIALIZATION", error: "Operation payload is not serializable" }; }
        if (payloadBytes > cfg.maxPayloadBytes) return { success: false, code: "OP_PAYLOAD_TOO_LARGE", error: `Operation payload ${payloadBytes} exceeds ${cfg.maxPayloadBytes}` };

        const collection = this.collectionFor(operationId);
        this.dbFor(operationId);
        const currentSize = Database.stats(collection)?.size || 0;
        if (currentSize + payloadBytes + 2_000 > cfg.softShardLimitBytes) {
            return { success: false, code: "OP_SHARD_SOFT_LIMIT", error: `Operation shard ${collection} is near its safe storage limit` };
        }

        const timestamp = now();
        const candidate = sanitizeOperation({
            operationId,
            operationType: type,
            status: options.status || input.status || "created",
            resumeStatus: options.resumeStatus || input.resumeStatus || "created",
            actorId: input.actorId,
            actorName: input.actorName,
            targetId: input.targetId,
            targetName: input.targetName,
            amount: input.amount,
            itemPayload: input.itemPayload,
            payload: input.payload,
            steps: input.steps,
            attempts: input.attempts,
            maxAttempts: input.maxAttempts || options.maxAttempts || cfg.maxAttempts,
            nextAttemptAt: input.nextAttemptAt,
            createdAt: input.createdAt || timestamp,
            updatedAt: input.updatedAt || timestamp,
            terminalAt: input.terminalAt,
            transitionSeq: input.transitionSeq,
            lastError: input.lastError,
            markerRequirements: input.markerRequirements,
            markerCleanup: input.markerCleanup,
            legacy: input.legacy
        }, operationId);
        if (!candidate) return { success: false, code: "OP_INVALID", error: "Operation is invalid" };
        let created = false;
        const tx = Database.transaction(collection, data => {
            const existing = data.operations[operationId];
            if (existing) {
                if (existing.operationType !== type) throw Object.assign(new Error("operationId already exists with a different type"), { code: "OP_ID_CONFLICT" });
                return { operation: existing, created: false };
            }
            data.operations[operationId] = candidate;
            if (isTerminalOperationStatus(candidate.status)) {
                data.terminalOrder = (data.terminalOrder || []).filter(id => id !== operationId);
                data.terminalOrder.push(operationId);
            } else {
                data.activeOrder = (data.activeOrder || []).filter(id => id !== operationId);
                data.activeOrder.push(operationId);
                data.outbox[operationId] = {
                    operationId,
                    state: candidate.status === "dead_letter" ? "dead_letter" : candidate.status === "retry_scheduled" ? "retry_scheduled" : "queued",
                    nextAttemptAt: candidate.nextAttemptAt || 0,
                    attempts: candidate.attempts || 0,
                    updatedAt: timestamp,
                    lastError: candidate.lastError || ""
                };
            }
            data.stats.totalCreated = (data.stats.totalCreated || 0) + 1;
            data.stats.lastUpdated = timestamp;
            created = true;
            return { operation: candidate, created: true };
        });
        if (!tx.success) return { success: false, code: tx.errorCode || "OP_CREATE_FAILED", error: tx.error };
        const flush = Database.flushCritical(collection, "operation_create_before_effect");
        if (!flush.ok) {
            this.#recordFlushFailure(collection);
            if (created) {
                Database.transaction(collection, data => {
                    delete data.operations[operationId]; delete data.outbox[operationId];
                    data.activeOrder = (data.activeOrder || []).filter(id => id !== operationId);
                    data.terminalOrder = (data.terminalOrder || []).filter(id => id !== operationId);
                    data.stats.totalCreated = Math.max(0, (data.stats.totalCreated || 1) - 1);
                    data.stats.lastUpdated = now();
                });
            }
            return { success: false, code: "OP_JOURNAL_FLUSH_FAILED", error: "Operation journal could not be durably persisted", operationId };
        }
        this.#metricsCache.at = 0;
        return { success: true, operationId, operation: clone(tx.result.operation), created: tx.result.created, collection };
    }

    static importLegacy(operationType, input = {}, options = {}) {
        const result = this.create(operationType, input, { ...options, operationId: options.operationId || input.operationId, status: input.status || options.status || "created" });
        if (result.success && result.created) this.#updateCatalogLegacy(1);
        return result;
    }

    static operation(operationId) {
        const id = text(operationId, 120);
        if (!id) return null;
        const op = this.dbFor(id).operations?.[id];
        return op ? clone(op) : null;
    }

    static operationCollections() { return [...this.allShardCollections()]; }

    static inspectOperations(collectionName, offset = 0, limit = 50) {
        const name = text(collectionName, 100);
        if (!this.allShardCollections().includes(name)) return { collection: name, total: 0, offset: 0, operations: [], error: "Unknown operation shard" };
        const db = Database.collection(name, DEFAULT_OPERATION_JOURNAL_DB, { validate: validateOperationJournalData });
        const ids = [...new Set([...(db.activeOrder || []), ...(db.terminalOrder || []), ...Object.keys(db.operations || {})])].filter(id => db.operations[id]);
        const start = Math.max(0, Math.floor(Number(offset) || 0));
        const count = Math.max(1, Math.min(200, Math.floor(Number(limit) || 50)));
        return { collection: name, total: ids.length, offset: start, operations: ids.slice(start, start + count).map(id => clone(db.operations[id])) };
    }

    static transition(operationId, status, options = {}) {
        const gate = this.#writeGate();
        if (!gate.ok) return { success: false, ...gate };
        const id = text(operationId, 120);
        const next = text(status, 32);
        const collection = this.collectionFor(id);
        this.dbFor(id);
        const timestamp = now();
        const tx = Database.transaction(collection, data => {
            const op = data.operations[id];
            if (!op) throw Object.assign(new Error("Operation not found"), { code: "OP_NOT_FOUND" });
            const changedStatus = op.status !== next;
            if (changedStatus) {
                const allowed = TRANSITIONS[op.status];
                if (!allowed?.has(next)) throw Object.assign(new Error(`Invalid operation transition ${op.status} -> ${next}`), { code: "OP_INVALID_TRANSITION" });
                if (next === "retry_scheduled") op.resumeStatus = op.status;
                op.status = next;
                op.transitionSeq = (op.transitionSeq || 0) + 1;
            }
            op.updatedAt = timestamp;
            if (options.error !== undefined) op.lastError = text(options.error, 500);
            if (options.nextAttemptAt !== undefined) op.nextAttemptAt = Math.max(0, Math.floor(Number(options.nextAttemptAt) || 0));
            if (options.step) {
                const step = text(options.step, 48);
                op.steps[step] = {
                    status: text(options.stepStatus || next, 32),
                    attempts: Math.max(0, Math.floor(Number(op.steps?.[step]?.attempts) || 0)) + (options.incrementStepAttempt ? 1 : 0),
                    updatedAt: timestamp,
                    lastError: text(options.error, 500)
                };
            }
            if (isTerminalOperationStatus(next)) {
                op.terminalAt = op.terminalAt || timestamp;
                delete data.outbox[id];
                data.activeOrder = (data.activeOrder || []).filter(value => value !== id);
                data.terminalOrder = (data.terminalOrder || []).filter(value => value !== id);
                data.terminalOrder.push(id);
                if (next === "completed" && changedStatus) data.stats.totalCompleted = (data.stats.totalCompleted || 0) + 1;
                if (next === "cancelled" && changedStatus) data.stats.totalCancelled = (data.stats.totalCancelled || 0) + 1;
            } else {
                if (!(data.activeOrder || []).includes(id)) data.activeOrder.push(id);
                const state = next === "dead_letter" ? "dead_letter" : next === "retry_scheduled" ? "retry_scheduled" : "queued";
                data.outbox[id] = { operationId: id, state, nextAttemptAt: op.nextAttemptAt || 0, attempts: op.attempts || 0, updatedAt: timestamp, lastError: op.lastError || "" };
            }
            data.stats.lastUpdated = timestamp;
            return op;
        });
        if (!tx.success) return { success: false, code: tx.errorCode || "OP_TRANSITION_FAILED", error: tx.error };
        const flush = Database.flushCritical(collection, options.reason || `operation_transition_${next}`);
        if (!flush.ok) {
            this.#recordFlushFailure(collection);
            return { success: false, code: "OP_JOURNAL_FLUSH_FAILED", error: `Transition ${next} was not durably flushed`, operation: clone(tx.result) };
        }
        this.#metricsCache.at = 0;
        return { success: true, operation: clone(tx.result), collection };
    }

    static scheduleRetry(operationId, error, options = {}) {
        const id = text(operationId, 120);
        const collection = this.collectionFor(id);
        this.dbFor(id);
        const cfg = this.config();
        let targetStatus = "retry_scheduled";
        let nextAttemptAt = 0;
        const tx = Database.transaction(collection, data => {
            const op = data.operations[id];
            if (!op) throw Object.assign(new Error("Operation not found"), { code: "OP_NOT_FOUND" });
            if (isTerminalOperationStatus(op.status)) return op;
            const resume = op.status === "retry_scheduled" || op.status === "dead_letter" ? (op.resumeStatus || "created") : op.status;
            op.resumeStatus = resume;
            op.attempts = (op.attempts || 0) + 1;
            op.lastError = text(error, 500);
            op.updatedAt = now();
            const maxAttempts = Math.max(1, op.maxAttempts || cfg.maxAttempts);
            if (op.attempts >= maxAttempts || options.retryable === false) {
                targetStatus = "dead_letter";
                op.status = "dead_letter";
                op.nextAttemptAt = 0;
                data.stats.totalDeadLetters = (data.stats.totalDeadLetters || 0) + 1;
            } else {
                const delay = Math.min(cfg.retryMaxMs, cfg.retryBaseMs * (2 ** Math.max(0, op.attempts - 1)));
                nextAttemptAt = now() + delay;
                op.status = "retry_scheduled";
                op.nextAttemptAt = nextAttemptAt;
                data.stats.totalRetries = (data.stats.totalRetries || 0) + 1;
            }
            op.transitionSeq = (op.transitionSeq || 0) + 1;
            data.outbox[id] = { operationId: id, state: targetStatus, nextAttemptAt: op.nextAttemptAt, attempts: op.attempts, updatedAt: op.updatedAt, lastError: op.lastError };
            if (!(data.activeOrder || []).includes(id)) data.activeOrder.push(id);
            data.stats.lastUpdated = now();
            return op;
        });
        if (!tx.success) return { success: false, code: tx.errorCode, error: tx.error };
        const flush = Database.flushCritical(collection, targetStatus === "dead_letter" ? "operation_dead_letter" : "operation_retry_schedule");
        if (!flush.ok) this.#recordFlushFailure(collection);
        this.#metricsCache.at = 0;
        return { success: flush.ok, status: targetStatus, nextAttemptAt, operation: clone(tx.result), error: flush.ok ? "" : "Retry state flush failed" };
    }

    static requeueDeadLetter(operationId) {
        const op = this.operation(operationId);
        if (!op || op.status !== "dead_letter") return { success: false, code: "OP_NOT_DEAD_LETTER", error: "Operation is not dead-lettered" };
        const id = op.operationId;
        const collection = this.collectionFor(id);
        const tx = Database.transaction(collection, data => {
            const current = data.operations[id];
            current.status = "retry_scheduled";
            current.attempts = 0;
            current.nextAttemptAt = now();
            current.updatedAt = now();
            current.lastError = "";
            current.transitionSeq = (current.transitionSeq || 0) + 1;
            data.outbox[id] = { operationId: id, state: "retry_scheduled", nextAttemptAt: current.nextAttemptAt, attempts: 0, updatedAt: current.updatedAt, lastError: "" };
            data.stats.lastUpdated = now();
            return current;
        });
        if (!tx.success) return { success: false, code: tx.errorCode, error: tx.error };
        const flush = Database.flushCritical(collection, "operation_dead_letter_requeue");
        return { success: flush.ok, operation: clone(tx.result), error: flush.ok ? "" : "Requeue flush failed" };
    }

    static applyEffect(operationId, options = {}) {
        const id = text(operationId, 120);
        const operation = this.operation(id);
        if (!operation) return { success: false, code: "OP_NOT_FOUND", error: "Operation not found", safeToCompensate: true };
        if (isTerminalOperationStatus(operation.status)) return { success: operation.status === "completed", terminal: true, operation };
        if (!options.collection || typeof options.mutate !== "function") return { success: false, code: "OP_EFFECT_INVALID", error: "Effect collection and mutate callback are required", safeToCompensate: true };

        if (options.preStatus && operation.status !== options.preStatus) {
            const pre = this.transition(id, options.preStatus, { reason: `operation_before_${text(options.effectId, 48)}` });
            if (!pre.success) return { ...pre, safeToCompensate: true };
        } else {
            const journalFlush = Database.flushCritical(this.collectionFor(id), `operation_before_${text(options.effectId, 48) || "effect"}`);
            if (!journalFlush.ok) {
                this.#recordFlushFailure(this.collectionFor(id));
                return { success: false, code: "OP_JOURNAL_FLUSH_FAILED", error: "Journal flush before effect failed", safeToCompensate: true };
            }
        }

        const collection = text(options.collection, 100);
        const field = text(options.field || AppliedOperationStore.DEFAULT_FIELD, 48);
        const effectId = text(options.effectId || "default", 64) || "default";
        Database.collection(collection, options.defaultData || {}, options.validate ? { validate: options.validate } : undefined);
        let alreadyApplied = false;
        let value;
        const tx = Database.transaction(collection, data => {
            const existing = AppliedOperationStore.get(data, id, effectId, field);
            if (existing) {
                alreadyApplied = true;
                value = clone(existing.value);
                return { alreadyApplied: true, value };
            }
            const output = options.mutate(data, clone(this.operation(id)));
            if (isPromise(output) || isGenerator(output)) throw Object.assign(new Error("Operation effect callbacks must be synchronous"), { code: "OP_ASYNC_EFFECT" });
            value = clone(output);
            AppliedOperationStore.mark(data, id, effectId, { amount: operation.amount, value, status: effectId }, field);
            return { alreadyApplied: false, value };
        });
        if (!tx.success) return { success: false, code: tx.errorCode || "OP_EFFECT_TRANSACTION", error: tx.error, safeToCompensate: true, destinationApplied: false };
        const destinationFlush = Database.flushCritical(collection, `operation_destination_${effectId}`);
        if (!destinationFlush.ok) {
            this.#recordFlushFailure(this.collectionFor(id));
            return { success: false, code: "OP_DESTINATION_FLUSH_FAILED", error: `Destination ${collection} was not durably flushed`, destinationApplied: true, destinationDurable: false, uncertain: true, safeToCompensate: false, value: clone(tx.result?.value) };
        }
        const recorded = this.#recordMarkerAndStatus(id, { collection, field, effectId }, options.postStatus, {
            step: options.step || effectId,
            stepStatus: "applied",
            reason: `operation_after_${effectId}`
        });
        if (!recorded.success) return { ...recorded, destinationApplied: true, destinationDurable: true, safeToCompensate: false, alreadyApplied, value: clone(tx.result?.value) };
        return { success: true, destinationApplied: true, destinationDurable: true, safeToCompensate: false, alreadyApplied, value: clone(tx.result?.value), operation: recorded.operation };
    }

    static recordAppliedEffect(operationId, requirement, postStatus = null, options = {}) {
        const id = text(operationId, 120);
        const collection = text(requirement?.collection, 100);
        const field = text(requirement?.field || AppliedOperationStore.DEFAULT_FIELD, 48);
        const effectId = text(requirement?.effectId || "default", 64) || "default";
        if (!collection) return { success: false, code: "OP_MARKER_INVALID", error: "Marker collection is required" };
        const data = Database.collection(collection, requirement.defaultData || {}, requirement.validate ? { validate: requirement.validate } : undefined);
        if (!AppliedOperationStore.has(data, id, effectId, field)) return { success: false, code: "OP_MARKER_MISSING", error: `Applied marker ${effectId} is missing from ${collection}` };
        const flush = Database.flushCritical(collection, `operation_destination_${effectId}`);
        if (!flush.ok) return { success: false, code: "OP_DESTINATION_FLUSH_FAILED", error: `Destination ${collection} flush failed` };
        return this.#recordMarkerAndStatus(id, { collection, field, effectId }, postStatus, options);
    }

    static #recordMarkerAndStatus(operationId, requirement, postStatus, options = {}) {
        const id = text(operationId, 120);
        const collection = this.collectionFor(id);
        const tx = Database.transaction(collection, data => {
            const op = data.operations[id];
            if (!op) throw Object.assign(new Error("Operation not found"), { code: "OP_NOT_FOUND" });
            const key = `${requirement.collection}\u0000${requirement.field}\u0000${requirement.effectId}`;
            const exists = (op.markerRequirements || []).some(item => `${item.collection}\u0000${item.field}\u0000${item.effectId}` === key);
            if (!exists) op.markerRequirements.push(requirement);
            if (postStatus && op.status !== postStatus) {
                if (!TRANSITIONS[op.status]?.has(postStatus)) throw Object.assign(new Error(`Invalid operation transition ${op.status} -> ${postStatus}`), { code: "OP_INVALID_TRANSITION" });
                op.status = postStatus;
                op.transitionSeq = (op.transitionSeq || 0) + 1;
            }
            if (options.step) op.steps[text(options.step, 48)] = { status: text(options.stepStatus || "applied", 32), attempts: 0, updatedAt: now(), lastError: "" };
            op.updatedAt = now();
            op.lastError = "";
            data.outbox[id] = { operationId: id, state: "queued", nextAttemptAt: 0, attempts: op.attempts || 0, updatedAt: op.updatedAt, lastError: "" };
            data.stats.lastUpdated = now();
            return op;
        });
        if (!tx.success) return { success: false, code: tx.errorCode, error: tx.error };
        const flush = Database.flushCritical(collection, options.reason || "operation_record_marker");
        if (!flush.ok) {
            this.#recordFlushFailure(collection);
            return { success: false, code: "OP_JOURNAL_FLUSH_FAILED", error: "Applied marker transition was not durably flushed", operation: clone(tx.result) };
        }
        return { success: true, operation: clone(tx.result) };
    }

    static complete(operationId) { return this.#finish(operationId, "completed", ""); }
    static cancel(operationId, reason = "cancelled") { return this.#finish(operationId, "cancelled", reason); }

    static #finish(operationId, status, error) {
        const id = text(operationId, 120);
        const op = this.operation(id);
        if (!op) return { success: false, code: "OP_NOT_FOUND", error: "Operation not found" };
        if (isTerminalOperationStatus(op.status)) return { success: op.status === status, operation: op, alreadyTerminal: true };
        const sealed = this.#sealMarkers(op, status);
        if (!sealed.success) return sealed;
        return this.transition(id, status, { error, reason: `operation_${status}` });
    }

    static #sealMarkers(operation, status) {
        for (const requirement of operation.markerRequirements || []) {
            try {
                this.#loadMarkerDestination(operation, requirement);
                const tx = Database.transaction(requirement.collection, destination => {
                    if (!AppliedOperationStore.has(destination, operation.operationId, requirement.effectId, requirement.field)) {
                        throw Object.assign(new Error(`Required marker ${requirement.effectId} missing from ${requirement.collection}`), { code: "OP_MARKER_MISSING" });
                    }
                    AppliedOperationStore.markTerminal(destination, operation.operationId, status, now(), requirement.field);
                });
                if (!tx.success) return { success: false, code: tx.errorCode || "OP_MARKER_SEAL", error: tx.error };
                const flush = Database.flushCritical(requirement.collection, "operation_marker_terminal");
                if (!flush.ok) return { success: false, code: "OP_DESTINATION_FLUSH_FAILED", error: `Terminal marker flush failed for ${requirement.collection}` };
            } catch (cause) {
                return { success: false, code: cause?.code || "OP_MARKER_SEAL", error: String(cause?.message || cause) };
            }
        }
        return { success: true };
    }

    static recover(operationId, options = {}) {
        if (!this.#initialized) this.initialize();
        const op = this.operation(operationId);
        if (!op) return { success: false, code: "OP_NOT_FOUND", error: "Operation not found" };
        if (isTerminalOperationStatus(op.status)) return { success: true, terminal: true, operation: op, recovered: false };
        if (op.status === "dead_letter" && !options.force) return { success: false, code: "OP_DEAD_LETTER", error: op.lastError || "Operation is dead-lettered" };
        if (op.status === "retry_scheduled" && !options.force && op.nextAttemptAt > now()) return { success: false, code: "OP_BACKOFF", error: "Operation retry is not due", nextAttemptAt: op.nextAttemptAt };
        const handler = this.#handlers.get(op.operationType);
        if (!handler) {
            const scheduled = this.scheduleRetry(op.operationId, `No recovery handler for ${op.operationType}`);
            return { ...scheduled, success: false, retryScheduled: scheduled.success };
        }

        const prepared = this.#prepareRecovery(op, options.force);
        if (!prepared.success) return prepared;
        try {
            const current = this.operation(op.operationId);
            const result = handler.recover(current, {
                applyEffect: effect => this.applyEffect(op.operationId, effect),
                recordAppliedEffect: (requirement, postStatus, extra) => this.recordAppliedEffect(op.operationId, requirement, postStatus, extra),
                transition: (status, extra) => this.transition(op.operationId, status, extra),
                complete: () => this.complete(op.operationId),
                cancel: reason => this.cancel(op.operationId, reason),
                operation: () => this.operation(op.operationId)
            });
            if (isPromise(result) || isGenerator(result)) throw Object.assign(new Error("Operation recovery handlers must be synchronous"), { code: "OP_ASYNC_HANDLER" });
            if (!result || result.success === false) {
                const scheduled = this.scheduleRetry(op.operationId, result?.error || result?.message || "Recovery handler failed", { retryable: result?.retryable !== false });
                return { ...scheduled, success: false, retryScheduled: scheduled.success };
            }
            let final = this.operation(op.operationId);
            if (result.completed && !isTerminalOperationStatus(final.status)) {
                const completed = this.complete(op.operationId);
                if (!completed.success) {
                    const scheduled = this.scheduleRetry(op.operationId, completed.error || "Completion failed");
                    return { ...scheduled, success: false, retryScheduled: scheduled.success };
                }
                final = completed.operation;
            }
            this.#recordRecovered(op.operationId);
            return { success: true, recovered: true, operation: final, result: clone(result) };
        } catch (error) {
            const scheduled = this.scheduleRetry(op.operationId, error?.message || error, { retryable: error?.retryable !== false });
            return { ...scheduled, success: false, retryScheduled: scheduled.success };
        }
    }

    static #prepareRecovery(operation, force = false) {
        const id = operation.operationId;
        const collection = this.collectionFor(id);
        const tx = Database.transaction(collection, data => {
            const op = data.operations[id];
            if (!op) throw Object.assign(new Error("Operation not found"), { code: "OP_NOT_FOUND" });
            if (op.status === "retry_scheduled") op.status = op.resumeStatus || "created";
            else if (op.status === "dead_letter" && force) op.status = op.resumeStatus || "created";
            op.updatedAt = now();
            data.outbox[id] = { operationId: id, state: "running", nextAttemptAt: op.nextAttemptAt || 0, attempts: op.attempts || 0, updatedAt: op.updatedAt, lastError: op.lastError || "" };
            data.stats.lastUpdated = now();
            return op;
        });
        if (!tx.success) return { success: false, code: tx.errorCode, error: tx.error };
        const flush = Database.flushCritical(collection, "operation_recovery_running");
        if (!flush.ok) return { success: false, code: "OP_JOURNAL_FLUSH_FAILED", error: "Recovery marker flush failed" };
        return { success: true, operation: clone(tx.result) };
    }

    static runRecoveryBatch(options = {}) {
        if (!this.#initialized) this.initialize();
        if (this.#recovering) return { success: false, skipped: "already_running", checked: 0, recovered: 0 };
        const gate = this.#writeGate();
        if (!gate.ok) return { success: false, skipped: gate.code, error: gate.error, checked: 0, recovered: 0 };
        this.#recovering = true;
        const cfg = this.config();
        const shards = this.allShardCollections();
        let checked = 0, recovered = 0, failed = 0;
        try {
            for (let offset = 0; offset < shards.length && checked < cfg.recoveryBatch; offset++) {
                const index = (this.#shardCursor + offset) % shards.length;
                const name = shards[index];
                const db = Database.collection(name, DEFAULT_OPERATION_JOURNAL_DB, { validate: validateOperationJournalData });
                const candidates = (db.activeOrder || []).filter(id => {
                    const op = db.operations[id]; const item = db.outbox[id];
                    if (!op || isTerminalOperationStatus(op.status) || op.status === "dead_letter") return false;
                    return options.forceDue || !item?.nextAttemptAt || item.nextAttemptAt <= now();
                });
                for (const id of candidates) {
                    if (checked >= cfg.recoveryBatch) break;
                    checked++;
                    const result = this.recover(id, { force: !!options.forceDue });
                    if (result.success) recovered++; else failed++;
                }
            }
            this.#shardCursor = shards.length ? (this.#shardCursor + 1) % shards.length : 0;
        } finally { this.#recovering = false; }
        return { success: true, checked, recovered, failed };
    }

    static pruneTerminal(referenceTime = now()) {
        if (!this.#initialized) this.initialize();
        const cfg = this.config();
        const cutoff = referenceTime - cfg.terminalRetentionMs;
        let checked = 0, pruned = 0, blocked = 0;
        for (const collection of this.allShardCollections()) {
            const db = Database.collection(collection, DEFAULT_OPERATION_JOURNAL_DB, { validate: validateOperationJournalData });
            const candidates = (db.terminalOrder || []).filter(id => {
                const op = db.operations[id];
                return op && isTerminalOperationStatus(op.status) && (op.terminalAt || op.updatedAt || op.createdAt || 0) <= cutoff;
            }).slice(0, cfg.pruneBatch);
            for (const id of candidates) {
                checked++;
                const operation = this.operation(id);
                const markers = this.#removeRetainedMarkers(operation);
                if (!markers.success) { blocked++; continue; }
                const tx = Database.transaction(collection, data => {
                    const current = data.operations[id];
                    if (!current || !isTerminalOperationStatus(current.status)) return false;
                    delete data.operations[id]; delete data.outbox[id];
                    data.activeOrder = (data.activeOrder || []).filter(value => value !== id);
                    data.terminalOrder = (data.terminalOrder || []).filter(value => value !== id);
                    data.stats.totalPruned = (data.stats.totalPruned || 0) + 1;
                    data.stats.lastUpdated = now();
                    return true;
                });
                if (!tx.success || tx.result !== true) { blocked++; continue; }
                const flush = Database.flushCritical(collection, "operation_terminal_prune");
                if (flush.ok) pruned++; else blocked++;
            }
        }
        this.#metricsCache.at = 0;
        return { checked, pruned, blocked };
    }

    static #removeRetainedMarkers(operation) {
        if (!operation) return { success: false, error: "Operation missing" };
        for (const requirement of operation.markerRequirements || []) {
            const cleanupKey = JSON.stringify([requirement.collection, requirement.field, requirement.effectId]);
            let current = this.operation(operation.operationId);
            let state = current?.markerCleanup?.[cleanupKey] || "";
            try {
                let destination = this.#loadMarkerDestination(current, requirement);
                let markerExists = AppliedOperationStore.has(destination, operation.operationId, requirement.effectId, requirement.field);
                if (!markerExists && state !== "removing" && state !== "removed") {
                    return { success: false, error: `Marker ${requirement.effectId} missing before verified cleanup` };
                }
                if (state === "removed") continue;

                // Persist cleanup intent before deleting a marker. If a crash
                // happens after marker deletion, the durable "removing" state
                // makes a missing marker safe to resume rather than blocking
                // or replaying an already-expired operation.
                if (state !== "removing") {
                    const intent = this.#setMarkerCleanupState(operation.operationId, cleanupKey, "removing");
                    if (!intent.success) return intent;
                    state = "removing";
                }
                destination = Database.collection(requirement.collection);
                markerExists = AppliedOperationStore.has(destination, operation.operationId, requirement.effectId, requirement.field);
                if (markerExists) {
                    const remove = Database.transaction(requirement.collection, data => AppliedOperationStore.removeEffect(data, operation.operationId, requirement.effectId, requirement.field));
                    if (!remove.success || remove.result !== true) return { success: false, error: remove.error || "Marker removal failed" };
                    const destinationFlush = Database.flushCritical(requirement.collection, "operation_marker_retention_prune");
                    if (!destinationFlush.ok) return { success: false, error: "Marker removal flush failed" };
                }
                const removed = this.#setMarkerCleanupState(operation.operationId, cleanupKey, "removed");
                if (!removed.success) return removed;
            } catch (error) { return { success: false, error: String(error?.message || error) }; }
        }
        return { success: true };
    }

    static #loadMarkerDestination(operation, requirement) {
        const handler = this.#handlers.get(operation?.operationType);
        if (handler?.resolveMarker) handler.resolveMarker(clone(operation), clone(requirement));
        const meta = Database.getCollectionMeta(requirement.collection);
        if (!meta) throw Object.assign(new Error(`Marker destination ${requirement.collection} is not registered`), { code: "OP_MARKER_DESTINATION_UNREGISTERED" });
        return Database.collection(requirement.collection, meta.defaultData || {}, meta.validator ? { validate: meta.validator } : undefined);
    }

    static #setMarkerCleanupState(operationId, key, state) {
        const collection = this.collectionFor(operationId);
        const tx = Database.transaction(collection, data => {
            const operation = data.operations[operationId];
            if (!operation || !isTerminalOperationStatus(operation.status)) throw Object.assign(new Error("Terminal operation missing during marker cleanup"), { code: "OP_CLEANUP_STATE" });
            if (!operation.markerCleanup || typeof operation.markerCleanup !== "object") operation.markerCleanup = {};
            operation.markerCleanup[key] = state;
            operation.updatedAt = now();
            data.stats.lastUpdated = now();
            return state;
        });
        if (!tx.success) return { success: false, code: tx.errorCode, error: tx.error };
        const flush = Database.flushCritical(collection, `operation_marker_cleanup_${state}`);
        return { success: flush.ok, error: flush.ok ? "" : `Marker cleanup ${state} flush failed` };
    }

    static stats(force = false) {
        if (!this.#initialized) this.initialize();
        const timestamp = now();
        if (!force && this.#metricsCache.value && timestamp - this.#metricsCache.at < 5_000) return clone(this.#metricsCache.value);
        const totals = {
            active: 0, pending: 0, retryScheduled: 0, deadLetter: 0, terminal: 0,
            failedWithError: 0, oldestPendingAgeMs: 0, stored: 0, outbox: 0,
            totalCreated: 0, totalCompleted: 0, totalRecovered: 0,
            totalRetries: 0, totalPruned: 0, flushFailures: 0,
            shardCount: this.allShardCollections().length,
            routing: this.routingStatus()
        };
        let oldest = 0;
        for (const name of this.allShardCollections()) {
            const db = Database.collection(name, DEFAULT_OPERATION_JOURNAL_DB, { validate: validateOperationJournalData });
            totals.stored += Object.keys(db.operations || {}).length;
            totals.outbox += Object.keys(db.outbox || {}).length;
            for (const op of Object.values(db.operations || {})) {
                if (isTerminalOperationStatus(op.status)) totals.terminal++;
                else {
                    totals.active++;
                    if (op.status === "dead_letter") totals.deadLetter++;
                    else if (op.status === "retry_scheduled") totals.retryScheduled++;
                    else totals.pending++;
                    if (op.lastError) totals.failedWithError++;
                    if (op.status !== "dead_letter") oldest = !oldest ? op.createdAt : Math.min(oldest, op.createdAt || oldest);
                }
            }
            for (const key of ["totalCreated", "totalCompleted", "totalRecovered", "totalRetries", "totalPruned", "flushFailures"]) totals[key] += Math.max(0, Number(db.stats?.[key]) || 0);
        }
        totals.oldestPendingAgeMs = oldest ? Math.max(0, timestamp - oldest) : 0;
        this.#metricsCache = { at: timestamp, value: totals };
        return clone(totals);
    }

    static #recordRecovered(operationId) {
        const collection = this.collectionFor(operationId);
        Database.transaction(collection, data => {
            data.stats.totalRecovered = (data.stats.totalRecovered || 0) + 1;
            data.stats.lastUpdated = now();
        });
        Database.flushCritical(collection, "operation_recovery_stats");
        this.#metricsCache.at = 0;
    }

    static #recordFlushFailure(collection) {
        try {
            Database.transaction(collection, data => {
                if (data.stats) {
                    data.stats.flushFailures = (data.stats.flushFailures || 0) + 1;
                    data.stats.lastUpdated = now();
                }
            });
        } catch {}
        this.#metricsCache.at = 0;
    }

    static #updateCatalogLegacy(count) {
        const cfg = this.config();
        Database.transaction(cfg.catalog, data => {
            data.legacy.imported = (data.legacy.imported || 0) + Math.max(0, Number(count) || 0);
            data.legacy.lastImportedAt = now();
            data.stats.lastUpdated = now();
        });
        Database.flushCritical(cfg.catalog, "operation_legacy_import_catalog");
    }
}

export default OperationJournalService;
