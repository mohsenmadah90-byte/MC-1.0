// MCity Dashboard V2 - Atomic Schema Migration Registry
// Phase 2.4: migrate a clone before final validation; preserve source on failure.

import { Logger } from "./logger.js";

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function checksum(value) {
    const text = JSON.stringify(value);
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 16777619) >>> 0; }
    return `fnv1a:${hash.toString(16).padStart(8, "0")}`;
}

export class Migrations {
    static #registry = new Map();
    static #latest = new Map();
    static #initialized = false;
    static #history = [];
    static #maxHistory = 200;

    static initialize() {
        if (this.#initialized) return;
        this.#initialized = true;
        this.registerBuiltinMigrations();
        Logger.startup("Migrations", `Initialized (${this.#registry.size} schema domain(s) tracked)`);
    }

    static resolveCollection(collectionName) {
        const name = String(collectionName || "");
        if (name === "levels" || name.startsWith("levels_shard_")) return "level";
        if (name === "money" || name.startsWith("money_shard_") || name.startsWith("money_v2_shard_")) return "money";
        if (name === "notifications" || name.startsWith("notifications_shard_")) return "notifications";
        if (name === "finance" || name.startsWith("finance_payouts_shard_")) return "finance";
        if (name === "operation_journals" || name.startsWith("operation_journals_shard_")) return "operation_journal";
        return name;
    }

    static register(collectionName, fromVersion, toVersion, fn) {
        const name = this.resolveCollection(collectionName);
        fromVersion = Math.floor(Number(fromVersion));
        toVersion = Math.floor(Number(toVersion));
        if (!name || !Number.isInteger(fromVersion) || !Number.isInteger(toVersion) || toVersion <= fromVersion || typeof fn !== "function") {
            Logger.warn("Migrations", `Invalid migration registration for ${name || collectionName} ${fromVersion}->${toVersion}`);
            return false;
        }
        if (!this.#registry.has(name)) this.#registry.set(name, new Map());
        const chain = this.#registry.get(name);
        if (chain.has(fromVersion)) Logger.warn("Migrations", `Duplicate migration for ${name} from v${fromVersion} (overwriting)`);
        chain.set(fromVersion, { toVersion, fn });
        this.#latest.set(name, Math.max(this.#latest.get(name) || 1, toVersion));
        return true;
    }

    static migrateWithReport(collectionName, sourceData) {
        this.initialize();
        const domain = this.resolveCollection(collectionName);
        const source = sourceData && typeof sourceData === "object" && !Array.isArray(sourceData) ? sourceData : {};
        const fromVersion = Math.max(1, Math.floor(Number(source.schemaVersion) || 1));
        const targetVersion = this.latestVersion(domain);
        const sourceChecksum = checksum(source);
        const report = {
            collection: String(collectionName), domain, success: true,
            fromVersion, targetVersion, toVersion: fromVersion,
            applied: [], sourceChecksum, outputChecksum: sourceChecksum,
            errorCode: "", error: "", at: Date.now()
        };

        if (fromVersion > targetVersion) {
            // Forward data must never be downgraded by an older pack.
            const data = clone(source); data.schemaVersion = fromVersion;
            report.toVersion = fromVersion; report.outputChecksum = checksum(data);
            this.#remember(report);
            return { success: true, data, report };
        }

        const chain = this.#registry.get(domain);
        if (!chain || fromVersion === targetVersion) {
            const data = clone(source); data.schemaVersion = fromVersion;
            report.toVersion = fromVersion; report.outputChecksum = checksum(data);
            this.#remember(report);
            return { success: true, data, report };
        }

        const candidate = clone(source);
        let current = fromVersion;
        try {
            for (let guard = 0; current < targetVersion; guard++) {
                if (guard >= 100) {
                    const error = new Error("Migration chain exceeded 100 steps"); error.code = "MIGRATION_LOOP"; throw error;
                }
                const step = chain.get(current);
                if (!step) {
                    const error = new Error(`No migration path from v${current} to v${targetVersion}`); error.code = "MIGRATION_PATH_MISSING"; throw error;
                }
                const before = checksum(candidate);
                step.fn(candidate);
                candidate.schemaVersion = step.toVersion;
                // Ensure every intermediate result remains serializable/plain.
                JSON.stringify(candidate);
                report.applied.push({ from: current, to: step.toVersion, beforeChecksum: before, afterChecksum: checksum(candidate) });
                current = step.toVersion;
            }
            candidate.schemaVersion = current;
            report.toVersion = current;
            report.outputChecksum = checksum(candidate);
            if (report.applied.length) Logger.info("Migrations", `${collectionName} (${domain}): ${fromVersion}->${current}, ${report.applied.length} step(s)`);
            this.#remember(report);
            return { success: true, data: candidate, report };
        } catch (error) {
            report.success = false;
            report.toVersion = fromVersion;
            report.outputChecksum = sourceChecksum;
            report.errorCode = error?.code || "MIGRATION_STEP_FAILED";
            report.error = String(error?.message || error).substring(0, 500);
            this.#remember(report);
            Logger.error("Migrations", `${collectionName} migration failed; source preserved [${report.errorCode}]`, error);
            return { success: false, data: clone(source), report };
        }
    }

    static migrate(collectionName, data) {
        const result = this.migrateWithReport(collectionName, data);
        return result.success ? result.data : data;
    }

    static latestVersion(collectionName) {
        return this.#latest.get(this.resolveCollection(collectionName)) || 1;
    }

    static status(collectionName = null) {
        if (collectionName) {
            const domain = this.resolveCollection(collectionName);
            const chain = this.#registry.get(domain);
            return { collection: String(collectionName), domain, latestVersion: this.latestVersion(domain), registeredSteps: chain?.size || 0, recent: this.#history.filter(item => item.collection === collectionName).slice(-20).reverse() };
        }
        const domains = {};
        for (const [name, chain] of this.#registry.entries()) domains[name] = { registeredSteps: chain.size, latestVersion: this.#latest.get(name) || 1 };
        return { domains, recent: this.#history.slice().reverse() };
    }

    static stats() {
        const status = this.status();
        return status.domains; // backward-compatible UI shape
    }

    static #remember(report) {
        this.#history.push(clone(report));
        if (this.#history.length > this.#maxHistory) this.#history = this.#history.slice(-this.#maxHistory);
    }

    static registerBuiltinMigrations() {
        this.register("money", 1, 2, data => {
            if (!data.stats) data.stats = { totalKnownPlayers: 0, lastUpdated: 0, totalTransactions: 0 };
            if (data.stats.totalTransactions === undefined) data.stats.totalTransactions = 0;
        });
        this.register("land", 1, 2, data => { if (!data.spatialIndex) data.spatialIndex = {}; });
        for (const name of ["audit", "contracts", "market", "atm", "source", "finance", "notifications", "backups", "players", "level"]) {
            this.register(name, 1, 2, data => { if (!data.stats) data.stats = {}; });
        }
        this.register("market", 2, 3, data => {
            if (!data.authority) data.authority = { economic: "legacy", locked: true, lockedAt: Date.now() };
        });
        this.register("money", 2, 3, data => {
            if (!data.appliedOperations || typeof data.appliedOperations !== "object") data.appliedOperations = {};
        });
        this.register("finance", 2, 3, data => {
            if (!data.claimLocks || typeof data.claimLocks !== "object") data.claimLocks = {};
            if (!data.appliedOperations || typeof data.appliedOperations !== "object") data.appliedOperations = {};
            if (!data.ledgerIndex || typeof data.ledgerIndex !== "object") data.ledgerIndex = {};
            if (!data.ledgerMeta || typeof data.ledgerMeta !== "object") data.ledgerMeta = {};
            if (!data.payoutRouting || typeof data.payoutRouting !== "object") {
                data.payoutRouting = {
                    enabled: !!data.payoutSharded,
                    base: data.payoutSharded ? "finance_payouts" : "finance",
                    shardCount: Math.max(1, Math.floor(Number(data.payoutShardCount) || 1)),
                    algorithm: "fnv1a_imul_v2",
                    locked: false,
                    lockedAt: 0,
                    sourceBase: "finance"
                };
            }
            for (const list of Object.values(data.payouts || {})) {
                if (!Array.isArray(list)) continue;
                for (const payout of list) {
                    if (!payout || typeof payout !== "object") continue;
                    const amount = Math.max(0, Math.floor(Number(payout.amount) || 0));
                    payout.originalAmount = Math.max(amount, Math.floor(Number(payout.originalAmount) || amount));
                    payout.status = payout.status === "reserved" ? "reserved" : "pending";
                    payout.reservedAmount = payout.status === "reserved" ? Math.min(amount, Math.max(0, Math.floor(Number(payout.reservedAmount) || 0))) : 0;
                    payout.claimOperationId = payout.status === "reserved" ? String(payout.claimOperationId || "") : "";
                    payout.updatedAt = Math.max(0, Number(payout.updatedAt) || Number(payout.createdAt) || Date.now());
                }
            }
        });
    }
}

export default Migrations;
