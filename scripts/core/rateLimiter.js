// MCity Dashboard V2 - Rate Limiter
// Phase 4 Scalability: Per-key rate limiting to prevent click spam and abuse.
//
// Designed to be cheap and lock-free. Each "bucket" tracks a sliding window
// of request timestamps. When the window overflows, the request is denied.
//
// Memory is reclaimed lazily: stale buckets are removed when accessed or
// when prune() is called periodically.
//
// Usage:
//   // 10 market buys per minute per player
//   if (!RateLimiter.check(`market_buy:${player.id}`, 10, 60_000)) {
//       return { success: false, message: "§cRate limit. Try again later." };
//   }
//
//   // Global limit: 200 audit events per second
//   if (!RateLimiter.check("audit_global", 200, 1000)) {
//       return null;  // silently drop
//   }

import { DisposableRegistry } from "./disposableRegistry.js";
import { Logger } from "./logger.js";
import { RuntimeHandleRegistry } from "./runtimeHandleRegistry.js";

export class RateLimiter {
    /** @type {Map<string, { times: number[], windowMs: number, max: number, lastAccess: number }>} */
    static #buckets = new Map();
    static #pruneIntervalId = null;
    static #initialized = false;

    /** Bucket entries older than this (ms since last access) are pruned. */
    static #maxIdleMs = 5 * 60 * 1000;  // 5 minutes
    /** Hard cap on number of buckets to bound memory. */
    static #maxBuckets = 10000;

    static initialize() {
        if (this.#initialized) return;
        this.#initialized = true;
        // Phase 2 Performance: periodic prune of stale buckets every 5 minutes.
        // This prevents memory growth from abandoned buckets (e.g., players
        // who left hours ago but their rate-limit state is still in memory).
        this.#pruneIntervalId = RuntimeHandleRegistry.interval("RateLimiter.prune", () => {
            this.#prune(Date.now());
        }, 6000); // 5 minutes (6000 ticks)
        DisposableRegistry.registerShutdownCleanup("RateLimiter.buckets", () => {
            if (this.#pruneIntervalId !== null) {
                RuntimeHandleRegistry.clear(this.#pruneIntervalId);
                this.#pruneIntervalId = null;
            }
            this.#buckets.clear();
            this.#initialized = false;
        });
        Logger.startup("RateLimiter", "Initialized with periodic prune (5min)");
    }

