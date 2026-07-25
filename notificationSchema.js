// MCity Dashboard V2 - Notification Schema
// Phase 7.5 (v0.22.0): Added !Array.isArray guards on object type checks (DB8).

import { CONFIG } from "../config.js";

const NC = CONFIG.NOTIFICATIONS;

export const DEFAULT_NOTIFICATION_DB = {
    schemaVersion: 1,
    version: "1.0.0",
    players: {}, // playerId -> [{ id, type, source, title, message, action, read, createdAt, meta }]
    systemEvents: [],
    shardEnabled: false,
    shardCount: 1,
    stats: {
        totalCreated: 0,
        totalRead: 0,
        lastCreatedAt: 0
    }
};

function sanitizeNotification(n) {
    if (!n || typeof n !== "object") return null;
    return {
        id: String(n.id || `note_${Date.now()}_${Math.floor(Math.random() * 1000000)}`).substring(0, 64),
        type: String(n.type || "info").substring(0, 32),
        source: String(n.source || "system").substring(0, 64),
        // Phase 7.5 (v0.22.0): Strip §-color codes from notification fields
        // as defense-in-depth. The service sanitizes before saving, but a
        // restored pre-sanitization backup could carry color codes.
        title: String(n.title || "Notification").replace(/§[0-9a-fgklmnorA-FGKLMNOR]/g, "").substring(0, 80),
        message: String(n.message || "").replace(/§[0-9a-fgklmnorA-FGKLMNOR]/g, "").substring(0, 260),
        action: n.action ? String(n.action).replace(/§[0-9a-fgklmnorA-FGKLMNOR]/g, "").substring(0, 64) : "",
        read: !!n.read,
        createdAt: Number(n.createdAt) || Date.now(),
        meta: n.meta && typeof n.meta === "object" ? n.meta : {}
    };
}

export function validateNotificationData(data, def = DEFAULT_NOTIFICATION_DB) {
    const out = JSON.parse(JSON.stringify(def));
    try {
        out.version = data?.version || "1.0.0";
        out.schemaVersion = Math.max(1, Math.floor(Number(data?.schemaVersion) || Number(out.schemaVersion) || 1));
        out.players = {};
        // Phase 7.5 (v0.22.0) (DB8): `typeof [] === "object"` is true, so
        // a corrupted DB with `players` as an array would iterate array
        // indices as player IDs ("0", "1", ...) and corrupt the data model.
        // Add `&& !Array.isArray(...)` to every object type check.
        if (data?.players && typeof data.players === "object" && !Array.isArray(data.players)) {
            for (const [pid, list] of Object.entries(data.players)) {
                if (!Array.isArray(list)) continue;
                const clean = list.map(sanitizeNotification).filter(Boolean).slice(-NC.MAX_PER_PLAYER);
                if (clean.length) out.players[pid] = clean;
            }
        }
        out.systemEvents = Array.isArray(data?.systemEvents) ? data.systemEvents.map(sanitizeNotification).filter(Boolean).slice(-NC.MAX_SYSTEM_EVENTS) : [];
        out.shardEnabled = !!data?.shardEnabled;
        out.shardCount = Math.max(1, Math.floor(Number(data?.shardCount) || 1));
        out.stats = { ...out.stats, ...(data?.stats && typeof data.stats === "object" && !Array.isArray(data.stats) ? data.stats : {}) };
        out.stats.totalCreated = Math.max(0, Math.floor(Number(out.stats.totalCreated) || 0));
        out.stats.totalRead = Math.max(0, Math.floor(Number(out.stats.totalRead) || 0));
        out.stats.lastCreatedAt = Math.max(0, Math.floor(Number(out.stats.lastCreatedAt) || 0));
    } catch {
        return JSON.parse(JSON.stringify(def));
    }
    return out;
}

export default { DEFAULT_NOTIFICATION_DB, validateNotificationData };
