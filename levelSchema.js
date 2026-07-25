// MCity Dashboard V2 - Level Schema

import { CONFIG } from "../config.js";
import { AppliedOperationStore } from "../core/appliedOperationStore.js";

const MAX_SCORE = CONFIG.LEVEL.MAX_SCORE;

function levelByScore(score) {
    const levels = CONFIG.LEVEL.LEVELS || [];
    for (const level of levels) if (score >= level.min && score <= level.max) return level;
    return levels[levels.length - 1] || { name: "Unknown", color: "§7", bonuses: {} };
}

export const DEFAULT_LEVEL_DB = {
    schemaVersion: 1,
    version: "1.0.0",
    players: {}, // playerId -> { id, name, score, levelName, firstSeen, lastSeen, updatedAt }
    appliedOperations: {}, // operationId -> score delivery marker
    stats: {
        totalKnownPlayers: 0,
        lastUpdated: 0
    }
};

export function validateLevelData(data, def = DEFAULT_LEVEL_DB) {
    const out = JSON.parse(JSON.stringify(def));
    try {
        out.version = data?.version || "1.0.0";
        out.schemaVersion = Math.max(1, Math.floor(Number(data?.schemaVersion) || Number(out.schemaVersion) || 1));
        if (data?.players && typeof data.players === "object") {
            for (const [id, rec] of Object.entries(data.players)) {
                if (!id || !rec || typeof rec !== "object") continue;
                const score = Math.max(0, Math.min(MAX_SCORE, Math.floor(Number(rec.score) || 0)));
                const level = levelByScore(score);
                out.players[id] = {
                    id,
                    name: String(rec.name || "Unknown").substring(0, 32),
                    score,
                    levelName: level.name,
                    firstSeen: Number(rec.firstSeen) || Number(rec.lastSeen) || 0,
                    lastSeen: Number(rec.lastSeen) || 0,
                    updatedAt: Number(rec.updatedAt) || Date.now()
                };
            }
        }
        out.appliedOperations = AppliedOperationStore.sanitize(data?.appliedOperations);
        out.stats = { ...out.stats, ...(data?.stats || {}) };
        out.stats.totalKnownPlayers = Object.keys(out.players).length;
    } catch {
        return JSON.parse(JSON.stringify(def));
    }
    return out;
}

export default { DEFAULT_LEVEL_DB, validateLevelData };
