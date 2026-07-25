// MCity Dashboard V2 - Contract Schema
// Phase 7.4 (v0.21.3): Incremental index helpers (S8) + paidOutCents
//                     preservation (CT1).

import { CONFIG } from "../config.js";

const CC = CONFIG.CONTRACTS;

export const DEFAULT_CONTRACT_DB = {
    schemaVersion: 1,
    version: "1.0.0",
    contracts: {},       // contractId -> contract
    playerIndex: {},     // playerId -> { created: [], accepted: [] }
    itemMailbox: {},     // playerId -> item delivery entries
    progress: {},        // contractId -> playerId -> progress for contribution contracts
    playerStats: {},     // reputation foundation
    rewardQueue: {},     // obligationId -> pending/journaled/completed reward delivery
    stats: {
        totalContractsCreated: 0,
        totalContractsCompleted: 0,
        totalItemsSubmitted: 0,
        totalRewardsPaid: 0,
        totalRewardsQueued: 0,
        totalRewardsDelivered: 0,
        totalFeesCollected: 0,
        lastUpdated: 0
    },
    seeded: false,
    audit: []
};

function now() { return Date.now(); }
function safeInt(v, d = 0) { const n = Math.floor(Number(v)); return Number.isFinite(n) ? n : d; }
export function normalizeItemId(itemId) { const raw = String(itemId || "").trim().toLowerCase(); return raw.includes(":") ? raw : `minecraft:${raw || "stone"}`; }
export function contractId(prefix = "ctr") { return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1000000)}`; }

export function validCategory(cat) {
    const id = String(cat || "other");
    return CC.CATEGORIES[id] ? id : "other";
}

export function sanitizePlayerStats(raw = {}, playerId = "") {
    return {
        playerId,
        name: String(raw.name || "Unknown").substring(0, 32),
        reputation: safeInt(raw.reputation, 0),
        contractsCreated: safeInt(raw.contractsCreated, 0),
        contractsAccepted: safeInt(raw.contractsAccepted, 0),
        contractsCompleted: safeInt(raw.contractsCompleted, 0),
        contributions: safeInt(raw.contributions, 0),
        itemsSubmitted: safeInt(raw.itemsSubmitted, 0),
        totalEarnedCents: safeInt(raw.totalEarnedCents, 0),
        totalSpentCents: safeInt(raw.totalSpentCents, 0),
        updatedAt: Number(raw.updatedAt) || now()
    };
}

export function sanitizeContract(raw = {}) {
    const id = String(raw.id || contractId()).substring(0, 64);
    const type = ["server_market_supply", "player_supply", "player_contribution"].includes(raw.type) ? raw.type : "player_supply";
    const amountRequired = Math.max(1, safeInt(raw.amountRequired, 1));
    const amountSubmitted = Math.max(0, Math.min(amountRequired, safeInt(raw.amountSubmitted, 0)));
    const statusList = ["active", "open", "accepted", "completed", "cancelled", "expired"];
    return {
        id,
        type,
        category: validCategory(raw.category),
        title: String(raw.title || "Contract").substring(0, 80),
        description: String(raw.description || "").substring(0, 240),
        itemId: normalizeItemId(raw.itemId || "minecraft:stone"),
        amountRequired,
        amountSubmitted,
        rewardCents: Math.max(0, safeInt(raw.rewardCents, 0)),
        rewardScore: Math.max(0, safeInt(raw.rewardScore, 0)),
        escrowCents: Math.max(0, safeInt(raw.escrowCents, 0)),
        paidOutCents: Math.max(0, safeInt(raw.paidOutCents, 0)),
        feeCents: Math.max(0, safeInt(raw.feeCents, 0)),
        creatorId: String(raw.creatorId || "server").substring(0, 64),
        creatorName: String(raw.creatorName || "Server").substring(0, 32),
        acceptedBy: raw.acceptedBy ? String(raw.acceptedBy).substring(0, 64) : null,
        acceptedByName: raw.acceptedByName ? String(raw.acceptedByName).substring(0, 32) : null,
        status: statusList.includes(raw.status) ? raw.status : (type === "server_market_supply" ? "active" : "open"),
        resetMode: ["once", "daily", "weekly"].includes(raw.resetMode) ? raw.resetMode : "once",
        timeLimitSeconds: Math.max(60, safeInt(raw.timeLimitSeconds, 86400)),
        deadlineAt: Number(raw.deadlineAt) || 0,
        expiresAt: Number(raw.expiresAt) || 0,
        nextResetAt: Number(raw.nextResetAt) || 0,
        deliveries: Array.isArray(raw.deliveries) ? raw.deliveries.slice(-200) : [],
        createdAt: Number(raw.createdAt) || now(),
        acceptedAt: Number(raw.acceptedAt) || 0,
        updatedAt: Number(raw.updatedAt) || now(),
        completions: safeInt(raw.completions, 0)
    };
}

export function rebuildContractIndexes(db) {
    db.playerIndex = {};
    for (const c of Object.values(db.contracts || {})) {
        if (c.creatorId && c.creatorId !== "server") {
            if (!db.playerIndex[c.creatorId]) db.playerIndex[c.creatorId] = { created: [], accepted: [] };
            db.playerIndex[c.creatorId].created.push(c.id);
        }
        if (c.acceptedBy) {
            if (!db.playerIndex[c.acceptedBy]) db.playerIndex[c.acceptedBy] = { created: [], accepted: [] };
            db.playerIndex[c.acceptedBy].accepted.push(c.id);
        }
    }
}

/**
 * Phase 7.4 (v0.21.3) (S8): Incrementally add a contract to the player index.
 *
 * Use this instead of `rebuildContractIndexes(db)` when a single contract is
 * created or its acceptedBy changes. The full rebuild is O(N) over all
 * contracts; this is O(1) per affected player.
 *
 * @param {object} db - the contract DB data object (inside a transaction)
 * @param {object} contract - the contract being added/updated
 */
export function addToContractIndex(db, contract) {
    if (!db.playerIndex) db.playerIndex = {};
    if (contract.creatorId && contract.creatorId !== "server") {
        if (!db.playerIndex[contract.creatorId]) db.playerIndex[contract.creatorId] = { created: [], accepted: [] };
        if (!db.playerIndex[contract.creatorId].created.includes(contract.id)) {
            db.playerIndex[contract.creatorId].created.push(contract.id);
        }
    }
    if (contract.acceptedBy) {
        if (!db.playerIndex[contract.acceptedBy]) db.playerIndex[contract.acceptedBy] = { created: [], accepted: [] };
        if (!db.playerIndex[contract.acceptedBy].accepted.includes(contract.id)) {
            db.playerIndex[contract.acceptedBy].accepted.push(contract.id);
        }
    }
}

/**
 * Phase 7.4 (v0.21.3) (S8): Incrementally remove a contract from the player
 * index. Use when a contract is deleted or its acceptedBy is cleared.
 *
 * @param {object} db - the contract DB data object (inside a transaction)
 * @param {object} contract - the contract being removed (or its key fields)
 */
export function removeFromContractIndex(db, contract) {
    if (!db.playerIndex || !contract) return;
    if (contract.creatorId && db.playerIndex[contract.creatorId]) {
        db.playerIndex[contract.creatorId].created = db.playerIndex[contract.creatorId].created.filter(id => id !== contract.id);
    }
    if (contract.acceptedBy && db.playerIndex[contract.acceptedBy]) {
        db.playerIndex[contract.acceptedBy].accepted = db.playerIndex[contract.acceptedBy].accepted.filter(id => id !== contract.id);
    }
}

export function sanitizeRewardObligation(raw = {}, idValue = "") {
    const statusList = ["pending", "journaled", "completed", "failed"];
    return {
        id: String(idValue || raw.id || `reward_${Date.now()}_${Math.floor(Math.random() * 1000000)}`).substring(0, 80),
        contractId: String(raw.contractId || "").substring(0, 80),
        playerId: String(raw.playerId || "").substring(0, 64),
        playerName: String(raw.playerName || "Unknown").substring(0, 32),
        rewardCents: Math.max(0, safeInt(raw.rewardCents, 0)),
        score: Math.max(0, safeInt(raw.score, 0)),
        reason: String(raw.reason || "Contract reward").substring(0, 120),
        status: statusList.includes(raw.status) ? raw.status : "pending",
        journalId: raw.journalId ? String(raw.journalId).substring(0, 100) : "",
        createdAt: Number(raw.createdAt) || now(),
        updatedAt: Number(raw.updatedAt) || now(),
        attempts: Math.max(0, safeInt(raw.attempts, 0)),
        lastError: String(raw.lastError || "").substring(0, 300)
    };
}

export function validateContractData(data, def = DEFAULT_CONTRACT_DB) {
    const out = JSON.parse(JSON.stringify(def));
    try {
        out.version = data?.version || "1.0.0";
        out.schemaVersion = Math.max(1, Math.floor(Number(data?.schemaVersion) || Number(out.schemaVersion) || 1));
        if (data?.contracts && typeof data.contracts === "object") {
            for (const [id, raw] of Object.entries(data.contracts)) {
                const c = sanitizeContract({ ...raw, id });
                out.contracts[c.id] = c;
            }
        }
        out.itemMailbox = data?.itemMailbox && typeof data.itemMailbox === "object" ? data.itemMailbox : {};
        for (const [pid, list] of Object.entries(out.itemMailbox)) if (!Array.isArray(list)) delete out.itemMailbox[pid]; // preserve all positive economic entries
        out.progress = data?.progress && typeof data.progress === "object" ? data.progress : {};
        out.rewardQueue = {};
        if (data?.rewardQueue && typeof data.rewardQueue === "object") {
            for (const [rid, raw] of Object.entries(data.rewardQueue)) {
                const r = sanitizeRewardObligation(raw, rid);
                if (r.playerId && (r.rewardCents > 0 || r.score > 0)) out.rewardQueue[r.id] = r;
            }
        }
        out.playerStats = {};
        if (data?.playerStats && typeof data.playerStats === "object") for (const [pid, raw] of Object.entries(data.playerStats)) out.playerStats[pid] = sanitizePlayerStats(raw, pid);
        out.stats = { ...out.stats, ...(data?.stats || {}) };
        out.seeded = !!data?.seeded;
        out.audit = Array.isArray(data?.audit) ? data.audit.slice(-1000) : [];
        rebuildContractIndexes(out);
    } catch {
        return JSON.parse(JSON.stringify(def));
    }
    return out;
}

export default { DEFAULT_CONTRACT_DB, validateContractData, sanitizeContract, sanitizeRewardObligation, rebuildContractIndexes, addToContractIndex, removeFromContractIndex, normalizeItemId, contractId };
