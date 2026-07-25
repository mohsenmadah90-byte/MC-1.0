// MCity Dashboard V2 - Money Schema

import { CONFIG } from "../config.js";
import { AppliedOperationStore } from "../core/appliedOperationStore.js";

const MAX_MONEY = CONFIG.MONEY.MAX_MONEY_CENTS;

export const DEFAULT_MONEY_DB = {
    schemaVersion: 1,
    version: "1.0.0",
    players: {}, // playerId -> { id, name, balance, firstSeen, lastSeen, updatedAt }
    appliedJournals: {}, // backward-compatible transfer debit/credit/rollback markers
    appliedOperations: {}, // normalized markers for payout claims and future operations
    shardMeta: {
        enabled: false,
        shardCount: 1,
        algorithm: "",
        activeBase: "money",
        locked: false,
        migratedAt: 0,
        sourceAlgorithm: ""
    },
    stats: {
        totalKnownPlayers: 0,
        lastUpdated: 0
    }
};

export function validateMoneyData(data, def = DEFAULT_MONEY_DB) {
    const out = JSON.parse(JSON.stringify(def));
    try {
        out.version = data?.version || "1.0.0";
        out.schemaVersion = Math.max(1, Math.floor(Number(data?.schemaVersion) || Number(out.schemaVersion) || 1));
        if (data?.players && typeof data.players === "object") {
            for (const [id, rec] of Object.entries(data.players)) {
                if (!id || !rec || typeof rec !== "object") continue;
                const balance = Math.max(0, Math.min(MAX_MONEY, Math.floor(Number(rec.balance) || 0)));
                out.players[id] = {
                    id,
                    name: String(rec.name || "Unknown").substring(0, 32),
                    balance,
                    firstSeen: Number(rec.firstSeen) || Number(rec.lastSeen) || 0,
                    lastSeen: Number(rec.lastSeen) || 0,
                    updatedAt: Number(rec.updatedAt) || Date.now()
                };
            }
        }
        out.appliedJournals = {};
        if (data?.appliedJournals && typeof data.appliedJournals === "object") {
            // Phase 3.2: never remove an unresolved applied marker because of
            // an arbitrary count cap. Terminal markers are removed only by
            // OperationJournalService after retention and journal verification.
            const entries = Object.entries(data.appliedJournals)
                .filter(([id, rec]) => id && rec && typeof rec === "object")
                .sort((a, b) => (Number(a[1].at) || 0) - (Number(b[1].at) || 0));
            for (const [id, rec] of entries) {
                out.appliedJournals[String(id).substring(0, 100)] = {
                    debit: !!rec.debit,
                    credit: !!rec.credit,
                    rollback: !!rec.rollback,
                    status: ["debit", "credit", "rollback", "completed"].includes(rec.status) ? rec.status : "",
                    amount: Math.max(0, Math.floor(Number(rec.amount) || 0)),
                    at: Number(rec.at) || Date.now(),
                    value: rec.value && typeof rec.value === "object" ? rec.value : undefined,
                    terminalAt: Math.max(0, Number(rec.terminalAt) || 0),
                    operationStatus: ["completed", "cancelled"].includes(rec.operationStatus) ? rec.operationStatus : ""
                };
            }
        }
        out.appliedOperations = AppliedOperationStore.sanitize(data?.appliedOperations);
        const legacyCount = Math.max(1, Math.floor(Number(data?.shardCount) || 1));
        const rawMeta = data?.shardMeta && typeof data.shardMeta === "object" ? data.shardMeta : {};
        out.shardMeta = {
            enabled: rawMeta.enabled ?? !!data?.shardEnabled,
            shardCount: Math.max(1, Math.min(128, Math.floor(Number(rawMeta.shardCount) || legacyCount))),
            algorithm: String(rawMeta.algorithm || (data?.shardEnabled ? "fnv1a_float_v1" : "")).substring(0, 40),
            activeBase: String(rawMeta.activeBase || "money").replace(/[^a-zA-Z0-9_]/g, "_").substring(0, 64) || "money",
            locked: !!rawMeta.locked,
            migratedAt: Math.max(0, Number(rawMeta.migratedAt) || 0),
            sourceAlgorithm: String(rawMeta.sourceAlgorithm || "").substring(0, 40)
        };
        out.stats = { ...out.stats, ...(data?.stats || {}) };
        out.stats.totalKnownPlayers = Object.keys(out.players).length;
    } catch {
        return JSON.parse(JSON.stringify(def));
    }
    return out;
}

export default { DEFAULT_MONEY_DB, validateMoneyData };
