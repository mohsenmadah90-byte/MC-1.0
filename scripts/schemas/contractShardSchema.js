// MCity Dashboard V2 - Contract Shard Schemas
// v1.9.6 Sharding Phase 4: player-sharded contract delivery mailboxes.

import { CONFIG } from "../config.js";

const CC = CONFIG.CONTRACTS;

export const DEFAULT_CONTRACT_MAILBOX_SHARD_DB = {
    schemaVersion: 1,
    version: "1.0.0",
    itemMailbox: {}, // playerId -> [{id,itemId,amount,contractId,fromName,createdAt}]
    stats: {
        totalPlayers: 0,
        totalEntries: 0,
        lastUpdated: 0
    }
};

function now() { return Date.now(); }
function safeText(v, max = 120) { return String(v || "").substring(0, max); }
function safeInt(v, min = 0) { const n = Math.floor(Number(v) || 0); return Math.max(min, n); }

export function sanitizeContractMailboxEntry(raw = {}) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const amount = safeInt(raw.amount, 0);
    const itemId = safeText(raw.itemId || "", 100);
    if (!itemId || amount <= 0) return null;
    return {
        id: safeText(raw.id || `mail_${now()}_${Math.floor(Math.random() * 1000000)}`, 100),
        itemId,
        amount,
        contractId: safeText(raw.contractId || "", 100),
        fromName: safeText(raw.fromName || "", 32),
        createdAt: Number(raw.createdAt) || now()
    };
}

export function validateContractMailboxShardData(data, def = DEFAULT_CONTRACT_MAILBOX_SHARD_DB) {
    const out = JSON.parse(JSON.stringify(def));
    try {
        out.version = data?.version || "1.0.0";
        out.schemaVersion = Math.max(1, Math.floor(Number(data?.schemaVersion) || Number(out.schemaVersion) || 1));
        const src = data?.itemMailbox && typeof data.itemMailbox === "object" && !Array.isArray(data.itemMailbox) ? data.itemMailbox : {};
        for (const [pid, list] of Object.entries(src)) {
            if (!Array.isArray(list)) continue;
            const clean = list.map(sanitizeContractMailboxEntry).filter(Boolean); // never trim economic obligations
            if (clean.length) out.itemMailbox[pid] = clean;
        }
        out.stats = { ...out.stats, ...(data?.stats || {}) };
        out.stats.totalPlayers = Object.keys(out.itemMailbox).length;
        out.stats.totalEntries = Object.values(out.itemMailbox).reduce((s, list) => s + list.length, 0);
        out.stats.lastUpdated = Number(out.stats.lastUpdated) || 0;
    } catch {
        return JSON.parse(JSON.stringify(def));
    }
    return out;
}

export default { DEFAULT_CONTRACT_MAILBOX_SHARD_DB, validateContractMailboxShardData, sanitizeContractMailboxEntry };
