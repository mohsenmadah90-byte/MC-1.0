// MCity Dashboard V2 - ATM / Source Schema

import { CONFIG } from "../config.js";

const AC = CONFIG.ATM;

export const DEFAULT_ATM_DB = {
    schemaVersion: 1,
    version: "1.1.0",
    codes: [],
    waiting: {}, // atmCode -> atm without sourceCode
    active: {},  // atmCode -> atm with sourceCode
    // Phase 1 Fix: Journal entries for crash-recoverable ATM exchanges.
    // Each entry: { id, status, playerId, playerName, atmCode, sourceCode,
    //   sourceLocation, items, totalMoney, totalScore, totalQty, createdAt,
    //   completedAt, recoveryAttempts, lastError }
    // status ∈ {pending, completed, failed, recovery_failed, recovered_payout}
    journals: {},
    pendingTransfers: {},
    stats: { totalCreated: 0, totalLinked: 0, totalExchanges: 0, lastUpdated: 0 }
};

export const DEFAULT_SOURCE_DB = {
    schemaVersion: 1,
    version: "1.0.0",
    codes: [],
    sources: {}, // sourceCode -> source
    stats: { totalCreated: 0, totalLinked: 0, lastUpdated: 0 }
};

function cleanCode(code) { return String(code || "").replace(/\D/g, "").substring(0, 4); }
function safeStr(v, max = 64) { return String(v ?? "").substring(0, max); }
function safeNum(v, d = 0) { const n = Number(v); return Number.isFinite(n) ? n : d; }

export function sanitizeATM(raw = {}, code = "") {
    return {
        code: cleanCode(raw.code || code),
        location: safeStr(raw.location, 96),
        dimension: safeStr(raw.dimension || "minecraft:overworld", 64),
        ownerId: safeStr(raw.ownerId, 64),
        owner: safeStr(raw.owner, 32),
        sourceCode: raw.sourceCode ? cleanCode(raw.sourceCode) : null,
        createdAt: safeNum(raw.createdAt || raw.created, Date.now()),
        linkedAt: safeNum(raw.linkedAt, 0),
        totalTransactions: Math.max(0, Math.floor(safeNum(raw.totalTransactions, 0))),
        totalMoneyMinted: Math.max(0, Math.floor(safeNum(raw.totalMoneyMinted, 0))),
        totalScoreGiven: Math.max(0, Math.floor(safeNum(raw.totalScoreGiven, 0))),
        lastUsedAt: safeNum(raw.lastUsedAt, 0),
        sourceStats: raw.sourceStats && typeof raw.sourceStats === "object" ? JSON.parse(JSON.stringify(raw.sourceStats)) : {}
    };
}

export function sanitizeSource(raw = {}, code = "") {
    return {
        code: cleanCode(raw.code || code),
        location: safeStr(raw.location, 96),
        dimension: safeStr(raw.dimension || "minecraft:overworld", 64),
        ownerId: safeStr(raw.ownerId, 64),
        owner: safeStr(raw.owner, 32),
        atmCodes: Array.isArray(raw.atmCodes) ? raw.atmCodes.map(cleanCode).filter(Boolean).slice(0, AC.MAX_ATMS_PER_SOURCE) : [],
        createdAt: safeNum(raw.createdAt, Date.now()),
        totalEarned: Math.max(0, Math.floor(safeNum(raw.totalEarned, 0))),
        totalTransactions: Math.max(0, Math.floor(safeNum(raw.totalTransactions, 0))),
        lastUsedAt: safeNum(raw.lastUsedAt, 0)
    };
}

export function sanitizeJournal(raw) {
    if (!raw || typeof raw !== "object") return null;
    const id = safeStr(raw.id, 80);
    if (!id) return null;
    const validStatuses = ["pending", "completed", "failed", "recovery_failed", "recovered_payout"];
    const status = validStatuses.includes(raw.status) ? raw.status : "pending";
    // Sanitize items object (itemId -> amount).
    const items = {};
    if (raw.items && typeof raw.items === "object" && !Array.isArray(raw.items)) {
        for (const [k, v] of Object.entries(raw.items)) {
            const itemId = safeStr(k, 64);
            const amt = Math.max(0, Math.floor(safeNum(v, 0)));
            if (itemId && amt > 0) items[itemId] = amt;
        }
    }
    return {
        id,
        status,
        playerId: safeStr(raw.playerId, 64),
        playerName: safeStr(raw.playerName, 32),
        atmCode: cleanCode(raw.atmCode),
        sourceCode: cleanCode(raw.sourceCode),
        sourceLocation: safeStr(raw.sourceLocation, 96),
        items,
        totalMoney: Math.max(0, Math.floor(safeNum(raw.totalMoney, 0))),
        totalScore: Math.max(0, Math.floor(safeNum(raw.totalScore, 0))),
        totalQty: Math.max(0, Math.floor(safeNum(raw.totalQty, 0))),
        createdAt: safeNum(raw.createdAt, Date.now()),
        completedAt: safeNum(raw.completedAt, 0),
        recoveryAttempts: Math.max(0, Math.floor(safeNum(raw.recoveryAttempts, 0))),
        lastError: safeStr(raw.lastError, 300)
    };
}

