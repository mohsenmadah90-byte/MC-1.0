// MCity Dashboard V2 - Persisted Cursor Batch Task Engine
// Phase 2.3: one short domain transaction per scheduler tick.

import { Database } from "./database.js";
import { Logger } from "./logger.js";
import { DisposableRegistry } from "./disposableRegistry.js";
import { RuntimeHandleRegistry } from "./runtimeHandleRegistry.js";
import { DEFAULT_BATCH_TASK_DB, validateBatchTaskData } from "../schemas/batchTaskSchema.js";

const COLLECTION = "batch_tasks";
const MAX_ATTEMPTS = 20;
const WARN_BATCH_MS = 8;
function now() { return Date.now(); }
function taskId(type) { return `task_${String(type || "task").replace(/[^a-z0-9_]/gi, "_").substring(0, 32)}_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`; }
function clone(value) { return JSON.parse(JSON.stringify(value ?? {})); }

export class BatchTaskService {
    static #initialized = false;
    static #intervalId = null;
    static #running = false;
    static #handlers = new Map();
    static #metrics = { batches: 0, completed: 0, failed: 0, conflicts: 0, maxBatchMs: 0, lastBatchMs: 0 };

    static initialize() {
        if (this.#initialized) return;
        this.#initialized = true;
        this.db();
        this.#intervalId = RuntimeHandleRegistry.interval("BatchTasks.scheduler", () => {
            try { this.runOneBatch(); } catch (error) { Logger.error("BatchTasks", "Scheduler batch failed", error); }
        }, 1);
        DisposableRegistry.registerShutdownCleanup("BatchTaskService.lifecycle", () => this.shutdown());
        Logger.startup("BatchTasks", "Persisted batch task engine initialized");
    }

    static shutdown() {
        if (this.#intervalId !== null) RuntimeHandleRegistry.clear(this.#intervalId);
        this.#intervalId = null;
        this.#running = false;
        this.#handlers.clear();
        this.#metrics = { batches: 0, completed: 0, failed: 0, conflicts: 0, maxBatchMs: 0, lastBatchMs: 0 };
        this.#initialized = false;
    }

    static db() { return Database.collection(COLLECTION, DEFAULT_BATCH_TASK_DB, { validate: validateBatchTaskData }); }
    static collectionName() { return COLLECTION; }

    static register(type, handler) {
        const key = String(type || "").trim();
        if (!key || typeof handler?.process !== "function") return false;
        this.#handlers.set(key, { process: handler.process, afterCommit: typeof handler.afterCommit === "function" ? handler.afterCommit : null });
        return true;
    }

    static start(type, payload = {}, options = {}) {
        if (!this.#initialized) this.initialize();
        const dedupeKey = String(options.dedupeKey || "").substring(0, 120);
        const db = this.db();
        if (dedupeKey) {
            const existing = (db.order || []).map(id => db.tasks[id]).find(task => task && task.type === type && task.dedupeKey === dedupeKey && ["queued", "running"].includes(task.status));
            if (existing) return { success: true, started: false, task: clone(existing), message: "Task already active." };
        }
        const id = options.id || taskId(type);
        const task = {
            id, type, dedupeKey, status: "queued", payload: clone(payload), cursor: clone(options.cursor || {}),
            progress: {}, result: {}, attempts: 0, batches: 0, createdAt: now(), updatedAt: now(), startedAt: 0,
            completedAt: 0, lastError: ""
        };
        const tx = Database.transaction(COLLECTION, data => {
            data.tasks[id] = task;
            data.order = (data.order || []).filter(value => value !== id);
            data.order.push(id);
            data.stats.totalStarted = (data.stats.totalStarted || 0) + 1;
            data.stats.lastUpdated = now();
            return task;
        });
        if (!tx.success) return { success: false, started: false, message: tx.error };
        const flush = Database.flushCritical(COLLECTION, `batch_task_start:${type}`);
        if (!flush.ok) {
            Database.transaction(COLLECTION, data => {
                if (data.tasks[id]) {
                    data.tasks[id].status = "failed";
                    data.tasks[id].lastError = "Initial durable flush failed; task was not executed.";
                    data.tasks[id].completedAt = now();
                }
            });
            return { success: false, started: false, message: "Task could not be durably started and was blocked from execution." };
        }
        return { success: true, started: true, task: tx.result, message: "Task started." };
    }

    static runOneBatch() {
        if (this.#running) return { processed: false, reason: "already_running" };
        this.#running = true;
        const started = Date.now();
        let task = null;
        let handler = null;
        try {
            const db = this.db();
            task = (db.order || []).map(id => db.tasks[id]).find(value => value && ["queued", "running"].includes(value.status));
            if (!task) return { processed: false, reason: "empty" };
            handler = this.#handlers.get(task.type);
            if (!handler) return this.#failOrRetry(task.id, `No handler registered for task type '${task.type}'`, false);

            const mark = Database.transaction(COLLECTION, data => {
                const current = data.tasks[task.id];
                if (!current || !["queued", "running"].includes(current.status)) throw new Error("Task changed before execution.");
                current.status = "running";
                current.startedAt = current.startedAt || now();
                current.updatedAt = now();
                current.attempts = (current.attempts || 0) + 1;
                return current;
            });
            if (!mark.success) return { processed: false, reason: mark.errorCode || mark.error };
            if (!Database.flushCritical(COLLECTION, `batch_task_mark:${task.type}`).ok) return this.#failOrRetry(task.id, "Could not flush running task marker; execution blocked", false);
            task = mark.result;

            const output = handler.process(clone(task));
            if (output && typeof output.then === "function") throw new Error("Batch task handlers must be synchronous.");
            if (!output || typeof output !== "object") throw new Error("Batch task handler returned no result.");
            if (output.error) return this.#failOrRetry(task.id, output.error, output.retryable !== false);

            const flushCollections = [...new Set((output.flushCollections || []).filter(Boolean))];
            if (flushCollections.length) {
                const flushed = Database.flushCritical(flushCollections, `batch_task_domain:${task.type}`);
                if (!flushed.ok) return this.#failOrRetry(task.id, `Domain flush failed: ${flushed.failed.concat(flushed.missing).join(",")}`, true);
            }

            const update = Database.transaction(COLLECTION, data => {
                const current = data.tasks[task.id];
                if (!current) throw new Error("Task disappeared before cursor commit.");
                current.cursor = clone(output.cursor ?? current.cursor);
                current.progress = { ...(current.progress || {}), ...(output.progress || {}) };
                current.result = { ...(current.result || {}), ...(output.resultPatch || {}) };
                current.batches = (current.batches || 0) + 1;
                current.updatedAt = now();
                current.lastError = "";
                if (output.done) {
                    current.status = "completed";
                    current.completedAt = now();
                    data.stats.totalCompleted = (data.stats.totalCompleted || 0) + 1;
                } else current.status = "queued";
                data.stats.totalBatches = (data.stats.totalBatches || 0) + 1;
                data.stats.lastUpdated = now();
                return current;
            });
            if (!update.success) return this.#failOrRetry(task.id, update.error, true);
            if (!Database.flushCritical(COLLECTION, `batch_task_cursor:${task.type}`).ok) return this.#failOrRetry(task.id, "Could not flush task cursor", true);

            this.#metrics.batches++;
            if (output.done) this.#metrics.completed++;
            if (handler.afterCommit && output.effects) {
                try { handler.afterCommit(clone(output.effects), clone(update.result)); }
                catch (error) { Logger.warn("BatchTasks", `afterCommit failed for ${task.type}/${task.id}`, error); }
            }
            return { processed: true, taskId: task.id, type: task.type, done: !!output.done, progress: output.progress || {} };
        } catch (error) {
            this.#metrics.failed++;
            if (task?.id) return this.#failOrRetry(task.id, error?.message || error, true);
            Logger.error("BatchTasks", "Unbound task batch failed", error);
            return { processed: false, error: error?.message || String(error) };
        } finally {
            const elapsed = Date.now() - started;
            this.#metrics.lastBatchMs = elapsed;
            this.#metrics.maxBatchMs = Math.max(this.#metrics.maxBatchMs, elapsed);
            if (elapsed > WARN_BATCH_MS) Logger.warn("BatchTasks", `Batch exceeded ${WARN_BATCH_MS}ms budget: ${elapsed}ms (${task?.type || "none"})`);
            this.#running = false;
        }
    }

    static #failOrRetry(id, error, retryable) {
        const tx = Database.transaction(COLLECTION, data => {
            const task = data.tasks[id];
            if (!task) return null;
            task.lastError = String(error || "unknown").substring(0, 500);
            task.updatedAt = now();
            const canRetry = retryable && (task.attempts || 0) < MAX_ATTEMPTS;
            task.status = canRetry ? "queued" : "failed";
            if (!canRetry) {
                task.completedAt = now();
                data.stats.totalFailed = (data.stats.totalFailed || 0) + 1;
            }
            data.stats.lastUpdated = now();
            return task;
        });
        Database.flushCritical(COLLECTION, "batch_task_failure");
        if (!retryable) this.#metrics.failed++;
        return { processed: false, taskId: id, retryable: !!tx.result && tx.result.status === "queued", error: String(error || "unknown") };
    }

    static task(id) { const task = this.db().tasks[id]; return task ? clone(task) : null; }
    static list({ activeOnly = false, limit = 100 } = {}) {
        const db = this.db();
        let list = (db.order || []).map(id => db.tasks[id]).filter(Boolean);
        if (activeOnly) list = list.filter(task => ["queued", "running"].includes(task.status));
        return list.slice(-Math.max(1, Math.min(500, limit))).reverse().map(clone);
    }
    static stats() {
        const db = this.db();
        return { ...this.#metrics, stored: Object.keys(db.tasks || {}).length, active: this.list({ activeOnly: true, limit: 500 }).length, handlers: [...this.#handlers.keys()], dbStats: { ...db.stats } };
    }
}

export default BatchTaskService;
