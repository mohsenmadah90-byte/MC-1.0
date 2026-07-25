// MCity Dashboard V2 - Land Entry Pass Shard Schema
// v1.9.8 Sharding Phase 6: player-sharded entry/toll passes.

export const DEFAULT_LAND_ENTRY_PASS_SHARD_DB = {
    schemaVersion: 1,
    version: "1.0.0",
    entryPasses: {}, // playerId -> { claimId: expiresAt }
    stats: {
        totalPlayers: 0,
        totalPasses: 0,
        lastUpdated: 0
    }
};

function safeExpiry(v) { return Math.max(0, Math.floor(Number(v) || 0)); }

export function validateLandEntryPassShardData(data, def = DEFAULT_LAND_ENTRY_PASS_SHARD_DB) {
    const out = JSON.parse(JSON.stringify(def));
    try {
        out.version = data?.version || "1.0.0";
        out.schemaVersion = Math.max(1, Math.floor(Number(data?.schemaVersion) || Number(out.schemaVersion) || 1));
        const src = data?.entryPasses && typeof data.entryPasses === "object" && !Array.isArray(data.entryPasses) ? data.entryPasses : {};
        for (const [pid, passes] of Object.entries(src)) {
            if (!passes || typeof passes !== "object" || Array.isArray(passes)) continue;
            const clean = {};
            for (const [claimId, expires] of Object.entries(passes)) {
                const expiry = safeExpiry(expires);
                if (claimId && expiry > 0) clean[String(claimId).substring(0, 100)] = expiry;
            }
            if (Object.keys(clean).length) out.entryPasses[String(pid).substring(0, 64)] = clean;
        }
        out.stats = { ...out.stats, ...(data?.stats || {}) };
        out.stats.totalPlayers = Object.keys(out.entryPasses).length;
        out.stats.totalPasses = Object.values(out.entryPasses).reduce((s, p) => s + Object.keys(p || {}).length, 0);
        out.stats.lastUpdated = Number(out.stats.lastUpdated) || 0;
    } catch {
        return JSON.parse(JSON.stringify(def));
    }
    return out;
}

export default { DEFAULT_LAND_ENTRY_PASS_SHARD_DB, validateLandEntryPassShardData };
