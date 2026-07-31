// MCity Dashboard V2 - Audit Schema
// Phase 7.5 (v0.22.0): Added !Array.isArray guards on object type checks (DB8).

import { CONFIG } from "../config.js";

const DEFAULT_MAX_EVENTS = 3000;
const DEFAULT_MAX_SNAPSHOTS = 100;

export const DEFAULT_AUDIT_DB = {
    schemaVersion: 1,
    version: "1.0.0",
    events: [],
    counters: {},
    sourceCounters: {},
    severityCounters: {},
    healthSnapshots: [],
    stats: { totalEvents: 0, lastEventAt: 0, lastHealthAt: 0 }
};

function sanitizeEvent(e = {}) {
    if (!e || typeof e !== "object") return null;
    return {
        id: String(e.id || `aud_${Date.now()}_${Math.floor(Math.random() * 1000000)}`).substring(0, 64),
        time: Number(e.time) || Date.now(),
        type: String(e.type || "system.event").substring(0, 80),
        source: String(e.source || "system").substring(0, 64),
        severity: String(e.severity || "info").substring(0, 20),
        actorId: String(e.actorId || "").substring(0, 64),
        actorName: String(e.actorName || "").substring(0, 32),
        message: String(e.message || "").substring(0, 240),
        meta: e.meta && typeof e.meta === "object" ? e.meta : {}
    };
}

export function validateAuditData(data, def = DEFAULT_AUDIT_DB) {
    const out = JSON.parse(JSON.stringify(def));
    try {
        out.version = data?.version || "1.0.0";
        out.schemaVersion = Math.max(1, Math.floor(Number(data?.schemaVersion) || Number(out.schemaVersion) || 1));
        out.events = Array.isArray(data?.events) ? data.events.map(sanitizeEvent).filter(Boolean).slice(-DEFAULT_MAX_EVENTS) : [];
        out.counters = data?.counters && typeof data.counters === "object" && !Array.isArray(data.counters) ? data.counters : {};
        out.sourceCounters = data?.sourceCounters && typeof data.sourceCounters === "object" && !Array.isArray(data.sourceCounters) ? data.sourceCounters : {};
        out.severityCounters = data?.severityCounters && typeof data.severityCounters === "object" && !Array.isArray(data.severityCounters) ? data.severityCounters : {};
        out.healthSnapshots = Array.isArray(data?.healthSnapshots) ? data.healthSnapshots.filter(Boolean).slice(-DEFAULT_MAX_SNAPSHOTS) : [];
        out.stats = { ...out.stats, ...(data?.stats && typeof data.stats === "object" && !Array.isArray(data.stats) ? data.stats : {}) };
    } catch {
        return JSON.parse(JSON.stringify(def));
    }
    return out;
}

export default { DEFAULT_AUDIT_DB, validateAuditData };
