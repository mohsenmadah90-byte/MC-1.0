// MCity Dashboard V2 - Health Check Dashboard
// Phase 4 Scalability: Real-time system health monitoring for admins.
//
// Surfaces runtime metrics from across the addon: TPS estimate, uptime,
// collection sizes, cache stats, rate limiter buckets, EventBus counters,
// DisposableRegistry state, and per-module index freshness.

import { ActionFormData } from "@minecraft/server-ui";
import { CONFIG } from "../config.js";
import { UI } from "../uiTheme.js";
import { Database } from "../core/database.js";
import { Logger } from "../core/logger.js";
import { Permissions } from "../core/permissions.js";
import { DisposableRegistry } from "../core/disposableRegistry.js";
import { RateLimiter } from "../core/rateLimiter.js";
import { EventBus } from "../core/eventBus.js";
import { PlayerRegistry } from "../core/playerRegistry.js";
import { AuditService } from "../modules/audit/auditService.js";
import { MoneyService } from "../modules/economy/moneyService.js";
import { MoneyUtils } from "../core/moneyUtils.js";
import { MoneyShard } from "../core/moneyShard.js";
import { FinanceService } from "../modules/finance/financeService.js";
import { LevelService } from "../modules/economy/levelService.js";
import { MemoryMonitor } from "../core/memoryMonitor.js";
import { ScalabilityService } from "../core/scalabilityService.js";
import { ShardMigrationService } from "../core/shardMigrationService.js";
import { RuntimeHandleRegistry } from "../core/runtimeHandleRegistry.js";
import { BedrockCompat } from "../core/bedrockCompat.js";
import { SubscriptionRegistry } from "../core/subscriptionRegistry.js";
import { BatchTaskService } from "../core/batchTaskService.js";
import { OperationJournalService } from "../core/operationJournalService.js";
import { FinancialRecoveryService } from "../core/financialRecoveryService.js";
import { MarketShardService } from "../modules/market/marketShardService.js";
import { LandShardService } from "../modules/land/landShardService.js";
import { ErrorBoundary } from "../core/errorBoundary.js";

function fmtBytes(bytes) {
    if (!bytes || bytes <= 0) return "0B";
    if (bytes > 1024 * 1024) return (bytes / 1024 / 1024).toFixed(2) + "MB";
    if (bytes > 1024) return (bytes / 1024).toFixed(1) + "KB";
    return bytes + "B";
}

function fmtDuration(ms) {
    if (!ms || ms <= 0) return "0s";
    const s = Math.floor(ms / 1000);
    if (s < 60) return s + "s";
    const m = Math.floor(s / 60);
    if (m < 60) return m + "m " + (s % 60) + "s";
    const h = Math.floor(m / 60);
    if (h < 24) return h + "h " + (m % 60) + "m";
    const d = Math.floor(h / 24);
    return d + "d " + (h % 24) + "h";
}

// Track TPS by measuring actual tick duration over a rolling window.
const tpsState = {
    lastTickMs: Date.now(),
    history: [],  // array of { time, durationMs }
    maxHistory: 60
};

// Hook into system.runInterval to sample tick duration. We can't measure
// true TPS from the script API, but we can estimate it from how long our
// interval takes to fire vs. its expected period.
let tpsSamplerStarted = false;
let tpsSamplerId = null;
function startTpsSampler() {
    if (tpsSamplerStarted) return;
    tpsSamplerStarted = true;
    tpsState.lastTickMs = Date.now();
    tpsSamplerId = RuntimeHandleRegistry.interval("HealthCheck.tpsSampler", () => {
        const now = Date.now();
        const actualDuration = now - tpsState.lastTickMs;
        tpsState.lastTickMs = now;
        tpsState.history.push({ time: now, durationMs: actualDuration });
        if (tpsState.history.length > tpsState.maxHistory) tpsState.history.shift();
    }, 20);
    DisposableRegistry.registerShutdownCleanup("HealthCheckUI.tpsSampler", () => {
        if (tpsSamplerId !== null) RuntimeHandleRegistry.clear(tpsSamplerId);
        tpsSamplerId = null;
        tpsSamplerStarted = false;
        tpsState.history.length = 0;
        tpsState.lastTickMs = Date.now();
        HealthCheckUI.initialized = false;
    });
}

