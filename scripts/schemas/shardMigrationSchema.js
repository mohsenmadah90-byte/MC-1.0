// MCity Dashboard V2 - Shard Migration Journal Schema
// v1.9.0: tracks safe sharding migrations before module-specific migrations run.

export const DEFAULT_SHARD_MIGRATION_DB = {
    schemaVersion: 1,
    version: "1.0.0",
    migrations: {},
    order: [],
    stats: {
        totalStarted: 0,
        totalCompleted: 0,
        totalFailed: 0,
        lastUpdated: 0
    }
};

const VALID_STATUS = new Set(["planned", "copying", "verifying", "committed", "failed", "rolled_back"]);
function now() { return Date.now(); }
function safeText(v, max = 120) { return String(v || "").substring(0, max); }
function safeObj(v) { try { return JSON.parse(JSON.stringify(v || {})); } catch { return {}; } }

export function sanitizeShardMigration(raw = {}, idValue = "") {
    const id = safeText(idValue || raw.id || `mig_${now()}_${Math.floor(Math.random() * 1000000)}`, 100);
    const status = VALID_STATUS.has(raw.status) ? raw.status : "planned";
    return {
        id,
        name: safeText(raw.name || id, 100),
        module: safeText(raw.module || "unknown", 60),
        status,
        sourceCollection: safeText(raw.sourceCollection || "", 100),
        targetCollections: Array.isArray(raw.targetCollections) ? raw.targetCollections.map(x => safeText(x, 100)).slice(0, 128) : [],
        shardType: safeText(raw.shardType || "", 40),
        shardCount: Math.max(1, Math.floor(Number(raw.shardCount) || 1)),
        counts: safeObj(raw.counts),
        checksum: safeText(raw.checksum || "", 120),
        startedAt: Number(raw.startedAt) || now(),
        updatedAt: Number(raw.updatedAt) || now(),
        completedAt: Number(raw.completedAt) || 0,
        error: safeText(raw.error || "", 300),
        meta: safeObj(raw.meta)
    };
}

export function validateShardMigrationData(data, def = DEFAULT_SHARD_MIGRATION_DB) {
    const out = JSON.parse(JSON.stringify(def));
    try {
        out.version = data?.version || "1.0.0";
        out.schemaVersion = Math.max(1, Math.floor(Number(data?.schemaVersion) || Number(out.schemaVersion) || 1));
        const migrations = data?.migrations && typeof data.migrations === "object" && !Array.isArray(data.migrations) ? data.migrations : {};
        let order = Array.isArray(data?.order) ? data.order.filter(id => migrations[id]) : Object.keys(migrations);
        const seen = new Set(order);
        for (const id of Object.keys(migrations)) if (!seen.has(id)) order.push(id);
        order = order.slice(-500);
        for (const id of order) out.migrations[id] = sanitizeShardMigration(migrations[id], id);
        out.order = order.filter(id => out.migrations[id]);
        out.stats = { ...out.stats, ...(data?.stats || {}) };
        out.stats.lastUpdated = Number(out.stats.lastUpdated) || now();
    } catch {
        return JSON.parse(JSON.stringify(def));
    }
    return out;
}

export default { DEFAULT_SHARD_MIGRATION_DB, validateShardMigrationData, sanitizeShardMigration };
