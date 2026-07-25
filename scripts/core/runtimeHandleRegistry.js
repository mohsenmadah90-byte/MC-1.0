// MCity Dashboard V2 - Runtime Interval/Job Handle Registry
// Phase 1.3: guarantees best-effort cleanup of every tracked interval and job.

import { system } from "@minecraft/server";
import { Logger } from "./logger.js";

export class RuntimeHandleRegistry {
    static #initialized = false;
    /** @type {Map<number, {id:number, type:"interval"|"job", label:string, createdAt:number}>} */
    static #handles = new Map();
    static #clearFailures = 0;

    static initialize() {
        if (this.#initialized) return;
        this.#initialized = true;
        Logger.startup("RuntimeHandles", "Runtime interval/job registry initialized");
    }

    static interval(label, callback, ticks) {
        if (!this.#initialized) this.initialize();
        const id = system.runInterval(callback, ticks);
        this.#handles.set(id, { id, type: "interval", label: String(label || "interval"), createdAt: Date.now() });
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
        this.#initialized = false;
        Logger.info("RuntimeHandles", "Runtime handle registry shutdown complete");
    }

    static stats() {
        let intervals = 0, jobs = 0;
        const byLabel = {};
        for (const entry of this.#handles.values()) {
            if (entry.type === "job") jobs++; else intervals++;
            byLabel[entry.label] = (byLabel[entry.label] || 0) + 1;
        }
        return {
            initialized: this.#initialized,
            active: this.#handles.size,
            intervals,
            jobs,
            clearFailures: this.#clearFailures,
            byLabel
        };
    }
}

export default RuntimeHandleRegistry;
