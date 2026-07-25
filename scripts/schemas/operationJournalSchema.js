// MCity Dashboard V2 - Durable Operation Journal / Outbox Schema
// Phase 3.2: active operations are never removed by validation or count caps.

const STATUS = new Set([
    "created", "validated", "debit_applied", "inventory_reserved",
    "obligation_persisted", "credit_applied", "delivery_applied",
    "accounting_applied", "retry_scheduled", "completed", "cancelled",
    "dead_letter"
]);
const OUTBOX_STATUS = new Set(["queued", "running", "retry_scheduled", "dead_letter"]);
const TERMINAL = new Set(["completed", "cancelled"]);

function clone(value, fallback = {}) {
    try { return JSON.parse(JSON.stringify(value)); } catch { return JSON.parse(JSON.stringify(fallback)); }
}
function text(value, max = 120) { return String(value || "").replace(/[\u0000-\u001f\u007f]/g, "").substring(0, max); }
function integer(value, min = 0, max = Number.MAX_SAFE_INTEGER) {
    return Math.max(min, Math.min(max, Math.floor(Number(value) || 0)));
}
function object(value) { return value && typeof value === "object" && !Array.isArray(value) ? clone(value) : {}; }

export const DEFAULT_OPERATION_JOURNAL_DB = {
    schemaVersion: 1,
    version: "1.0.0",
    operations: {},
    activeOrder: [],
    terminalOrder: [],
    outbox: {},
    stats: {
        totalCreated: 0,
        totalCompleted: 0,
        totalCancelled: 0,
        totalRecovered: 0,
        totalRetries: 0,
        totalDeadLetters: 0,
        totalPruned: 0,
        flushFailures: 0,
        lastUpdated: 0
    }
};

export const DEFAULT_OPERATION_JOURNAL_CATALOG_DB = {
    schemaVersion: 1,
    version: "1.0.0",
    routing: {
        enabled: true,
        base: "operation_journals",
        shardCount: 1,
        algorithm: "fnv1a_imul_v2",
        locked: false,
        lockedAt: 0
    },
    legacy: {
        source: "financial_journals",
        imported: 0,
        lastImportedAt: 0,
        complete: false
    },
    stats: { lastUpdated: 0 }
};

export function isTerminalOperationStatus(status) { return TERMINAL.has(status); }
export function isValidOperationStatus(status) { return STATUS.has(status); }

function sanitizeStep(raw = {}) {
    if (typeof raw === "string") return { status: text(raw, 32) || "pending", attempts: 0, updatedAt: 0, lastError: "" };
    if (!raw || typeof raw !== "object") return { status: "pending", attempts: 0, updatedAt: 0, lastError: "" };
    return {
        status: text(raw.status || "pending", 32),
        attempts: integer(raw.attempts),
        updatedAt: integer(raw.updatedAt),
        lastError: text(raw.lastError, 500)
    };
}

function sanitizeMarkerRequirement(raw) {
    if (!raw || typeof raw !== "object") return null;
    const collection = text(raw.collection, 100);
    const effectId = text(raw.effectId || "default", 64) || "default";
    const field = text(raw.field || "appliedOperations", 48) || "appliedOperations";
    if (!collection) return null;
    return { collection, effectId, field };
}

export function sanitizeOperation(raw = {}, idValue = "") {
    const operationId = text(idValue || raw.operationId || raw.id, 120);
    if (!operationId) return null;
    const status = STATUS.has(raw.status) ? raw.status : "created";
    const createdAt = integer(raw.createdAt) || Date.now();
    const steps = {};
    for (const [name, step] of Object.entries(raw.steps && typeof raw.steps === "object" ? raw.steps : {})) {
        const key = text(name, 48);
        if (key) steps[key] = sanitizeStep(step);
    }
    const markerRequirements = [];
    const seen = new Set();
    for (const value of Array.isArray(raw.markerRequirements) ? raw.markerRequirements : []) {
        const marker = sanitizeMarkerRequirement(value);
        if (!marker) continue;
        const key = `${marker.collection}\u0000${marker.field}\u0000${marker.effectId}`;
        if (!seen.has(key)) { seen.add(key); markerRequirements.push(marker); }
    }
    return {
        operationId,
        operationType: text(raw.operationType || raw.type || "generic", 80) || "generic",
        status,
        resumeStatus: STATUS.has(raw.resumeStatus) && raw.resumeStatus !== "retry_scheduled" && raw.resumeStatus !== "dead_letter" ? raw.resumeStatus : "created",
        actorId: text(raw.actorId, 64),
        actorName: text(raw.actorName, 32),
        targetId: text(raw.targetId, 64),
        targetName: text(raw.targetName, 32),
        amount: integer(raw.amount),
        itemPayload: object(raw.itemPayload),
        payload: object(raw.payload),
        steps,
        markerRequirements,
        markerCleanup: object(raw.markerCleanup),
        attempts: integer(raw.attempts),
        maxAttempts: Math.max(1, integer(raw.maxAttempts, 1, 100) || 1),
        nextAttemptAt: integer(raw.nextAttemptAt),
        createdAt,
        updatedAt: integer(raw.updatedAt) || createdAt,
        terminalAt: TERMINAL.has(status) ? (integer(raw.terminalAt) || integer(raw.updatedAt) || createdAt) : 0,
        transitionSeq: integer(raw.transitionSeq),
        lastError: text(raw.lastError, 500),
        legacy: object(raw.legacy)
    };
}

