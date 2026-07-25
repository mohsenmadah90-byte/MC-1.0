// MCity Dashboard V2 - Legacy Financial Journal Schema
// Phase 3.2: non-destructive bridge source for OperationJournalService.

export const DEFAULT_FINANCIAL_JOURNAL_DB = {
    schemaVersion: 1,
    version: "1.0.0",
    journals: {},
    order: [],
    stats: {
        totalCreated: 0,
        totalCompleted: 0,
        totalFailed: 0,
        totalRecovered: 0,
        totalBridged: 0,
        lastUpdated: 0
    }
};

function now() { return Date.now(); }
function safeText(v, max = 120) { return String(v || "").replace(/[\u0000-\u001f\u007f]/g, "").substring(0, max); }
function safeObj(v) { try { return JSON.parse(JSON.stringify(v || {})); } catch { return {}; } }

function sanitizeSteps(raw = {}) {
    const valid = new Set(["pending", "done", "failed", "skipped", "applied"]);
    const out = {};
    if (raw && typeof raw === "object") {
        for (const [k, value] of Object.entries(raw)) {
            const v = typeof value === "object" ? value?.status : value;
            out[String(k).substring(0, 40)] = valid.has(v) ? v : "pending";
        }
    }
    return out;
}

export function sanitizeFinancialJournal(raw = {}, idValue = "") {
    const id = safeText(idValue || raw.id || `fj_${now()}_${Math.floor(Math.random() * 1000000)}`, 120);
    const status = ["created", "debit_done", "credit_done", "reward_pending", "payout_done", "score_done", "completed", "cancelled", "failed", "recovery_failed"].includes(raw.status) ? raw.status : "created";
    return {
        id,
        type: safeText(raw.type || "generic", 80),
        status,
        createdAt: Number(raw.createdAt) || now(),
        updatedAt: Number(raw.updatedAt) || now(),
        attempts: Math.max(0, Math.floor(Number(raw.attempts) || 0)),
        actorId: safeText(raw.actorId || "", 64),
        actorName: safeText(raw.actorName || "", 32),
        targetId: safeText(raw.targetId || "", 64),
        targetName: safeText(raw.targetName || "", 32),
        amount: Math.max(0, Math.floor(Number(raw.amount) || 0)),
        payload: safeObj(raw.payload),
        steps: sanitizeSteps(raw.steps),
        lastError: safeText(raw.lastError || "", 500),
        operationId: safeText(raw.operationId || "", 120),
        bridgedAt: Math.max(0, Number(raw.bridgedAt) || 0),
        bridgeError: safeText(raw.bridgeError || "", 500)
    };
}

export function validateFinancialJournalData(data, def = DEFAULT_FINANCIAL_JOURNAL_DB) {
    const out = JSON.parse(JSON.stringify(def));
    try {
        out.version = data?.version || "1.0.0";
        out.schemaVersion = Math.max(1, Math.floor(Number(data?.schemaVersion) || Number(out.schemaVersion) || 1));
        const journals = data?.journals && typeof data.journals === "object" && !Array.isArray(data.journals) ? data.journals : {};
        const order = Array.isArray(data?.order) ? data.order.filter(id => journals[id]) : [];
        const seen = new Set();
        // Preserve the persisted order and append missing records. Critically,
        // there is no slice/count cap: active journals are never discarded by
        // schema validation.
        for (const rawId of [...order, ...Object.keys(journals)]) {
            const id = safeText(rawId, 120);
            if (!id || seen.has(id) || !journals[rawId]) continue;
            seen.add(id);
            out.journals[id] = sanitizeFinancialJournal(journals[rawId], id);
            out.order.push(id);
        }
        out.stats = { ...out.stats, ...(data?.stats || {}) };
        for (const key of Object.keys(out.stats)) out.stats[key] = Math.max(0, Math.floor(Number(out.stats[key]) || 0));
        out.stats.lastUpdated = Number(data?.stats?.lastUpdated) || now();
    } catch {
        return JSON.parse(JSON.stringify(def));
    }
    return out;
}

export default { DEFAULT_FINANCIAL_JOURNAL_DB, validateFinancialJournalData, sanitizeFinancialJournal };