    /**
     * Check whether a request under `key` should be allowed given `max`
     * requests per `windowMs` window. If allowed, the request is recorded.
     * Returns true if allowed, false if rate-limited.
     *
     * Phase 4 Fix: Fail-closed on invalid parameters.
     *
     * PROBLEM (pre-Phase 4):
     *   The old code returned `true` (allow) when `max <= 0` or `windowMs <= 0`:
     *     `if (!key || max <= 0 || windowMs <= 0) return true;`
     *   This was fail-OPEN: if a caller misconfigured a rate limit (e.g.,
     *   passed `max=0` by mistake, or `windowMs=0` from a missing CONFIG
     *   field), ALL requests were allowed — the rate limit was silently
     *   bypassed. For security-sensitive limits (money transfers, market
     *   trades, ATM exchanges), this was an unacceptable risk.
     *
     * SOLUTION (Phase 4):
     *   Fail-CLOSED: invalid parameters cause the request to be DENIED
     *   (return false) and an error is logged. This means:
     *     - A misconfigured rate limit BLOCKS all requests (visible failure)
     *       rather than ALLOWING all requests (invisible security hole).
     *     - The admin sees the error in the log and can fix the config.
     *     - Legitimate users are temporarily inconvenienced, but the
     *       system is secure.
     *
     *   The only exception is a falsy `key`, which returns false (denied)
     *   because rate-limiting without a key is meaningless — it would
     *   rate-limit ALL users under a single bucket.
     */
    static check(key, max, windowMs) {
        // Phase 4 Fix: Fail-closed on invalid params.
        if (!key || max <= 0 || windowMs <= 0) {
            Logger.error("RateLimiter", `Invalid params denied: key=${JSON.stringify(key)}, max=${max}, windowMs=${windowMs}. Fail-closed — request denied.`);
            return false;
        }
        const now = Date.now();
        let bucket = this.#buckets.get(key);

        if (!bucket) {
            // Lazy initialize on first use.
            bucket = { times: [], windowMs, max, lastAccess: now, startIndex: 0 };
            this.#buckets.set(key, bucket);
            // Bound memory: if too many buckets, prune oldest.
            if (this.#buckets.size > this.#maxBuckets) this.#prune(now);
        } else {
            bucket.lastAccess = now;
            // If config changed for this key, update it.
            if (bucket.windowMs !== windowMs || bucket.max !== max) {
                bucket.windowMs = windowMs;
                bucket.max = max;
                bucket.times = [];
                bucket.startIndex = 0;
            }
        }

        const cutoff = now - windowMs;
        const times = bucket.times;
        let start = bucket.startIndex || 0;

        // Phase 6 Deep Fix: O(1) amortized pruning using startIndex cursor
        // instead of O(N) shift() loop. We advance the cursor past expired
        // entries instead of mutating the array front.
        while (start < times.length && times[start] < cutoff) start++;
        bucket.startIndex = start;

        const validCount = times.length - start;
        if (validCount >= max) return false;
        times.push(now);

        // Prevent unbounded growth: compact the array when the garbage ratio
        // exceeds 50% or when more than 100 entries are stale.
        if (start > 100 || (times.length > 200 && start > times.length / 2)) {
            bucket.times = times.slice(start);
            bucket.startIndex = 0;
        }

        return true;
    }

    /**
     * Returns the remaining allowance for `key` in the current window
     * without consuming a slot.
     *
     * Phase 4 Fix: Fail-closed on invalid parameters.
     * Returns 0 (no remaining allowance) if params are invalid, so
     * callers that check `remaining > 0` will correctly deny.
     */
    static remaining(key, max, windowMs) {
        // Phase 4 Fix: Fail-closed — invalid params return 0 (no allowance).
        if (!key || max <= 0 || windowMs <= 0) return 0;
        const bucket = this.#buckets.get(key);
        if (!bucket) return max;
        const now = Date.now();
        const cutoff = now - bucket.windowMs;
        const start = bucket.startIndex || 0;
        let count = 0;
        for (let i = start; i < bucket.times.length; i++) {
            if (bucket.times[i] >= cutoff) count++;
        }
        return Math.max(0, max - count);
    }

    /**
     * Returns the time (ms) until the next slot opens for `key`, or 0 if
     * a slot is available now.
     *
     * Phase 4 Fix: Fail-closed on invalid parameters.
     * Returns a large value (Number.MAX_SAFE_INTEGER) if params are
     * invalid, so callers that check `retryIn > threshold` will correctly
     * treat it as "still rate-limited".
     */
    static retryIn(key, max, windowMs) {
        // Phase 4 Fix: Fail-closed — invalid params return a large value
        // (effectively "retry never") so callers don't treat it as "available now".
        if (!key || max <= 0 || windowMs <= 0) return Number.MAX_SAFE_INTEGER;
        const bucket = this.#buckets.get(key);
        if (!bucket) return 0;
        const now = Date.now();
        const cutoff = now - bucket.windowMs;
        const start = bucket.startIndex || 0;
        const times = [];
        for (let i = start; i < bucket.times.length; i++) {
            if (bucket.times[i] >= cutoff) times.push(bucket.times[i]);
        }
        if (times.length < max) return 0;
        // Next slot opens when the oldest entry in the window expires.
        const oldest = Math.min(...times);
        return Math.max(0, oldest + bucket.windowMs - now);
    }

    /**
     * Clear all rate-limit state for `key`. Useful for admin override.
     */
    static reset(key) {
        if (key) this.#buckets.delete(key);
        else this.#buckets.clear();
    }

    /**
     * Remove buckets that haven't been accessed in `maxIdleMs` ms.
     * Called automatically when bucket count exceeds `maxBuckets`, but can
     * also be invoked manually.
     */
    static #prune(now = Date.now()) {
        const cutoff = now - this.#maxIdleMs;
        let removed = 0;
        for (const [k, b] of this.#buckets.entries()) {
            if (b.lastAccess < cutoff) {
                this.#buckets.delete(k);
                removed++;
            }
        }
        if (removed > 0) {
            Logger.debug("RateLimiter", `Pruned ${removed} stale buckets (${this.#buckets.size} remaining)`);
        }
    }

    static stats() {
        return {
            bucketCount: this.#buckets.size,
            maxBuckets: this.#maxBuckets,
            maxIdleMs: this.#maxIdleMs
        };
    }
}

export default RateLimiter;
