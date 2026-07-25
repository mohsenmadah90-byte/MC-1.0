// MCity Dashboard V2 - Item Settings Schema
// v1.8.5: Admin overrides for catalog flags (marketable / contractable).

export const DEFAULT_ITEM_SETTINGS_DB = {
    schemaVersion: 1,
    version: "1.0.0",
    overrides: {},
    stats: {
        totalOverrides: 0,
        lastUpdated: 0
    }
};

function normalizeId(id) {
    const raw = String(id || "").trim().toLowerCase();
    return raw.includes(":") ? raw.substring(0, 80) : `minecraft:${raw}`.substring(0, 80);
}

export function validateItemSettingsData(data, def = DEFAULT_ITEM_SETTINGS_DB) {
    const out = JSON.parse(JSON.stringify(def));
    try {
        out.version = data?.version || "1.0.0";
        out.schemaVersion = Math.max(1, Math.floor(Number(data?.schemaVersion) || Number(out.schemaVersion) || 1));
        const src = data?.overrides && typeof data.overrides === "object" && !Array.isArray(data.overrides) ? data.overrides : {};
        for (const [id, raw] of Object.entries(src)) {
            if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
            const itemId = normalizeId(id);
            const o = {};
            if (typeof raw.marketable === "boolean") o.marketable = raw.marketable;
            if (typeof raw.contractable === "boolean") o.contractable = raw.contractable;
            if (!Object.prototype.hasOwnProperty.call(o, "marketable") && !Object.prototype.hasOwnProperty.call(o, "contractable")) continue;
            o.updatedBy = String(raw.updatedBy || "system").substring(0, 64);
            o.updatedAt = Number(raw.updatedAt) || Date.now();
            out.overrides[itemId] = o;
        }
        out.stats = { ...out.stats, ...(data?.stats || {}) };
        out.stats.totalOverrides = Object.keys(out.overrides).length;
        out.stats.lastUpdated = Number(out.stats.lastUpdated) || 0;
    } catch {
        return JSON.parse(JSON.stringify(def));
    }
    return out;
}

export default { DEFAULT_ITEM_SETTINGS_DB, validateItemSettingsData };