export function validateATMData(data, def = DEFAULT_ATM_DB) {
    const out = JSON.parse(JSON.stringify(def));
    try {
        out.version = data?.version || "1.1.0";
        out.schemaVersion = Math.max(1, Math.floor(Number(data?.schemaVersion) || Number(out.schemaVersion) || 1));
        out.codes = Array.isArray(data?.codes) ? data.codes.map(cleanCode).filter(Boolean).slice(-AC.MAX_CODES_HISTORY) : [];
        if (data?.waiting && typeof data.waiting === "object" && !Array.isArray(data.waiting)) {
            for (const [code, raw] of Object.entries(data.waiting)) {
                const c = cleanCode(code); if (!c || !raw?.location) continue;
                out.waiting[c] = sanitizeATM({ ...raw, sourceCode: null }, c);
                if (Object.keys(out.waiting).length >= AC.MAX_WAITING_ATMS) break;
            }
        }
        if (data?.active && typeof data.active === "object" && !Array.isArray(data.active)) {
            for (const [code, raw] of Object.entries(data.active)) {
                const c = cleanCode(code); if (!c || !raw?.location || !raw?.sourceCode) continue;
                out.active[c] = sanitizeATM(raw, c);
                if (Object.keys(out.active).length >= AC.MAX_ACTIVE_ATMS) break;
            }
        }
        // Phase 1 Fix: Preserve and sanitize journal entries across DB loads.
        // Journals are critical for crash recovery — losing them would mean
        // pending exchanges can never be compensated. Cap to 200 most recent.
        out.journals = {};
        if (data?.journals && typeof data.journals === "object" && !Array.isArray(data.journals)) {
            const valid = [];
            for (const raw of Object.values(data.journals)) {
                const j = sanitizeJournal(raw);
                if (j) valid.push(j);
            }
            // Preserve every active/recovery journal. Terminal history may be
            // retained later by a marker-aware policy, never by raw count.
            valid.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
            for (const j of valid) out.journals[j.id] = j;
        }
        out.pendingTransfers = {};
        if (data?.pendingTransfers && typeof data.pendingTransfers === "object" && !Array.isArray(data.pendingTransfers)) {
            for (const [atmCode, raw] of Object.entries(data.pendingTransfers)) {
                const items = {};
                for (const [id, value] of Object.entries(raw?.items || {})) { const amount = Math.max(0, Math.floor(Number(value) || 0)); if (amount) items[String(id).slice(0, 80)] = amount; }
                if (Object.keys(items).length) out.pendingTransfers[String(atmCode).replace(/\D/g, "").slice(0, 4)] = { items, updatedAt: Number(raw.updatedAt) || Date.now() };
            }
        }
        out.stats = { ...out.stats, ...(data?.stats || {}) };
    } catch {
        return JSON.parse(JSON.stringify(def));
    }
    return out;
}

export function validateSourceData(data, def = DEFAULT_SOURCE_DB) {
    const out = JSON.parse(JSON.stringify(def));
    try {
        out.version = data?.version || "1.0.0";
        out.schemaVersion = Math.max(1, Math.floor(Number(data?.schemaVersion) || Number(out.schemaVersion) || 1));
        out.codes = Array.isArray(data?.codes) ? data.codes.map(cleanCode).filter(Boolean).slice(-AC.MAX_CODES_HISTORY) : [];
        if (data?.sources && typeof data.sources === "object" && !Array.isArray(data.sources)) {
            for (const [code, raw] of Object.entries(data.sources)) {
                const c = cleanCode(code); if (!c || !raw?.location) continue;
                out.sources[c] = sanitizeSource(raw, c);
            }
        }
        out.stats = { ...out.stats, ...(data?.stats || {}) };
    } catch {
        return JSON.parse(JSON.stringify(def));
    }
    return out;
}

export default { DEFAULT_ATM_DB, DEFAULT_SOURCE_DB, validateATMData, validateSourceData, sanitizeATM, sanitizeSource, sanitizeJournal };
