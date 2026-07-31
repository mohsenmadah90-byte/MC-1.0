// MCity Dashboard V2 - Persisted Batch Task Schema
// Phase 2.3: resumable cursor tasks; running tasks become queued on reload.

export const DEFAULT_BATCH_TASK_DB = {
    schemaVersion: 1,
    version: "1.0.0",
    tasks: {},
    order: [],
    stats: { totalStarted: 0, totalCompleted: 0, totalFailed: 0, totalBatches: 0, lastUpdated: 0 }
};

const TERMINAL = new Set(["completed", "failed", "cancelled"]);
function safeObject(value) { try { return JSON.parse(JSON.stringify(value || {})); } catch { return {}; } }
function safeText(value, max = 160) { return String(value || "").substring(0, max); }

export function sanitizeBatchTask(raw = {}, idValue = "") {
    const id = safeText(idValue || raw.id || `task_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`, 100);
    let status = ["queued", "running", "completed", "failed", "cancelled"].includes(raw.status) ? raw.status : "queued";
    if (status === "running") status = "queued"; // crash/reload resume
    return {
        id,
        type: safeText(raw.type || "unknown", 80),
        dedupeKey: safeText(raw.dedupeKey || "", 120),
        status,
        payload: safeObject(raw.payload),
        cursor: safeObject(raw.cursor),
        progress: safeObject(raw.progress),
        result: safeObject(raw.result),
        attempts: Math.max(0, Math.floor(Number(raw.attempts) || 0)),
        batches: Math.max(0, Math.floor(Number(raw.batches) || 0)),
        createdAt: Number(raw.createdAt) || Date.now(),
        updatedAt: Number(raw.updatedAt) || Date.now(),
        startedAt: Number(raw.startedAt) || 0,
        completedAt: Number(raw.completedAt) || 0,
        lastError: safeText(raw.lastError || "", 500)
    };
}

export function validateBatchTaskData(data, def = DEFAULT_BATCH_TASK_DB) {
    const out = JSON.parse(JSON.stringify(def));
    try {
        out.version = data?.version || "1.0.0";
        out.schemaVersion = Math.max(1, Math.floor(Number(data?.schemaVersion) || Number(out.schemaVersion) || 1));
        const source = data?.tasks && typeof data.tasks === "object" && !Array.isArray(data.tasks) ? data.tasks : {};
        let order = Array.isArray(data?.order) ? data.order.filter(id => source[id]) : Object.keys(source);
        const seen = new Set(order);
        for (const id of Object.keys(source)) if (!seen.has(id)) order.push(id);
        // Never discard non-terminal tasks. Retain only the newest 200 terminal tasks.
        const active = order.filter(id => source[id] && !TERMINAL.has(source[id].status));
        const terminal = order.filter(id => source[id] && TERMINAL.has(source[id].status)).slice(-200);
        order = [...active, ...terminal];
        for (const id of order) out.tasks[id] = sanitizeBatchTask(source[id], id);
        out.order = order.filter(id => out.tasks[id]);
        out.stats = { ...out.stats, ...(data?.stats || {}) };
        for (const key of Object.keys(out.stats)) out.stats[key] = Math.max(0, Math.floor(Number(out.stats[key]) || 0));
    } catch {
        return JSON.parse(JSON.stringify(def));
    }
    return out;
}

export default { DEFAULT_BATCH_TASK_DB, validateBatchTaskData, sanitizeBatchTask };
