// MCity Dashboard V2 - Main Entry Point
// Phase 5: Release Stabilization & Polish
// Phase 1 Stabilization: startup recovery guard for failed initialization
// Hotfix 3: FinancialJournalService recovery loop initialization
// Hotfix 4: ScalabilityService pruning loop initialization
// Sharding Phase 1: ShardMigrationService framework initialization
// Phase 1 Critical Fix: DisposableRegistry integration for clean player-leave handling
// Phase 4 Scalability: RateLimiter + EventBus initialization
// Phase 5 Polish: HotReload + Migrations integration

import { system } from "@minecraft/server";
import { CONFIG } from "./config.js";
import { Logger } from "./core/logger.js";
import { Database } from "./core/database.js";
import { PlayerRegistry } from "./core/playerRegistry.js";
import { DisposableRegistry } from "./core/disposableRegistry.js";
import { SubscriptionRegistry } from "./core/subscriptionRegistry.js";
import { RuntimeHandleRegistry } from "./core/runtimeHandleRegistry.js";
import { BedrockCompat } from "./core/bedrockCompat.js";
import { RateLimiter } from "./core/rateLimiter.js";
import { EventBus } from "./core/eventBus.js";
import { HotReload } from "./core/hotReload.js";
import { MemoryMonitor } from "./core/memoryMonitor.js";
import { ItemSettingsService } from "./core/itemSettingsService.js";
import { ScalabilityService } from "./core/scalabilityService.js";
import { ShardMigrationService } from "./core/shardMigrationService.js";
import { BatchTaskService } from "./core/batchTaskService.js";
import { OperationJournalService } from "./core/operationJournalService.js";
import { FinancialRecoveryService } from "./core/financialRecoveryService.js";
import { DashboardSystem } from "./dashboard/dashboardSystem.js";
import { DashboardEntry } from "./dashboard/dashboardEntry.js";
import { EconomyUI } from "./modules/economy/economyUI.js";
import { FinanceService } from "./modules/finance/financeService.js";
import { FinancialJournalService } from "./modules/finance/financialJournalService.js";
import { NotificationService } from "./dashboard/dashboardNotifications.js";
import { MarketUI } from "./modules/market/marketUI.js";
import { MarketShardService } from "./modules/market/marketShardService.js";
import { LandUI } from "./modules/land/landUI.js";
import { LandProtection } from "./modules/land/landProtection.js";
import { LandService } from "./modules/land/landService.js";
import { LandShardService } from "./modules/land/landShardService.js";
import { ContractUI } from "./modules/contracts/contractUI.js";
import { ContractService } from "./modules/contracts/contractService.js";
import { ContractShardService } from "./modules/contracts/contractShardService.js";
import { ATMService } from "./modules/atm/atmService.js";
import { ATMProtection } from "./modules/atm/atmProtection.js";
import { ATMLimits } from "./modules/atm/atmLimits.js";
import { AuditService } from "./modules/audit/auditService.js";
import { BackupService } from "./modules/backup/backupService.js";

class RuntimeState {
    static initialized = false;
    static shuttingDown = false;
    static intervals = new Set();
    static startedAt = Date.now();

    static uptimeSeconds() {
        return Math.floor((Date.now() - this.startedAt) / 1000);
    }

    static trackInterval(id) {
        this.intervals.add(id);
        return id;
    }

