// MCity Dashboard V2 - Finance / Payout / Canonical Ledger Schema
// Phase 3.3: payout obligations are never count-trimmed or silently dropped.

import { CONFIG } from "../config.js";
import { AppliedOperationStore } from "../core/appliedOperationStore.js";

const FC = CONFIG.FINANCE;
const PAYOUT_STATUS = new Set(["pending", "reserved"]);

function clone(value, fallback = {}) {
    try { return JSON.parse(JSON.stringify(value)); } catch { return JSON.parse(JSON.stringify(fallback)); }
}
function safeInt(value, min = 0, max = Number.MAX_SAFE_INTEGER) {
    const number = Number(value);
    if (!Number.isFinite(number)) return Math.max(min, Math.min(max, 0));
    return Math.max(min, Math.min(max, Math.floor(number)));
}
function safeText(value, max = 120) { return String(value || "").replace(/[\u0000-\u001f\u007f]/g, "").substring(0, max); }
function safeObject(value) { return value && typeof value === "object" && !Array.isArray(value) ? clone(value) : {}; }

export const DEFAULT_FINANCE_DB = {
    schemaVersion: 1,
    version: "1.0.0",
    treasury: {
        server: { balance: 0, totalIn: 0, totalOut: 0 },
        land: { balance: 0, totalIn: 0, totalOut: 0, totalTax: 0, totalSales: 0, totalRent: 0, totalEntryTax: 0 },
        market: { balance: 0, totalIn: 0, totalOut: 0, totalFees: 0, totalTax: 0, totalWithdrawn: 0 },
        contracts: { balance: 0, totalIn: 0, totalOut: 0, paid: 0, fees: 0 },
        atm: { minted: 0 },
        burned: { total: 0 }
    },
    payouts: {},       // playerId -> durable payout obligations
    claimLocks: {},    // playerId -> { operationId, createdAt, updatedAt }
    playerSummary: {}, // playerId -> { name, totalReceived, totalPending, lastClaimedAt }
    appliedOperations: {},
    payoutSharded: false,
    payoutShardCount: 1,
    payoutRouting: {
        enabled: false,
        base: "finance",
        shardCount: 1,
        algorithm: "fnv1a_imul_v2",
        locked: false,
        lockedAt: 0,
        sourceBase: "finance"
    },
    transactions: [],  // canonical recent ledger in base; legacy history may remain in shards
    ledgerIndex: {},   // retained ledger ID -> timestamp
    ledgerMeta: {
        canonical: false,
        canonicalSince: 0,
        legacyMigrationComplete: false,
        legacyImported: 0,
        legacySourceCount: 0,
        legacySourceAmount: 0,
        legacyChecksumValue: 0,
        legacySourceChecksum: "fnv1a-sum:00000000",
        lastMigrationAt: 0,
        migrationBatches: {}
    },
    stats: {
        totalTransactions: 0,
        totalPayoutsCreated: 0,
        totalPayoutsClaimed: 0,
        totalPayoutAmountCreated: 0,
        totalPayoutAmountClaimed: 0,
        totalTreasuryIn: 0,
        totalTreasuryOut: 0,
        lastUpdated: 0
    }
};

export function sanitizePayout(raw, fallbackId = "") {
    if (!raw || typeof raw !== "object") return null;
    const amount = safeInt(raw.amount ?? raw.remainingAmount, 0);
    if (amount <= 0) return null;
    const id = safeText(raw.id || fallbackId, 96);
    if (!id) return null;
    const requestedStatus = PAYOUT_STATUS.has(raw.status) ? raw.status : "pending";
    const claimOperationId = safeText(raw.claimOperationId || "", 120);
    const reservedAmount = Math.min(amount, safeInt(raw.reservedAmount, 0));
    const status = requestedStatus === "reserved" && claimOperationId && reservedAmount > 0 ? "reserved" : "pending";
    const createdAt = safeInt(raw.createdAt) || Date.now();
    return {
        id,
        amount,
        originalAmount: Math.max(amount, safeInt(raw.originalAmount, amount)),
        status,
        reservedAmount: status === "reserved" ? reservedAmount : 0,
        claimOperationId: status === "reserved" ? claimOperationId : "",
        reason: safeText(raw.reason || "Payout", 120),
        source: safeText(raw.source || "system", 64),
        fromId: safeText(raw.fromId || "", 64),
        fromName: safeText(raw.fromName || "", 32),
        operationId: safeText(raw.operationId || raw.meta?.operationId || raw.meta?.journalId || "", 120),
        createdAt,
        updatedAt: safeInt(raw.updatedAt) || createdAt,
        meta: safeObject(raw.meta)
    };
}

