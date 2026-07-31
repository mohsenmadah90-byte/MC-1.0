// MCity Dashboard V2 - Central Bedrock Event Subscription Registry
// Phase 1.3: subscriptions are disposed through signal.unsubscribe(callback).

import { Logger } from "./logger.js";

export class SubscriptionRegistry {
    static #initialized = false;
    /** @type {Map<string, {id:string, signal:any, callback:Function, sourceCallback:Function, createdAt:number}>} */
    static #entries = new Map();
    static #subscribeFailures = 0;
    static #unsubscribeFailures = 0;

    static initialize() {
        if (this.#initialized) return;
        this.#initialized = true;
        Logger.startup("Subscriptions", "Central subscription registry initialized");
    }

    static subscribe(id, signal, callback) {
        if (!this.#initialized) this.initialize();
        const key = String(id || "").trim();
        if (!key || !signal || typeof signal.subscribe !== "function" || typeof callback !== "function") {
            this.#subscribeFailures++;
            Logger.warn("Subscriptions", `Invalid subscription '${key || "unnamed"}'`);
            return null;
        }

        // Reinitialization must never create a second live callback with the same id.
        this.dispose(key);
        try {
            const returned = signal.subscribe(callback);
            // Bedrock event signals return the callback used for unsubscribe.
            const subscribedCallback = typeof returned === "function" ? returned : callback;
            this.#entries.set(key, {
                id: key,
                signal,
                callback: subscribedCallback,
                sourceCallback: callback,
                createdAt: Date.now()
            });
            return key;
        } catch (error) {
            this.#subscribeFailures++;
            Logger.warn("Subscriptions", `Failed to subscribe '${key}'`, error);
            return null;
        }
    }

    static dispose(id) {
        const key = String(id || "");
        const entry = this.#entries.get(key);
        if (!entry) return false;
        try {
            if (typeof entry.signal?.unsubscribe === "function") {
                entry.signal.unsubscribe(entry.callback);
            }
        } catch (error) {
            this.#unsubscribeFailures++;
            Logger.warn("Subscriptions", `Failed to unsubscribe '${key}'`, error);
        } finally {
            this.#entries.delete(key);
        }
        return true;
    }

    static disposePrefix(prefix) {
        const value = String(prefix || "");
        let removed = 0;
        for (const id of [...this.#entries.keys()]) {
            if (id.startsWith(value) && this.dispose(id)) removed++;
        }
        return removed;
    }

    static shutdown() {
        for (const id of [...this.#entries.keys()]) this.dispose(id);
        this.#entries.clear();
        this.#subscribeFailures = 0;
        this.#unsubscribeFailures = 0;
        this.#initialized = false;
        Logger.info("Subscriptions", "Subscription registry shutdown complete");
    }

    static stats() {
        const byScope = {};
        for (const id of this.#entries.keys()) {
            const scope = id.includes(".") ? id.split(".")[0] : id;
            byScope[scope] = (byScope[scope] || 0) + 1;
        }
        return {
            initialized: this.#initialized,
            active: this.#entries.size,
            subscribeFailures: this.#subscribeFailures,
            unsubscribeFailures: this.#unsubscribeFailures,
            byScope
        };
    }
}

export default SubscriptionRegistry;