    static shutdown() {
        if (this.shuttingDown) return;
        this.shuttingDown = true;
        Logger.warn("Main", "Shutdown started");
        try {
            HotReload.save("Main.runtime", {
                version: CONFIG.VERSION,
                shutdownAt: Date.now(),
                uptimeSeconds: this.uptimeSeconds()
            });
        } catch (error) {
            Logger.debug("Main", "Failed to stage hot-reload runtime marker", error);
        }

        // Stop entry points first so no new work is accepted during teardown.
        SubscriptionRegistry.disposePrefix("Main.");
        for (const id of this.intervals) RuntimeHandleRegistry.clear(id);
        this.intervals.clear();

        try { ATMProtection.shutdown(); } catch (error) { Logger.error("Main", "ATMProtection shutdown error", error); }
        try { ATMLimits.stopLoop(system); } catch (error) { Logger.error("Main", "ATMLimits shutdown error", error); }
        try { LandProtection.shutdown(); } catch (error) { Logger.error("Main", "LandProtection shutdown error", error); }
        try { DashboardEntry.shutdown(); } catch (error) { Logger.error("Main", "DashboardEntry shutdown error", error); }
        try { DashboardSystem.shutdown(); } catch (error) { Logger.error("Main", "Dashboard shutdown error", error); }
        try { PlayerRegistry.shutdown(); } catch (error) { Logger.error("Main", "PlayerRegistry shutdown error", error); }
        // Cancel all background jobs before the final synchronous DB flush.
        try { RuntimeHandleRegistry.shutdown(); } catch (error) { Logger.error("Main", "RuntimeHandleRegistry shutdown error", error); }
        try { SubscriptionRegistry.shutdown(); } catch (error) { Logger.error("Main", "SubscriptionRegistry shutdown error", error); }
        try { DisposableRegistry.shutdown(); } catch (error) { Logger.error("Main", "DisposableRegistry shutdown error", error); }
        try { Database.shutdown(); } catch (error) { Logger.error("Main", "Database shutdown error", error); }
        try { BedrockCompat.reset(); } catch (error) { Logger.debug("Main", "BedrockCompat reset error", error); }

        this.initialized = false;
        Logger.warn("Main", "Shutdown complete");
    }
}

function initialize() {
    if (RuntimeState.initialized) return;
    // Phase 1 Stabilization: a previous shutdown or failed warm-start can
    // leave shuttingDown=true. Reset it before a fresh initialization attempt.
    RuntimeState.shuttingDown = false;
    RuntimeState.initialized = true;
    RuntimeState.startedAt = Date.now();

    // In Release phase, we set debug logging to WARN by default to prevent console spam
    // unless explicitly enabled in config
    if (!CONFIG.DEBUG.ENABLED) {
        Logger.setLevel("warn");
    }

    Logger.startup("Main", `${CONFIG.SYSTEM_NAME} ${CONFIG.VERSION} starting (Release Mode)`);
    Logger.info("Main", "Public command registration is disabled by design.");

    try {
        // Phase 1 Fix: DisposableRegistry must initialize FIRST so every service
        // can register its cleanup hooks during its own initialize().
        DisposableRegistry.initialize();
        SubscriptionRegistry.initialize();
        RuntimeHandleRegistry.initialize();
        BedrockCompat.logStartupReport();
        // Phase 4 Scalability: RateLimiter and EventBus init before any service
        // that will use them.
        RateLimiter.initialize();
        EventBus.initialize();
        // Phase 5 Polish: HotReload detects warm-start state.
        HotReload.initialize();
        const previousRuntime = HotReload.restore("Main.runtime");
        if (HotReload.wasReload()) {
            const previousVersion = previousRuntime?.version ? ` (previous ${previousRuntime.version})` : "";
            Logger.startup("Main", `Hot reload detected — warm start${previousVersion}`);
        } else {
            Logger.startup("Main", "Cold boot — no hot-reload state found");
        }
        Database.initialize(CONFIG.DATABASE);
        OperationJournalService.initialize();
        BatchTaskService.initialize();
        PlayerRegistry.initialize();
        EconomyUI.initialize();
        NotificationService.initialize();
        FinanceService.initialize();
        MarketUI.initialize();
        MarketShardService.initialize();
        LandUI.initialize();
        LandShardService.initialize();
        LandProtection.initialize();
        ContractUI.initialize();
        ContractShardService.initialize();
        AuditService.initialize();
        BackupService.initialize();
        FinancialJournalService.initialize();
        FinancialRecoveryService.initialize();
        ATMService.initialize();
        ATMProtection.initialize();
        ATMLimits.startLoop(system);
        MemoryMonitor.initialize();
        ItemSettingsService.initialize();
        ShardMigrationService.initialize();
        ScalabilityService.initialize();
        DashboardSystem.initialize();
        DashboardEntry.initialize(player => DashboardSystem.open(player));
        registerRuntimeEvents();
        registerHeartbeat();
        registerLandTaxLoop();
        registerContractGCLoop();
        Logger.startup("Main", "All modules stabilized and initialized successfully");
    } catch (error) {
        Logger.error("Main", "Initialization failed", error);
        // Phase 1 Stabilization: do not leave the runtime in a half-initialized
        // state. If startup fails, attempt a best-effort cleanup and allow a
        // later initialize() call / script reload to retry cleanly.
        try { RuntimeState.shutdown(); } catch (shutdownError) { Logger.error("Main", "Cleanup after failed initialization also failed", shutdownError); }
        RuntimeState.initialized = false;
        RuntimeState.shuttingDown = false;
    }
}