function sanitizeLedgerEntry(raw, fallbackId = "") {
    if (!raw || typeof raw !== "object") return null;
    const id = safeText(raw.id || fallbackId, 120);
    if (!id) return null;
    return {
        ...safeObject(raw),
        id,
        type: safeText(raw.type || "tx", 64),
        amount: safeInt(raw.amount, 0),
        source: safeText(raw.source || "", 64),
        bucket: safeText(raw.bucket || "", 64),
        reason: safeText(raw.reason || "", 160),
        createdAt: safeInt(raw.createdAt) || Date.now()
    };
}

export function validateFinanceData(data, def = DEFAULT_FINANCE_DB) {
    const out = clone(def);
    try {
        out.version = safeText(data?.version || "1.0.0", 32);
        out.schemaVersion = Math.max(1, safeInt(data?.schemaVersion ?? out.schemaVersion, 1, 1_000_000));
        if (data?.treasury && typeof data.treasury === "object") {
            out.treasury = { ...out.treasury, ...clone(data.treasury) };
            for (const [bucket, raw] of Object.entries(out.treasury)) {
                if (!raw || typeof raw !== "object" || Array.isArray(raw)) out.treasury[bucket] = {};
                for (const [key, value] of Object.entries(out.treasury[bucket])) {
                    out.treasury[bucket][key] = key === "balance"
                        ? safeInt(value, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)
                        : safeInt(value, 0);
                }
            }
        }

        out.payouts = {};
        const usedPayoutIds = new Set();
        if (data?.payouts && typeof data.payouts === "object" && !Array.isArray(data.payouts)) {
            for (const [rawPlayerId, list] of Object.entries(data.payouts)) {
                const playerId = safeText(rawPlayerId, 64);
                if (!playerId || !Array.isArray(list)) continue;
                const clean = [];
                for (let index = 0; index < list.length; index++) {
                    const raw = list[index];
                    const baseFallback = `legacy_${playerId}_${safeInt(raw?.createdAt)}_${index}`;
                    let payout = sanitizePayout(raw, baseFallback);
                    if (!payout) continue;
                    if (usedPayoutIds.has(payout.id)) payout = { ...payout, id: safeText(`${payout.id}_dup_${index}`, 96) };
                    usedPayoutIds.add(payout.id);
                    clean.push(payout);
                }
                // Deliberately no slice/count cap: every positive obligation is preserved.
                if (clean.length) out.payouts[playerId] = clean;
            }
        }

        out.claimLocks = {};
        if (data?.claimLocks && typeof data.claimLocks === "object" && !Array.isArray(data.claimLocks)) {
            for (const [rawPlayerId, raw] of Object.entries(data.claimLocks)) {
                const playerId = safeText(rawPlayerId, 64);
                const operationId = safeText(raw?.operationId, 120);
                if (!playerId || !operationId) continue;
                const hasReservation = (out.payouts[playerId] || []).some(payout => payout.status === "reserved" && payout.claimOperationId === operationId);
                if (hasReservation) out.claimLocks[playerId] = { operationId, createdAt: safeInt(raw.createdAt), updatedAt: safeInt(raw.updatedAt) || Date.now() };
            }
        }
        // Recover a missing lock from durable reservations without changing value.
        for (const [playerId, list] of Object.entries(out.payouts)) {
            if (out.claimLocks[playerId]) continue;
            const reserved = list.find(payout => payout.status === "reserved" && payout.claimOperationId);
            if (reserved) out.claimLocks[playerId] = { operationId: reserved.claimOperationId, createdAt: reserved.updatedAt, updatedAt: reserved.updatedAt };
        }

        const sourceSummary = data?.playerSummary && typeof data.playerSummary === "object" && !Array.isArray(data.playerSummary) ? data.playerSummary : {};
        out.playerSummary = {};
        const playerIds = new Set([...Object.keys(sourceSummary), ...Object.keys(out.payouts)]);
        for (const playerId of playerIds) {
            const raw = sourceSummary[playerId] && typeof sourceSummary[playerId] === "object" ? sourceSummary[playerId] : {};
            const pending = (out.payouts[playerId] || []).reduce((sum, payout) => sum + payout.amount, 0);
            out.playerSummary[playerId] = {
                name: safeText(raw.name || "Unknown", 32),
                totalReceived: safeInt(raw.totalReceived, 0),
                totalPending: pending,
                lastClaimedAt: safeInt(raw.lastClaimedAt)
            };
        }

        out.appliedOperations = AppliedOperationStore.sanitize(data?.appliedOperations);
        out.payoutSharded = !!data?.payoutSharded;
        out.payoutShardCount = Math.max(1, Math.min(128, safeInt(data?.payoutShardCount, 1, 128) || 1));
        const routing = data?.payoutRouting && typeof data.payoutRouting === "object" ? data.payoutRouting : {};
        out.payoutRouting = {
            enabled: routing.enabled ?? out.payoutSharded,
            base: safeText(routing.base || (out.payoutSharded ? "finance_payouts" : "finance"), 64).replace(/[^a-zA-Z0-9_]/g, "_") || "finance",
            shardCount: Math.max(1, Math.min(128, safeInt(routing.shardCount, 1, 128) || out.payoutShardCount)),
            algorithm: safeText(routing.algorithm || "fnv1a_imul_v2", 40),
            locked: !!routing.locked,
            lockedAt: safeInt(routing.lockedAt),
            sourceBase: safeText(routing.sourceBase || "finance", 64)
        };

        const historyLimit = Math.max(100, safeInt(FC.MAX_LEDGER_HISTORY || FC.MAX_TRANSACTIONS || 1500, 100, 10_000));
        const entries = [];
        if (Array.isArray(data?.transactions)) {
            for (let index = 0; index < data.transactions.length; index++) {
                const entry = sanitizeLedgerEntry(data.transactions[index], `legacy_tx_${index}`);
                if (entry) entries.push(entry);
            }
        }
        out.transactions = entries.slice(-historyLimit);
        out.ledgerIndex = {};
        for (const entry of out.transactions) out.ledgerIndex[entry.id] = entry.createdAt;
        if (data?.ledgerIndex && typeof data.ledgerIndex === "object") {
            for (const [id, at] of Object.entries(data.ledgerIndex)) {
                const key = safeText(id, 120); if (key && out.ledgerIndex[key] !== undefined) out.ledgerIndex[key] = safeInt(at);
            }
        }
        const meta = data?.ledgerMeta && typeof data.ledgerMeta === "object" ? data.ledgerMeta : {};
        out.ledgerMeta = {
            canonical: !!meta.canonical,
            canonicalSince: safeInt(meta.canonicalSince),
            legacyMigrationComplete: !!meta.legacyMigrationComplete,
            legacyImported: safeInt(meta.legacyImported),
            legacySourceCount: safeInt(meta.legacySourceCount),
            legacySourceAmount: safeInt(meta.legacySourceAmount),
            legacyChecksumValue: safeInt(meta.legacyChecksumValue, 0, 0xffffffff),
            legacySourceChecksum: safeText(meta.legacySourceChecksum || "fnv1a-sum:00000000", 32),
            lastMigrationAt: safeInt(meta.lastMigrationAt),
            migrationBatches: meta.migrationBatches && typeof meta.migrationBatches === "object" && !Array.isArray(meta.migrationBatches) ? safeObject(meta.migrationBatches) : {}
        };
        out.stats = { ...out.stats, ...(data?.stats && typeof data.stats === "object" ? data.stats : {}) };
        for (const key of Object.keys(out.stats)) out.stats[key] = safeInt(out.stats[key], 0);
        out.stats.lastUpdated = safeInt(out.stats.lastUpdated) || Date.now();
    } catch {
        return clone(def);
    }
    return out;
}

export default { DEFAULT_FINANCE_DB, validateFinanceData, sanitizePayout };
