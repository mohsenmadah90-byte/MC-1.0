// Bounded TTL cache for hot read paths. Values are cloned by caller policy.
export class BoundedCache {
    #entries = new Map();
    #maxEntries;
    #ttlMs;
    #hits = 0;
    #misses = 0;

    constructor({ maxEntries = 128, ttlMs = 5000 } = {}) {
        this.#maxEntries = Math.max(1, Math.floor(maxEntries));
        this.#ttlMs = Math.max(1, Math.floor(ttlMs));
    }

    get(key, now = Date.now()) {
        const entry = this.#entries.get(key);
        if (!entry || entry.expiresAt <= now) {
            if (entry) this.#entries.delete(key);
            this.#misses++;
            return undefined;
        }
        this.#entries.delete(key);
        this.#entries.set(key, entry);
        this.#hits++;
        return entry.value;
    }

    set(key, value, now = Date.now()) {
        this.#entries.delete(key);
        this.#entries.set(key, { value, expiresAt: now + this.#ttlMs });
        while (this.#entries.size > this.#maxEntries) this.#entries.delete(this.#entries.keys().next().value);
        return value;
    }

    clear() { this.#entries.clear(); }
    delete(key) { return this.#entries.delete(key); }
    stats() { return { size: this.#entries.size, maxEntries: this.#maxEntries, ttlMs: this.#ttlMs, hits: this.#hits, misses: this.#misses }; }
}

export default BoundedCache;
