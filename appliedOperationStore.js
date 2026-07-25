// MCity Dashboard V2 - Destination Applied Operation Store
// Phase 3.2: unified idempotency markers committed with destination effects.

function clone(value) {
    if (value === undefined) return undefined;
    try { return JSON.parse(JSON.stringify(value)); } catch { return null; }
}
function safeId(value, max = 120) { return String(value || "").replace(/[\u0000-\u001f\u007f]/g, "").substring(0, max); }
function safeTime(value) { return Math.max(0, Math.floor(Number(value) || 0)); }
function safeAmount(value) { return Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(Number(value) || 0))); }

/**
 * AppliedOperationStore mutates only the plain object supplied by a caller.
 * Callers must invoke it inside the same Database.transaction that applies the
 * economic side effect. `appliedJournals` is retained as a compatibility
 * layout for Money; all other destinations use the normalized
 * `appliedOperations` layout.
 */
export class AppliedOperationStore {
    static DEFAULT_FIELD = "appliedOperations";
    static LEGACY_MONEY_FIELD = "appliedJournals";

    static #field(field) { return safeId(field || this.DEFAULT_FIELD, 48) || this.DEFAULT_FIELD; }

    static get(data, operationId, effectId = "default", field = this.DEFAULT_FIELD) {
        const id = safeId(operationId);
        const effect = safeId(effectId, 64) || "default";
        const key = this.#field(field);
        const record = data?.[key]?.[id];
        if (!record || typeof record !== "object") return null;
        if (key === this.LEGACY_MONEY_FIELD) {
            if (!record[effect]) return null;
            return {
                status: "applied",
                appliedAt: safeTime(record.at),
                amount: safeAmount(record.amount),
                value: clone(record.value),
                terminalAt: safeTime(record.terminalAt),
                operationStatus: safeId(record.operationStatus, 32)
            };
        }
        const entry = record.effects?.[effect];
        return entry && entry.status === "applied" ? clone(entry) : null;
    }

    static has(data, operationId, effectId = "default", field = this.DEFAULT_FIELD) {
        return this.get(data, operationId, effectId, field) !== null;
    }

    static mark(data, operationId, effectId = "default", details = {}, field = this.DEFAULT_FIELD) {
        const id = safeId(operationId);
        const effect = safeId(effectId, 64) || "default";
        const key = this.#field(field);
        if (!id || !data || typeof data !== "object") throw new Error("Applied operation marker requires data and operationId");
        if (!data[key] || typeof data[key] !== "object" || Array.isArray(data[key])) data[key] = {};
        const at = safeTime(details.appliedAt) || Date.now();

        if (key === this.LEGACY_MONEY_FIELD) {
            const previous = data[key][id] && typeof data[key][id] === "object" ? data[key][id] : {};
            data[key][id] = {
                ...previous,
                [effect]: true,
                status: safeId(details.status || effect, 32),
                amount: safeAmount(details.amount ?? previous.amount),
                at,
                value: clone(details.value ?? previous.value),
                terminalAt: safeTime(previous.terminalAt),
                operationStatus: safeId(previous.operationStatus, 32)
            };
            return clone(data[key][id]);
        }

        const previous = data[key][id] && typeof data[key][id] === "object" ? data[key][id] : {};
        const effects = previous.effects && typeof previous.effects === "object" ? previous.effects : {};
        effects[effect] = {
            status: "applied",
            appliedAt: at,
            amount: safeAmount(details.amount),
            value: clone(details.value)
        };
        data[key][id] = {
            operationId: id,
            effects,
            createdAt: safeTime(previous.createdAt) || at,
            updatedAt: at,
            terminalAt: safeTime(previous.terminalAt),
            operationStatus: safeId(previous.operationStatus, 32)
        };
        return clone(effects[effect]);
    }

    static markTerminal(data, operationId, status, terminalAt = Date.now(), field = this.DEFAULT_FIELD) {
        const id = safeId(operationId);
        const key = this.#field(field);
        const record = data?.[key]?.[id];
        if (!record || typeof record !== "object") return false;
        record.terminalAt = safeTime(terminalAt) || Date.now();
        record.operationStatus = safeId(status, 32);
        record.updatedAt = Date.now();
        return true;
    }

    static removeEffect(data, operationId, effectId = "default", field = this.DEFAULT_FIELD) {
        const id = safeId(operationId);
        const effect = safeId(effectId, 64) || "default";
        const key = this.#field(field);
        const record = data?.[key]?.[id];
        if (!record || typeof record !== "object") return false;
        if (key === this.LEGACY_MONEY_FIELD) {
            if (!record[effect]) return false;
            delete record[effect];
            const effectKeys = ["debit", "credit", "rollback", "default"].filter(name => record[name]);
            if (!effectKeys.length) delete data[key][id];
            return true;
        }
        if (!record.effects?.[effect]) return false;
        delete record.effects[effect];
        if (!Object.keys(record.effects).length) delete data[key][id];
        else record.updatedAt = Date.now();
        return true;
    }

    static sanitize(raw = {}) {
        const out = {};
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
        for (const [rawId, value] of Object.entries(raw)) {
            const id = safeId(rawId);
            if (!id || !value || typeof value !== "object" || Array.isArray(value)) continue;
            const effects = {};
            for (const [rawEffect, entry] of Object.entries(value.effects || {})) {
                const effect = safeId(rawEffect, 64);
                if (!effect || !entry || typeof entry !== "object" || entry.status !== "applied") continue;
                effects[effect] = {
                    status: "applied",
                    appliedAt: safeTime(entry.appliedAt) || Date.now(),
                    amount: safeAmount(entry.amount),
                    value: clone(entry.value)
                };
            }
            if (!Object.keys(effects).length) continue;
            out[id] = {
                operationId: id,
                effects,
                createdAt: safeTime(value.createdAt) || Date.now(),
                updatedAt: safeTime(value.updatedAt) || Date.now(),
                terminalAt: safeTime(value.terminalAt),
                operationStatus: safeId(value.operationStatus, 32)
            };
        }
        return out;
    }
}

export default AppliedOperationStore;
