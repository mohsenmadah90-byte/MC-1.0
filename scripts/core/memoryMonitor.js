// MCity Dashboard V2 - Memory Monitor
// Phase 3 Scalability: Track memory pressure and collection sizes to
// alert admins before the server runs out of Dynamic Property space.
// Phase 5 Fix: Configurable thresholds + DisposableRegistry integration.

import { CONFIG } from "../config.js";
import { Database } from "./database.js";
import { Logger } from "./logger.js";
import { RateLimiter } from "./rateLimiter.js";
import { DisposableRegistry } from "./disposableRegistry.js";
import { RuntimeHandleRegistry } from "./runtimeHandleRegistry.js";

export class MemoryMonitor {
    static #initialized = false;
    static #intervalId = null;
    static #lastReport = 0;

    /**
     * Phase 5 Fix: Configurable thresholds.
     *
     * PROBLEM (pre-Phase 5):
     *   The alert (600KB) and critical (750KB) thresholds were hardcoded.
     *   Servers with different collection profiles (e.g., a small server
     *   with one large collection vs. a large server with many small
     *   collections) couldn't tune the thresholds to their needs.
     *
     * SOLUTION (Phase 5):
     *   Thresholds are now read from `CONFIG.DATABASE.MEMORY_MONITOR` at
     *   initialize() time, with sensible defaults:
     *     - ALERT_THRESHOLD: 600_000 (600KB) — warn
     *     - CRITICAL_THRESHOLD: 750_000 (750KB) — error
     *     - REPORT_INTERVAL_MS: 10 * 60 * 1000 (10 min) — summary cadence
     *     - CHECK_INTERVAL_TICKS: 6000 (5 min) — check frequency
     *   If CONFIG doesn't provide them, the defaults are used.
     */
    static #alertThreshold = 600_000;
    static #criticalThreshold = 750_000;
    static #reportIntervalMs = 10 * 60 * 1000;
    static #checkIntervalTicks = 6000;

    static initialize() {
        if (this.#initialized) return;
        this.#initialized = true;

        // Phase 5 Fix: Read configurable thresholds from CONFIG.
        const cfg = CONFIG.DATABASE?.MEMORY_MONITOR || {};
        this.#alertThreshold = Math.max(1, Math.floor(cfg.ALERT_THRESHOLD || 600_000));
        this.#criticalThreshold = Math.max(this.#alertThreshold + 1, Math.floor(cfg.CRITICAL_THRESHOLD || 750_000));
        this.#reportIntervalMs = Math.max(60_000, Math.floor(cfg.REPORT_INTERVAL_MS || 10 * 60 * 1000));
        this.#checkIntervalTicks = Math.max(200, Math.floor(cfg.CHECK_INTERVAL_TICKS || 6000));

        // Run check periodically.
        this.#intervalId = RuntimeHandleRegistry.interval("MemoryMonitor.check", () => {
            this.#check();
        }, this.#checkIntervalTicks);

        // Phase 5 Fix: Register shutdown cleanup with DisposableRegistry
        // (consistent with RateLimiter, EventBus, HotReload).
        DisposableRegistry.registerShutdownCleanup("MemoryMonitor.interval", () => {
            this.shutdown();
        });

        Logger.startup("MemoryMonitor", `Initialized (checks every ${this.#checkIntervalTicks} ticks, alert=${this.#alertThreshold}B, critical=${this.#criticalThreshold}B)`);
    }

    static shutdown() {
        if (this.#intervalId !== null) {
            RuntimeHandleRegistry.clear(this.#intervalId);
            this.#intervalId = null;
        }
        this.#initialized = false;
    }

    static #check() {
        try {
            const collections = Database.listCollections();
            let totalSize = 0;
            let largestCollection = { name: "", size: 0 };
            let alerts = [];
            let criticals = [];

            for (const name of collections) {
                const stats = Database.stats(name);
                if (!stats) continue;
                totalSize += stats.size || 0;
                if (stats.size > largestCollection.size) {
                    largestCollection = { name, size: stats.size };
                }
                if (stats.size > this.#criticalThreshold) {
                    criticals.push({ name, size: stats.size });
                } else if (stats.size > this.#alertThreshold) {
                    alerts.push({ name, size: stats.size });
                }
            }

            const now = Date.now();
            const shouldReport = now - this.#lastReport > this.#reportIntervalMs;

            if (criticals.length > 0) {
                for (const c of criticals) {
                    Logger.error("MemoryMonitor", `CRITICAL: Collection '${c.name}' is ${c.size} bytes (threshold: ${this.#criticalThreshold}). Enable sharding immediately!`);
                }
                this.#lastReport = now;
            } else if (alerts.length > 0 && shouldReport) {
                for (const a of alerts) {
                    Logger.warn("MemoryMonitor", `ALERT: Collection '${a.name}' is ${a.size} bytes (threshold: ${this.#alertThreshold}). Consider sharding or pruning.`);
                }
                this.#lastReport = now;
            }

            // Log summary periodically
            if (shouldReport) {
                const rateStats = RateLimiter.stats();
                Logger.info("MemoryMonitor", `Summary: ${collections.length} collections, total ~${totalSize} bytes, largest: ${largestCollection.name} (${largestCollection.size} bytes), rateLimit buckets: ${rateStats.bucketCount}`);
                this.#lastReport = now;
            }
        } catch (error) {
            Logger.warn("MemoryMonitor", "Check failed", error);
        }
    }

    static stats() {
        const collections = Database.listCollections();
        let totalSize = 0;
        const details = [];
        for (const name of collections) {
            const stats = Database.stats(name);
            if (!stats) continue;
            totalSize += stats.size || 0;
            details.push({ name, size: stats.size, dirty: stats.dirty });
        }
        return {
            totalSize,
            collectionCount: collections.length,
            details,
            // Phase 5 Fix: Expose configured thresholds in stats.
            thresholds: {
                alert: this.#alertThreshold,
                critical: this.#criticalThreshold,
                reportIntervalMs: this.#reportIntervalMs,
                checkIntervalTicks: this.#checkIntervalTicks
            }
        };
    }
}

export default MemoryMonitor;
