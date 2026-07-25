// MCity Dashboard V2 - Financial Reconciliation Report Schema
// Phase 3.4: non-economic, bounded diagnostic history; active reports never trimmed.

export const DEFAULT_FINANCIAL_RECOVERY_DB = {
    schemaVersion: 1,
    version: "1.0.0",
    reports: {},
    order: [],
    stats: { totalStarted: 0, totalCompleted: 0, totalFailed: 0, lastUpdated: 0 }
};

function clone(v, fallback = {}) { try { return JSON.parse(JSON.stringify(v)); } catch { return JSON.parse(JSON.stringify(fallback)); } }
function text(v, max = 160) { return String(v || "").replace(/[\u0000-\u001f\u007f]/g, "").substring(0, max); }
function num(v) { return Math.max(0, Math.floor(Number(v) || 0)); }

export function sanitizeFinancialFinding(raw = {}) {
    return {
        code: text(raw.code || "UNKNOWN", 64), severity: ["info","warn","error","critical"].includes(raw.severity) ? raw.severity : "error",
        component: text(raw.component || "financial", 64), operationId: text(raw.operationId, 120), collection: text(raw.collection, 100),
        playerId: text(raw.playerId, 64), expected: clone(raw.expected, null), actual: clone(raw.actual, null), detail: text(raw.detail, 500), at: num(raw.at) || Date.now()
    };
}

export function sanitizeFinancialReport(raw = {}, idValue = "") {
    const id = text(idValue || raw.id, 120); if (!id) return null;
    const findings = Array.isArray(raw.findings) ? raw.findings.slice(0, 500).map(sanitizeFinancialFinding) : [];
    return {
        id, status: ["queued","running","completed","failed","inconclusive"].includes(raw.status) ? raw.status : "queued",
        mode: raw.mode === "RECOVER_SAFE" ? "RECOVER_SAFE" : "AUDIT_ONLY", stage: text(raw.stage || "queued", 64),
        findings, findingCount: Math.max(findings.length, num(raw.findingCount)), counts: clone(raw.counts), components: clone(raw.components),
        revisions: clone(raw.revisions), taskId: text(raw.taskId, 120), startedAt: num(raw.startedAt), updatedAt: num(raw.updatedAt) || Date.now(),
        completedAt: num(raw.completedAt), lastError: text(raw.lastError, 500)
    };
}

export function validateFinancialRecoveryData(data, def = DEFAULT_FINANCIAL_RECOVERY_DB) {
    const out = clone(def);
    try {
        out.version = data?.version || "1.0.0";
        out.schemaVersion = Math.max(1, num(data?.schemaVersion) || 1);
        const source = data?.reports && typeof data.reports === "object" ? data.reports : {};
        const order = Array.isArray(data?.order) ? data.order.filter(id => source[id]) : Object.keys(source);
        const seen = new Set(); const terminal = [];
        for (const rawId of [...order, ...Object.keys(source)]) {
            const report = sanitizeFinancialReport(source[rawId], rawId); if (!report || seen.has(report.id)) continue; seen.add(report.id);
            if (["queued","running"].includes(report.status)) { out.reports[report.id] = report; out.order.push(report.id); }
            else terminal.push(report);
        }
        terminal.sort((a,b)=>(a.completedAt||a.updatedAt)-(b.completedAt||b.updatedAt));
        for (const report of terminal.slice(-20)) { out.reports[report.id]=report; out.order.push(report.id); }
        out.stats={...out.stats,...(data?.stats||{})}; for(const k of Object.keys(out.stats))out.stats[k]=num(out.stats[k]); out.stats.lastUpdated=num(out.stats.lastUpdated)||Date.now();
    } catch { return clone(def); }
    return out;
}

export default { DEFAULT_FINANCIAL_RECOVERY_DB, validateFinancialRecoveryData, sanitizeFinancialReport, sanitizeFinancialFinding };