function estimateTps() {
    if (tpsState.history.length < 5) return 20.0;
    // Phase 7.5 (v0.22.0) (DB2) CRITICAL FIX: TPS formula was off by 20×.
    //
    // The TPS sampler runs every 20 ticks (1 second). The measured
    // `actualDuration` is the wall-clock time between two firings of the
    // interval, which should be ~1000ms when the server is healthy (20 TPS).
    //
    // The old formula was `1000 / avgMs`, which gives ~1.0 for a healthy
    // server — making the TPS display always red and showing ≤1.0.
    //
    // The correct formula is: 20 ticks × 1000ms / avgMs = `20000 / avgMs`.
    // For a healthy server (avgMs ≈ 1000), this gives 20.0 TPS. If the
    // server is lagging (avgMs = 2000), TPS drops to 10.0.
    const recent = tpsState.history.slice(-20);
    let sum = 0;
    for (const h of recent) sum += h.durationMs;
    const avgMs = sum / recent.length;
    if (avgMs <= 0) return 20.0;
    return Math.min(20.0, Math.round((20000 / avgMs) * 10) / 10);
}

export class HealthCheckUI {
    static initialized = false;
    // Phase 7.7 (v1.0.0) (P6): Cache the aggregated stats snapshot for 5s
    // to avoid calling Database.stats on every open (each stats call is
    // O(N) per collection via Object.keys).
    static #statsCache = { data: null, time: 0 };
    static #statsCacheTtlMs = 5_000;

    static initialize() {
        if (this.initialized) return;
        this.initialized = true;
        startTpsSampler();
        Logger.startup("HealthCheckUI", "Initialized (TPS sampler started)");
    }