function sanitizeOutbox(raw, operation) {
    let state = OUTBOX_STATUS.has(raw?.state) ? raw.state : (operation.status === "dead_letter" ? "dead_letter" : operation.status === "retry_scheduled" ? "retry_scheduled" : "queued");
    if (state === "running") state = "queued"; // crash/reload resumes a claimed outbox item
    return {
        operationId: operation.operationId,
        state,
        nextAttemptAt: integer(raw?.nextAttemptAt ?? operation.nextAttemptAt),
        attempts: integer(raw?.attempts ?? operation.attempts),
        updatedAt: integer(raw?.updatedAt) || operation.updatedAt,
        lastError: text(raw?.lastError ?? operation.lastError, 500)
    };
}

export function validateOperationJournalData(data, def = DEFAULT_OPERATION_JOURNAL_DB) {
    const out = clone(def);
    try {
        out.version = text(data?.version || "1.0.0", 32);
        out.schemaVersion = Math.max(1, integer(data?.schemaVersion ?? out.schemaVersion, 1, 1_000_000));
        const source = data?.operations && typeof data.operations === "object" && !Array.isArray(data.operations) ? data.operations : {};
        for (const [id, raw] of Object.entries(source)) {
            const operation = sanitizeOperation(raw, id);
            if (operation) out.operations[operation.operationId] = operation;
        }

        const activeSeen = new Set();
        const terminalSeen = new Set();
        const activeSource = Array.isArray(data?.activeOrder) ? data.activeOrder : [];
        const terminalSource = Array.isArray(data?.terminalOrder) ? data.terminalOrder : [];
        for (const rawId of activeSource) {
            const id = text(rawId, 120); const op = out.operations[id];
            if (op && !TERMINAL.has(op.status) && !activeSeen.has(id)) { activeSeen.add(id); out.activeOrder.push(id); }
        }
        for (const rawId of terminalSource) {
            const id = text(rawId, 120); const op = out.operations[id];
            if (op && TERMINAL.has(op.status) && !terminalSeen.has(id)) { terminalSeen.add(id); out.terminalOrder.push(id); }
        }
        // Never discard non-terminal/dead-letter operations because of a cap
        // or because an older runtime omitted them from an order array.
        for (const [id, op] of Object.entries(out.operations)) {
            if (TERMINAL.has(op.status)) {
                if (!terminalSeen.has(id)) { terminalSeen.add(id); out.terminalOrder.push(id); }
            } else if (!activeSeen.has(id)) { activeSeen.add(id); out.activeOrder.push(id); }
        }

        const rawOutbox = data?.outbox && typeof data.outbox === "object" && !Array.isArray(data.outbox) ? data.outbox : {};
        for (const id of out.activeOrder) {
            const op = out.operations[id];
            out.outbox[id] = sanitizeOutbox(rawOutbox[id], op);
        }
        out.stats = { ...out.stats, ...(data?.stats && typeof data.stats === "object" ? data.stats : {}) };
        for (const key of Object.keys(out.stats)) out.stats[key] = integer(out.stats[key]);
        out.stats.lastUpdated = integer(out.stats.lastUpdated) || Date.now();
    } catch {
        return clone(def);
    }
    return out;
}

export function validateOperationJournalCatalog(data, def = DEFAULT_OPERATION_JOURNAL_CATALOG_DB) {
    const out = clone(def);
    try {
        out.version = text(data?.version || "1.0.0", 32);
        out.schemaVersion = Math.max(1, integer(data?.schemaVersion ?? out.schemaVersion, 1, 1_000_000));
        const routing = data?.routing && typeof data.routing === "object" ? data.routing : {};
        out.routing = {
            enabled: routing.enabled !== false,
            base: text(routing.base || out.routing.base, 64).replace(/[^a-zA-Z0-9_]/g, "_") || out.routing.base,
            shardCount: Math.max(1, Math.min(128, integer(routing.shardCount, 1, 128) || 1)),
            algorithm: text(routing.algorithm || out.routing.algorithm, 40),
            locked: !!routing.locked,
            lockedAt: integer(routing.lockedAt)
        };
        const legacy = data?.legacy && typeof data.legacy === "object" ? data.legacy : {};
        out.legacy = {
            source: text(legacy.source || out.legacy.source, 80),
            imported: integer(legacy.imported),
            lastImportedAt: integer(legacy.lastImportedAt),
            complete: !!legacy.complete
        };
        out.stats = { ...out.stats, ...(data?.stats && typeof data.stats === "object" ? data.stats : {}) };
        out.stats.lastUpdated = integer(out.stats.lastUpdated) || Date.now();
    } catch {
        return clone(def);
    }
    return out;
}

export default {
    DEFAULT_OPERATION_JOURNAL_DB,
    DEFAULT_OPERATION_JOURNAL_CATALOG_DB,
    validateOperationJournalData,
    validateOperationJournalCatalog,
    sanitizeOperation,
    isTerminalOperationStatus,
    isValidOperationStatus
};
