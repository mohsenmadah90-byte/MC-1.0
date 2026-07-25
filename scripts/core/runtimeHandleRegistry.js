// MCity Dashboard V2 - Runtime Interval/Job Handle Registry
// Phase 1.3: guarantees best-effort cleanup of every tracked interval and job.

import { system } from "@minecraft/server";
import { Logger } from "./logger.js";

export class RuntimeHandleRegistry {
    static #initialized = false;
    /** @type {Map<number, {id:number, type:"interval"|"timeout"|"job", label:string, createdAt:number}>} */
    static #handles = new Map();
    static #clearFailures = 0;
    static #scheduleMetrics = { executions: 0, skippedOverlaps: 0, overBudget: 0 };

    static initialize() {
        if (this.#initialized) return;
        this.#initialized = true;
        Logger.startup("RuntimeHandles", "Runtime interval/job registry initialized");
    }

    static interval(label, callback, ticks, options = {}) {
        if (!this.#initialized) this.initialize();
        if (typeof callback !== "function") throw new TypeError(`Runtime interval '${label}' requires a callback`);
        const budgetMs = Number.isFinite(options?.budgetMs) && options.budgetMs > 0 ? options.budgetMs : 0;
        let running = false;
        const trackedCallback = () => {
            if (running) {
                this.#scheduleMetrics.skippedOverlaps++;
                return;
            }
            running = true;
            this.#scheduleMetrics.executions++;
            const started = Date.now();
            let result;
            try {
                result = callback();
            } catch (error) {
                running = false;
                throw error;
            }
            const finish = () => {
                const elapsed = Date.now() - started;
                if (budgetMs && elapsed > budgetMs) {
                    this.#scheduleMetrics.overBudget++;
                    Logger.warn("RuntimeHandles", `Scheduled task '${String(label || "interval")}' exceeded budget ${budgetMs}ms (${elapsed}ms)`);
                }
                running = false;
            };
            if (result && typeof result.then === "function") return result.finally(finish);
            finish();
            return result;
        };
        const id = system.runInterval(trackedCallback, ticks);
        this.#handles.set(id, { id, type: "interval", label: String(label || "interval"), createdAt: Date.now(), budgetMs });
        return id;
    }

    static scheduled(label, callback, ticks, options = {}) {
        return this.interval(label, callback, ticks, options);
    }

    static timeout(label, callback, ticks) {
        if (!this.#initialized) this.initialize();
        const id = system.runTimeout(() => {
            try { callback(); }
            finally { this.#handles.delete(id); }
        }, ticks);
        this.#handles.set(id, { id, type: "timeout", label: String(label || "timeout"), createdAt: Date.now() });
        return id;
    }

    static job(label, generator) {
        if (!this.#initialized) this.initialize();
        let id;
        const self = this;
        function* trackedJob() {
            try {
                yield* generator;
            } finally {
                if (id !== undefined) self.#handles.delete(id);
            }
        }
        id = system.runJob(trackedJob());
        this.#handles.set(id, { id, type: "job", label: String(label || "job"), createdAt: Date.now() });
        return id;
    }

    static clear(id) {
        const entry = this.#handles.get(id);
        if (!entry) return false;
        try {
            if (entry.type === "job" && typeof system.clearJob === "function") system.clearJob(id);
            else system.clearRun(id);
        } catch (error) {
            this.#clearFailures++;
            Logger.debug("RuntimeHandles", `Failed to clear ${entry.type} '${entry.label}' (${id})`, error);
        } finally {
            this.#handles.delete(id);
        }
        return true;
    }

    static clearPrefix(prefix) {
        const value = String(prefix || "");
        let removed = 0;
        for (const [id, entry] of [...this.#handles.entries()]) {
            if (entry.label.startsWith(value) && this.clear(id)) removed++;
        }
        return removed;
    }

    static shutdown() {
        // Clear jobs first so they cannot resume while interval cleanup runs.
        const entries = [...this.#handles.values()].sort((a, b) => (a.type === "job" ? -1 : 1) - (b.type === "job" ? -1 : 1));
        for (const entry of entries) this.clear(entry.id);
        this.#handles.clear();
        this.#clearFailures = 0;
        this.#scheduleMetrics = { executions: 0, skippedOverlaps: 0, overBudget: 0 };
        this.#initialized = false;
        Logger.info("RuntimeHandles", "Runtime handle registry shutdown complete");
    }

    static stats() {
        let intervals = 0, timeouts = 0, jobs = 0;
        const byLabel = {};
        for (const entry of this.#handles.values()) {
            if (entry.type === "job") jobs++;
            else if (entry.type === "timeout") timeouts++;
            else intervals++;
            byLabel[entry.label] = (byLabel[entry.label] || 0) + 1;
        }
        return {
            initialized: this.#initialized,
            active: this.#handles.size,
            intervals,
            timeouts,
            jobs,
            clearFailures: this.#clearFailures,
            scheduleMetrics: { ...this.#scheduleMetrics },
            byLabel
        };
    }
}

export default RuntimeHandleRegistry;