    /**
     * Phase 7.7 (v1.0.0) (P6): Get aggregated stats with a 5s cache.
     * The TPS sampler already runs every second, so the data is at most
     * 1s stale anyway — a 5s cache for the aggregate is a good trade-off.
     */
    static #getAggregatedStats() {
        const now = Date.now();
        if (this.#statsCache.data && now - this.#statsCache.time < this.#statsCacheTtlMs) {
            return this.#statsCache.data;
        }
        const collections = Database.listCollections();
        let totalSize = 0;
        let totalItems = 0;
        let dirtyCount = 0;
        const collectionDetails = [];
        for (const name of collections) {
            const st = Database.stats(name);
            if (st) {
                totalSize += st.size || 0;
                totalItems += st.itemCount || 0;
                if (st.dirty) dirtyCount++;
                collectionDetails.push({ name, status: st.status, schemaVersion: st.schemaVersion, size: st.size, persistedSize: st.persistedSize, itemCount: st.itemCount, dirty: st.dirty, revision: st.revision, persistedRevision: st.persistedRevision });
            }
        }
        const data = {
            collections, totalSize, totalItems, dirtyCount, collectionDetails,
            dispStats: DisposableRegistry.stats(),
            rlStats: RateLimiter.stats(),
            ebStats: EventBus.stats(),
            auditStats: AuditService.stats(),
            memStats: MemoryMonitor.stats(),
            subscriptionStats: SubscriptionRegistry.stats(),
            runtimeHandleStats: RuntimeHandleRegistry.stats(),
            compatibility: BedrockCompat.report(),
            dbTxStats: Database.transactionStats(),
            dbSaveStats: Database.saveQueueStats(),
            batchTaskStats: BatchTaskService.stats(),
            operationStats: OperationJournalService.stats(),
            financeStats: FinanceService.getStats(),
            financialRecoveryStats: FinancialRecoveryService.stats(),
            generationStatus: Database.runtimeStatus(),
            moneyShardStatus: MoneyShard.status(),
            onlineCount: PlayerRegistry.onlineMap().size,
            timestamp: now
        };
        this.#statsCache = { data, time: now };
        return data;
    }

    static async open(player) {
        // Phase 7.5 (v0.22.0) (DB7): Re-check permission on every open.
        if (!Permissions.canAccessAdminCenter(player)) return;
        if (!this.initialized) this.initialize();
        const tps = estimateTps();
        // Phase 7.7 (v1.0.0) (P6): Use cached aggregated stats.
        const agg = this.#getAggregatedStats();
        const tpsColor = tps >= 19 ? "§a" : tps >= 15 ? "§e" : "§c";
        const uptime = getUptimeMs();

        // Phase 7.7 (v1.0.0) (P6): Use cached aggregated stats.
        const { collections, totalSize, totalItems, dirtyCount, collectionDetails,
                dispStats, rlStats, ebStats, auditStats, memStats,
                subscriptionStats, runtimeHandleStats, compatibility, dbTxStats, dbSaveStats, batchTaskStats, operationStats, financeStats, financialRecoveryStats, generationStatus, moneyShardStatus, onlineCount } = agg;
        const riskReport = ScalabilityService.largeCollectionReport();
        const shardStats = ShardMigrationService.stats();
        const marketShardStats = MarketShardService.status();
        const landShardStats = LandShardService.status();
        const collectionLines = collectionDetails.slice(0, 10).map(d =>
            `§7${d.name}: §f${fmtBytes(d.size)} §8(schema v${d.schemaVersion}, r${d.revision}/p${d.persistedRevision}, ${d.itemCount} items${d.dirty ? ", §edirty§8" : ""}) ${d.status !== "ready" ? `§e[${d.status}]` : ""}`);

        const lines = [
            `§6§lSystem Health`,
            ``,
            `§7Version: §f${CONFIG.VERSION}`,
            `§7Uptime: §f${fmtDuration(uptime)}`,
            `§7TPS: ${tpsColor}${tps} §8/ 20.0`,
            `§7Online players: §f${onlineCount}`,
            ``,
            `§6§lDatabase`,
            `§7Collections: §f${collections.length} §8(${dirtyCount} dirty)`,
            `§7Total size: §f${fmtBytes(totalSize)}`,
            `§7Total items: §f${totalItems}`,
            ...collectionLines,
            collections.length > 10 ? `§8... and ${collections.length - 10} more` : "",
            ``,
            `§6§lCaches`,
            `§7Money balance cache: §f${getPrivFieldSize(MoneyService, "#balanceCache")} entries`,
            `§7Level score cache: §f${getPrivFieldSize(LevelService, "#scoreCache")} entries`,
            `§7Level level cache: §f${getPrivFieldSize(LevelService, "#levelCache")} entries`,
            ``,
            `§6§lRuntime Services`,
            `§7RateLimiter buckets: §f${rlStats.bucketCount} §8/ ${rlStats.maxBuckets}`,
            `§7EventBus topics: §f${ebStats.topics} §8(${ebStats.totalHandlers} handlers)`,
            `§7EventBus history: §f${ebStats.historySize} §8events`,
            `§7Subscriptions: §f${subscriptionStats.active} active §8(${subscriptionStats.unsubscribeFailures} unsubscribe failures)`,
            `§7Runtime handles: §f${runtimeHandleStats.intervals} intervals / ${runtimeHandleStats.jobs} jobs`,
            `§7DB transactions: §f${dbTxStats.committed} committed / ${dbTxStats.rolledBack} rolled back / ${dbTxStats.noChange} no-change`,
            `§7DB direct proxy mutations: §f${dbTxStats.directMutations}`,
            `§7Save queue: §f${dbSaveStats.depth} queued / ${dbSaveStats.completed} completed / ${dbSaveStats.failed} failed`,
            `§7Save queue oldest wait: §f${fmtDuration(dbSaveStats.oldestWaitMs)}`,
            `§7Batch tasks: §f${batchTaskStats.active} active / ${batchTaskStats.stored} stored`,
            `§7Batch duration: §f${batchTaskStats.lastBatchMs}ms last / ${batchTaskStats.maxBatchMs}ms max`,
            `§7Operations: §f${operationStats.pending} pending / §e${operationStats.retryScheduled} retry / §c${operationStats.deadLetter} dead-letter`,
            `§7Operation outbox: §f${operationStats.outbox} entries / ${operationStats.shardCount} shards`,
            `§7Oldest pending operation: §f${fmtDuration(operationStats.oldestPendingAgeMs)}`,
            operationStats.routing.healthy ? `§aOperation routing: ${operationStats.routing.base}/${operationStats.routing.shardCount} ${operationStats.routing.algorithm} [locked]` : `§cOperation routing error: ${operationStats.routing.error}`,
            `§7Finance payouts: §f${financeStats.pendingCount} pending / ${financeStats.reservedCount} reserved §8(${MoneyUtils.formatCents(financeStats.pendingAmount)})`,
            `§7Finance claims: §f${financeStats.activeClaims} active`,
            financeStats.payoutRouting.healthy ? `§aFinance routing: ${financeStats.payoutRouting.base}/${financeStats.payoutRouting.shardCount} [locked]` : `§cFinance routing error: ${financeStats.payoutRouting.error}`,
            `§7Finance ledger migration: ${financeStats.ledgerMeta.legacyMigrationComplete ? "§aComplete" : "§eIn progress"}`,
            `§7Financial reconcile: §f${financialRecoveryStats.latest?.status || "never"} §8(${financialRecoveryStats.latest?.findingCount || 0} finding(s))`,
            `§7Financial reconcile tasks: §f${financialRecoveryStats.active} active`,
            `§7Database mode: ${generationStatus.mode === "NORMAL" ? "§a" : "§e"}${generationStatus.mode}`,
            `§7Generation: §f${generationStatus.activeGeneration} §8(previous ${generationStatus.previousGeneration || "none"})`,
            `§7Generation catalog: §f${generationStatus.catalogStatus} §8(${generationStatus.generations.length} generation(s))`,
            `§7Money routing: §f${moneyShardStatus.activeBase} / ${moneyShardStatus.shardCount} shards`,
            `§7Money hash: §f${moneyShardStatus.algorithm} ${moneyShardStatus.locked ? "§a[locked]" : "§e[unlocked]"}`,
            `§7DisposableRegistry tracked players: §f${dispStats.trackedPlayers}`,
            `§7DisposableRegistry cleanups: §f${dispStats.registeredPlayerCleanups} player, ${dispStats.registeredShutdownCleanups} shutdown`,
            `§7Audit events: §f${auditStats.storedEvents} stored, ${auditStats.totalEvents} total`,
            compatibility.healthy ? `§aRequired API compatibility: OK` : `§cRequired API missing: ${compatibility.missingRequired.length}`,
            compatibility.unavailableProtection.length ? `§eUnavailable protection capabilities: §f${compatibility.unavailableProtection.map(f => f.id).join(", ")}` : `§aProtection event capabilities: available`,
            ``,
            `§6§lMemory`,
            `§7Total DB size: §f${fmtBytes(memStats.totalSize)}`,
            `§7Collections: §f${memStats.collectionCount}`,
            `§7Shard domains: §f${shardStats.registry.modules.length} §8(${shardStats.registry.modules.filter(m => m.enabled).length} enabled)`,
            `§7Shard migrations: §f${shardStats.active} active §8/ ${shardStats.total} total`,
            `§7Market shards: §fP ${marketShardStats.players.enabled ? marketShardStats.players.shardCount : 0} / O ${marketShardStats.orders.enabled ? marketShardStats.orders.shardCount : 0}`,
            `§7Land entry pass shards: §f${landShardStats.entryPasses.enabled ? landShardStats.entryPasses.shardCount : 0} §8(${landShardStats.entryPasses.shardPasses} passes)`,
            `§7Land region mode: §f${landShardStats.regions.enabled ? "enabled" : "ready/disabled"}`,
            riskReport.length ? `§cLarge collections: §f${riskReport.length}` : `§aLarge collections: §f0`,
            ...memStats.details.slice(0, 5).map(d => `§7${d.name}: §f${fmtBytes(d.size)} ${d.dirty ? "§e[dirty]" : ""}`),
            memStats.details.length > 5 ? `§8... and ${memStats.details.length - 5} more` : "",
            ``,
            `§8Tap a button below for details or actions.`
        ].filter(l => l !== "");

        const form = new ActionFormData()
            .title(UI.title(UI.ICON.admin, "Health Check"))
            .body(UI.body(...lines))
            .button("§aRefresh")
            .button("§eEventBus Stats")
            .button("§eRateLimiter Stats")
            .button("§fCreate Health Snapshot")
            .button("§cClear RateLimiter")
            .button("§cClear EventBus History")
            .button("§fRun Scalability Prune")
            .button("§fStorage Report")
            .button("§fCompact DB Storage")
            .button("§eCleanup Orphan Storage")
            .button(UI.BACK);

        try {
            const r = await form.show(player);
            if (r.canceled) return; if (r.selection === 10) return import("./adminDashboard.js").then(m => m.AdminDashboard.open(player));
            if (r.selection === 0) return this.open(player);
            if (r.selection === 1) return this.eventBusDetails(player);
            if (r.selection === 2) return this.rateLimiterDetails(player);
            if (r.selection === 3) {
                AuditService.createHealthSnapshot("admin_health_check");
                player.sendMessage("§aHealth snapshot created.");
                return this.open(player);
            }
            if (r.selection === 4) {
                // Phase 7.5 (v0.22.0) (DB7): Re-check before destructive action.
                if (!Permissions.canAccessAdminCenter(player)) return;
                RateLimiter.reset();
                player.sendMessage("§aRateLimiter cleared.");
                return this.open(player);
            }
            if (r.selection === 5) {
                // Phase 7.5 (v0.22.0) (DB7): Re-check before destructive action.
                if (!Permissions.canAccessAdminCenter(player)) return;
                EventBus.clearHistory();
                player.sendMessage("§aEventBus history cleared.");
                return this.open(player);
            }
            if (r.selection === 6) {
                // Hotfix 4: manual bounded-growth prune from Health Check.
                if (!Permissions.canAccessAdminCenter(player)) return;
                const report = ScalabilityService.pruneAll("admin_health_check");
                player.sendMessage(`§aScalability prune complete. Risks: §f${report.risks?.length || 0}`);
                return this.open(player);
            }
            if (r.selection === 7) return this.storageReport(player);
            if (r.selection === 8) return this.compactStorage(player);
            if (r.selection === 9) return this.cleanupStorage(player);

        } catch (e) {
            ErrorBoundary.report("HealthCheck", e, { player, notify: false, level: "debug", message: "Health Check form failed" });
        }
    }

    static async storageReport(player) {
        if (!Permissions.canAccessAdminCenter(player)) return;
        const lines = ["§6§lDatabase Storage Report"];
        const verify = Database.verifyAllStorage?.() || {};
        for (const name of Database.listCollections()) {
            const st = Database.storageStats?.(name);
            const v = verify[name];
            if (!st) continue;
            lines.push(`§7${name}: ${v?.ok ? "§aOK" : "§cBAD"} §8active §f${st.active || "legacy"} §8mem §f${fmtBytes(st.memorySize || 0)}`);
            if (!v?.ok && v?.attempts) for (const a of v.attempts.slice(0, 2)) lines.push(`§8 - ${a.label}: ${a.ok ? "OK" : a.error}`);
        }
        await new ActionFormData()
            .title(UI.title(UI.ICON.system, "Storage Report"))
            .body(UI.body(...lines.slice(0, 80)))
            .button(UI.BACK)
            .show(player);
        return this.open(player);
    }

    static async compactStorage(player) {
        if (!Permissions.canAccessAdminCenter(player)) return;
        const lines = ["§dCompacting loaded collections..."];
        let ok = 0, failed = 0;
        for (const name of Database.listCollections()) {
            const res = Database.compactStorage?.(name);
            if (res?.success) { ok++; lines.push(`§a${name}: OK`); }
            else { failed++; lines.push(`§c${name}: ${res?.error || "failed"}`); }
        }
        try { AuditService.record("database.storage.compact", "database", player.id, player.name, "Admin compacted DB storage", { ok, failed }, failed ? "warn" : "info"); } catch {}
        await new ActionFormData()
            .title(UI.title(UI.ICON.system, "Storage Compact"))
            .body(UI.body(...lines.slice(0, 80), "", `§7Success: §a${ok} §7Failed: §c${failed}`))
            .button(UI.BACK)
            .show(player);
        return this.open(player);
    }

    static async cleanupStorage(player) {
        if (!Permissions.canAccessAdminCenter(player)) return;
        const lines = ["§eCleaning orphan storage..."];
        let ok = 0, failed = 0, migrated = 0;
        for (const name of Database.listCollections()) {
            const res = Database.cleanupOrphanStorage?.(name);
            if (res?.success) { ok++; if (res.migratedLegacy) migrated++; lines.push(`§a${name}: OK${res.migratedLegacy ? " §7(migrated legacy)" : ""}`); }
            else { failed++; lines.push(`§c${name}: ${res?.error || "failed"}`); }
        }
        try { AuditService.record("database.storage.cleanup", "database", player.id, player.name, "Admin cleaned orphan DB storage", { ok, failed, migrated }, failed ? "warn" : "info"); } catch {}
        await new ActionFormData()
            .title(UI.title(UI.ICON.system, "Storage Cleanup"))
            .body(UI.body(...lines.slice(0, 80), "", `§7Success: §a${ok} §7Failed: §c${failed} §7Migrated: §e${migrated}`))
            .button(UI.BACK)
            .show(player);
        return this.open(player);
    }

    static async eventBusDetails(player) {
        const stats = EventBus.stats();
        const lines = [
            `§6§lEventBus Statistics`,
            ``,
            `§7Topics: §f${stats.topics}`,
            `§7Total handlers: §f${stats.totalHandlers}`,
            `§7History size: §f${stats.historySize}`,
            ``,
            `§6Topic breakdown:`
        ];
        for (const [topic, count] of Object.entries(stats.topicStats)) {
            lines.push(`§7${topic}: §f${count} handlers §8(emitted ${stats.emitCounters[topic] || 0}x)`);
        }
        if (Object.keys(stats.topicStats).length === 0) {
            lines.push(`§8No subscribers registered.`);
        }
        const recent = EventBus.history(20);
        if (recent.length > 0) {
            lines.push(``);
            lines.push(`§6Recent events (last ${recent.length}):`);
            for (const e of recent) {
                lines.push(`§8[${new Date(e.time).toLocaleTimeString()}] §f${e.topic} §8- ${e.eventPreview}`);
            }
        }

        try {
            await new ActionFormData()
                .title(UI.title(UI.ICON.admin, "EventBus Stats"))
                .body(UI.body(...lines))
                .button(UI.BACK)
                .show(player);
            return this.open(player);
        } catch (e) {
            ErrorBoundary.report("HealthCheck", e, { player, notify: false, level: "debug", message: "EventBus details failed" });
        }
    }

    static async rateLimiterDetails(player) {
        const stats = RateLimiter.stats();
        const lines = [
            `§6§lRateLimiter Statistics`,
            ``,
            `§7Total buckets: §f${stats.bucketCount} §8/ ${stats.maxBuckets}`,
            `§7Max idle: §f${fmtDuration(stats.maxIdleMs)}`,
            ``,
            `§6Configured limits (CONFIG.RATE_LIMITS):`
        ];
        const limits = CONFIG.RATE_LIMITS || {};
        for (const [name, cfg] of Object.entries(limits)) {
            if (cfg) {
                lines.push(`§7${name}: §f${cfg[0]} per ${fmtDuration(cfg[1])}`);
            } else {
                lines.push(`§7${name}: §8disabled`);
            }
        }
        lines.push(``);
        lines.push(`§8Buckets are pruned automatically after ${fmtDuration(stats.maxIdleMs)} of inactivity.`);

        try {
            await new ActionFormData()
                .title(UI.title(UI.ICON.admin, "RateLimiter Stats"))
                .body(UI.body(...lines))
                .button(UI.BACK)
                .show(player);
            return this.open(player);
        } catch (e) {
            ErrorBoundary.report("HealthCheck", e, { player, notify: false, level: "debug", message: "RateLimiter details failed" });
        }
    }
}

// Helper: best-effort access to private static field size. Since we can't
// read private fields from outside the class, we use the public getCacheStats
// methods added in Phase 5. If a service doesn't expose stats, we fall back
// to "n/a".
function getPrivFieldSize(service, fieldName) {
    if (typeof service?.getCacheStats === "function") {
        try {
            const stats = service.getCacheStats();
            if (fieldName === "#balanceCache") return stats.balanceCacheSize ?? "n/a";
            if (fieldName === "#scoreCache") return stats.scoreCacheSize ?? "n/a";
            if (fieldName === "#levelCache") return stats.levelCacheSize ?? "n/a";
        } catch {
            return "err";
        }
    }
    return "n/a";
}

// Track uptime via Date.now() — set when this module first loads.
const MODULE_LOAD_TIME = Date.now();
function getUptimeMs() {
    return Date.now() - MODULE_LOAD_TIME;
}

export default HealthCheckUI;