function registerRuntimeEvents() {
    BedrockCompat.subscribe("player.spawn.after", "Main.playerSpawn", event => {
        if (!event.initialSpawn) return;
        RuntimeHandleRegistry.timeout("Main.playerWelcome", () => {
            try {
                // Touch and queue checks are handled internally by PlayerRegistry.
                if (CONFIG.DEBUG.LOG_STARTUP_REPORT) {
                    event.player.sendMessage(CONFIG.PREFIX + "§aMCity Dashboard V2 loaded. Use your §6MCity Menu §apaper to open Dashboard.");
                }
            } catch (error) {
                Logger.error("Main", `Player init failed for ${event.player?.name || "unknown"}`, error);
            }
        }, 30);
    }, { required: true });

    // Script API 2.x exposes shutdown on system.beforeEvents, not worldUnload.
    BedrockCompat.subscribe("system.shutdown", "Main.shutdown", () => RuntimeState.shutdown(), { required: true });
}

function registerHeartbeat() {
    const id = RuntimeHandleRegistry.interval("Main.heartbeat", () => {
        if (RuntimeState.shuttingDown) return;
        try {
            // Phase 1 Fix: Use the O(1) registry map; touch only valid players.
            for (const player of PlayerRegistry.online()) {
                try { PlayerRegistry.touch(player); } catch (error) { Logger.debug("Main", `Heartbeat touch failed for ${player?.name || "unknown"}`, error); }
            }
        } catch (error) {
            Logger.warn("Main", "Heartbeat failed", error);
        }
    }, 20 * 60 * 5); // 5 minutes
    RuntimeState.trackInterval(id);
}

function registerLandTaxLoop() {
    const id = RuntimeHandleRegistry.interval("Main.landTax", () => {
        if (RuntimeState.shuttingDown) return;
        try { 
            // Phase 2.3: enqueue/resume a persisted short-batch tax task.
            LandService.accrueTaxes(false); 
        }
        catch (error) { Logger.warn("Main", "Land tax loop failed", error); }
    }, CONFIG.LAND.TAX_ACCRUAL_INTERVAL_TICKS || 1200, { budgetMs: 5 }); // Default 1 minute
    RuntimeState.trackInterval(id);
}

function registerContractGCLoop() {
    const id = RuntimeHandleRegistry.interval("Main.contractGC", () => {
        if (RuntimeState.shuttingDown) return;
        try { ContractService.finalizeExpired(); }
        catch (error) { Logger.warn("Main", "Contract GC loop failed", error); }
    }, CONFIG.CONTRACTS.GC_INTERVAL_TICKS || 6000, { budgetMs: 5 }); // Default 5 minutes
    RuntimeState.trackInterval(id);
}

system.run(initialize);

export { RuntimeState, initialize };

Logger.info("Main", "Main script loaded");