// MCity Dashboard V2 - Financial Journal Compatibility / Domain Handlers
// Phase 3.2: bridges legacy financial_journals into OperationJournalService.

import { CONFIG } from "../../config.js";
import { Database } from "../../core/database.js";
import { Logger } from "../../core/logger.js";
import { DisposableRegistry } from "../../core/disposableRegistry.js";
import { MoneyUtils } from "../../core/moneyUtils.js";
import { MoneyShard } from "../../core/moneyShard.js";
import { OperationJournalService } from "../../core/operationJournalService.js";
import { AppliedOperationStore } from "../../core/appliedOperationStore.js";
import { DEFAULT_MONEY_DB, validateMoneyData } from "../../schemas/moneySchema.js";
import { DEFAULT_LEVEL_DB, validateLevelData } from "../../schemas/levelSchema.js";
import { DEFAULT_FINANCE_DB, validateFinanceData } from "../../schemas/financeSchema.js";
import { DEFAULT_FINANCIAL_JOURNAL_DB, validateFinancialJournalData } from "../../schemas/financialJournalSchema.js";
import { DEFAULT_CONTRACT_DB, validateContractData } from "../../schemas/contractSchema.js";
import { FinanceService } from "./financeService.js";
import { MoneyService } from "../economy/moneyService.js";
import { LevelService } from "../economy/levelService.js";
import { AuditService } from "../audit/auditService.js";
import { RuntimeHandleRegistry } from "../../core/runtimeHandleRegistry.js";

const LEGACY_COLLECTION = "financial_journals";
const BRIDGE_INTERVAL_TICKS = 100;
const BRIDGE_BATCH = 5;
const MAX_MONEY = CONFIG.MONEY.MAX_MONEY_CENTS;
function now() { return Date.now(); }
function safeAmount(value) { return Math.max(0, Math.floor(Number(value) || 0)); }

const LEGACY_STATUS_MAP = {
    created: "created",
    debit_done: "debit_applied",
    credit_done: "credit_applied",
    reward_pending: "obligation_persisted",
    payout_done: "delivery_applied",
    score_done: "accounting_applied",
    completed: "completed",
    cancelled: "cancelled",
    failed: "dead_letter",
    recovery_failed: "retry_scheduled"
};

export function financialJournalId(prefix = "fj") { return OperationJournalService.newId(prefix); }

export class FinancialJournalService {
    static #initialized = false;
    static #bridging = false;
    static #intervalId = null;

    static initialize() {
        if (this.#initialized) return;
        this.#initialized = true;
        OperationJournalService.initialize();
        this.db();
        OperationJournalService.registerHandler("money_transfer_cross_shard", {
            recover: operation => this.#recoverMoneyTransfer(operation),
            resolveMarker: (operation, requirement) => this.#resolveMoneyMarker(operation, requirement)
        });
        OperationJournalService.registerHandler("contract_reward_delivery", {
            recover: operation => this.#recoverContractReward(operation),
            resolveMarker: (operation, requirement) => this.#resolveRewardMarker(operation, requirement)
        });
        this.#bridgeLegacyJournals(BRIDGE_BATCH);
        this.#journalPendingContractRewards();
        this.#intervalId = RuntimeHandleRegistry.interval("FinancialJournal.legacyBridge", () => {
            try {
                this.#bridgeLegacyJournals(BRIDGE_BATCH);
                this.#journalPendingContractRewards();
            } catch (error) { Logger.warn("FinancialJournal", "Legacy bridge interval failed", error); }
        }, BRIDGE_INTERVAL_TICKS);
        DisposableRegistry.registerShutdownCleanup("FinancialJournalService.lifecycle", () => {
            if (this.#intervalId !== null) RuntimeHandleRegistry.clear(this.#intervalId);
            this.#intervalId = null;
            this.#bridging = false;
            OperationJournalService.unregisterHandler("money_transfer_cross_shard");
            OperationJournalService.unregisterHandler("contract_reward_delivery");
            this.#initialized = false;
        });
        Logger.startup("FinancialJournal", "Legacy journal bridge and operation handlers initialized");
    }

    /** Legacy source is retained for rollback/audit and never used for new writes. */
    static db() { return Database.collection(LEGACY_COLLECTION, DEFAULT_FINANCIAL_JOURNAL_DB, { validate: validateFinancialJournalData }); }

    static create(type, payload = {}, meta = {}) {
        const operationId = meta.id || meta.operationId || payload.operationId || payload.journalId || financialJournalId(type);
        const result = OperationJournalService.create(type, {
            actorId: meta.actorId || payload.senderId || payload.playerId || "",
            actorName: meta.actorName || payload.senderName || payload.playerName || "",
            targetId: meta.targetId || payload.targetId || payload.playerId || "",
            targetName: meta.targetName || payload.targetName || payload.playerName || "",
            amount: meta.amount ?? payload.amount ?? payload.rewardCents,
            itemPayload: meta.itemPayload || payload.itemPayload || {},
            payload,
            steps: meta.steps || payload.steps || {}
        }, { operationId, status: meta.status || "created" });
        return result.success ? this.#legacyView(result.operation) : null;
    }

    static mark(id, status, error = "") {
        const mapped = LEGACY_STATUS_MAP[status] || status;
        if (mapped === "completed") return OperationJournalService.complete(id).success;
        if (mapped === "cancelled") return OperationJournalService.cancel(id, error).success;
        if (mapped === "dead_letter") return OperationJournalService.scheduleRetry(id, error || "Legacy failure", { retryable: false }).success;
        if (mapped === "retry_scheduled") return OperationJournalService.scheduleRetry(id, error || "Legacy recovery failure").success;
        return OperationJournalService.transition(id, mapped, { error, reason: "legacy_financial_journal_mark" }).success;
    }

    static bumpAttempt(id, error = "") { return OperationJournalService.scheduleRetry(id, error || "Legacy recovery retry"); }

    static createMoneyTransferJournal(payload) {
        return this.create("money_transfer_cross_shard", payload, {
            id: payload.journalId || payload.operationId,
            actorId: payload.senderId,
            actorName: payload.senderName,
            targetId: payload.targetId,
            targetName: payload.targetName,
            amount: payload.amount
        });
    }

    static deliverContractReward(player, payload) {
        const reward = safeAmount(payload.rewardCents);
        const score = safeAmount(payload.score);
        const operationId = payload.operationId || payload.journalId || (payload.obligationId ? `reward_${payload.obligationId}` : financialJournalId("contract_reward"));
        const created = OperationJournalService.create("contract_reward_delivery", {
            actorId: player?.id || payload.playerId || "",
            actorName: player?.name || payload.playerName || "Unknown",
            targetId: player?.id || payload.playerId || "",
            targetName: player?.name || payload.playerName || "Unknown",
            amount: reward,
            payload: { ...payload, operationId, journalId: operationId, rewardCents: reward, score },
            steps: { payout: reward > 0 ? "pending" : "skipped", score: score > 0 ? "pending" : "skipped" }
        }, { operationId, status: "obligation_persisted" });
        if (!created.success) return { success: false, message: created.error || "Failed to create durable reward operation." };
        if (created.operation?.status === "completed") {
            if (payload.obligationId) this.#markRewardObligation(payload.obligationId, "completed", operationId, "");
            return { success: true, operationId, completed: true, alreadyApplied: true };
        }
        if (created.operation?.status === "cancelled") return { success: false, operationId, message: "Reward operation was previously cancelled and requires admin review." };
        if (payload.obligationId) this.#markRewardObligation(payload.obligationId, "journaled", operationId, "");
        const recovered = OperationJournalService.recover(operationId);
        return recovered.success
            ? { success: true, operationId, completed: recovered.operation?.status === "completed" }
            : { success: false, operationId, message: recovered.error || "Reward operation is pending recovery." };
    }

    static recoverPending(reason = "manual") {
        const bridged = this.#bridgeLegacyJournals(BRIDGE_BATCH);
        const journaled = this.#journalPendingContractRewards();
        const recovery = OperationJournalService.runRecoveryBatch({ forceDue: reason === "manual" || reason === "startup" });
        if (recovery.recovered) {
            try {
                AuditService.record("operation_journal.recovered", "finance", "", "system", `Recovered ${recovery.recovered}/${recovery.checked} durable operation(s) (${reason})`, { ...recovery, bridged, journaled, reason }, "warn");
            } catch (error) { Logger.debug("FinancialJournal", "Recovery audit failed", error); }
        }
        return { ...recovery, bridged, journaled };
    }

    static stats() { return { ...OperationJournalService.stats(), legacyUnbridged: this.#legacyUnbridgedCount() }; }

    static #bridgeLegacyJournals(limit = BRIDGE_BATCH) {
        if (this.#bridging) return { imported: 0, skipped: "already_running" };
        this.#bridging = true;
        let imported = 0, failed = 0, checked = 0;
        try {
            const db = this.db();
            const journals = (db.order || []).map(id => db.journals[id]).filter(Boolean);
            journals.sort((a, b) => {
                const at = ["completed", "cancelled", "failed"].includes(a.status) ? 1 : 0;
                const bt = ["completed", "cancelled", "failed"].includes(b.status) ? 1 : 0;
                return at - bt || (a.createdAt || 0) - (b.createdAt || 0);
            });
            for (const journal of journals) {
                if (checked >= limit) break;
                if (journal.bridgedAt && journal.operationId && OperationJournalService.operation(journal.operationId)) continue;
                checked++;
                const operationId = journal.operationId || journal.id;
                const mappedStatus = LEGACY_STATUS_MAP[journal.status] || "created";
                const result = OperationJournalService.importLegacy(journal.type, {
                    operationId,
                    status: mappedStatus,
                    resumeStatus: mappedStatus === "retry_scheduled" ? (journal.type === "money_transfer_cross_shard" ? "debit_applied" : "obligation_persisted") : mappedStatus,
                    actorId: journal.actorId,
                    actorName: journal.actorName,
                    targetId: journal.targetId,
                    targetName: journal.targetName,
                    amount: journal.amount,
                    payload: journal.payload,
                    itemPayload: journal.payload?.itemPayload || {},
                    steps: journal.steps,
                    attempts: journal.attempts,
                    lastError: journal.lastError,
                    createdAt: journal.createdAt,
                    updatedAt: journal.updatedAt,
                    terminalAt: ["completed", "cancelled"].includes(mappedStatus) ? journal.updatedAt : 0,
                    legacy: { sourceCollection: LEGACY_COLLECTION, sourceId: journal.id, sourceStatus: journal.status }
                }, { operationId, status: mappedStatus });
                const marked = Database.transaction(LEGACY_COLLECTION, data => {
                    const source = data.journals[journal.id];
                    if (!source) return;
                    if (result.success) {
                        source.operationId = operationId;
                        source.bridgedAt = now();
                        source.bridgeError = "";
                        data.stats.totalBridged = (data.stats.totalBridged || 0) + (source.bridgedAt ? 1 : 0);
                    } else source.bridgeError = String(result.error || "Bridge failed").substring(0, 500);
                    source.updatedAt = Math.max(source.updatedAt || 0, now());
                    data.stats.lastUpdated = now();
                });
                if (result.success && marked.success && Database.flushCritical(LEGACY_COLLECTION, "legacy_journal_bridge_marker").ok) imported++;
                else failed++;
            }
        } finally { this.#bridging = false; }
        return { checked, imported, failed };
    }

    static #recoverMoneyTransfer(operation) {
        const p = operation.payload || {};
        const amount = safeAmount(p.amount ?? operation.amount);
        if (!amount || !p.senderId || !p.targetId) return { success: false, retryable: false, error: "Invalid transfer payload" };
        const senderShard = p.senderShard || MoneyShard.collectionFor(p.senderId);
        const targetShard = p.targetShard || MoneyShard.collectionFor(p.targetId);
        const senderDb = Database.collection(senderShard, DEFAULT_MONEY_DB, { validate: validateMoneyData });
        const targetDb = Database.collection(targetShard, DEFAULT_MONEY_DB, { validate: validateMoneyData });
        const senderMarker = senderDb.appliedJournals?.[operation.operationId];
        const targetMarker = targetDb.appliedJournals?.[operation.operationId];

        if (senderMarker?.rollback) {
            const recorded = OperationJournalService.recordAppliedEffect(operation.operationId, { collection: senderShard, field: "appliedJournals", effectId: "rollback", defaultData: DEFAULT_MONEY_DB, validate: validateMoneyData });
            if (!recorded.success) return recorded;
            const cancelled = OperationJournalService.cancel(operation.operationId, "Sender debit was rolled back; transfer cancelled safely.");
            return cancelled.success ? { success: true, completed: false, cancelled: true } : cancelled;
        }

        let current = OperationJournalService.operation(operation.operationId);
        if (current.status === "created") {
            const targetCurrent = Math.max(0, Math.floor(Number(targetDb.players?.[p.targetId]?.balance) || 0));
            if (targetCurrent > MAX_MONEY - amount) {
                const cancelled = OperationJournalService.cancel(operation.operationId, "Target capacity unavailable before debit");
                return cancelled.success ? { success: true, cancelled: true } : cancelled;
            }
            const validated = OperationJournalService.transition(operation.operationId, "validated", { step: "validation", stepStatus: "done", reason: "money_recovery_validated" });
            if (!validated.success) return validated;
            current = validated.operation;
        }

        if (!senderMarker?.debit) {
            if (!["validated"].includes(current.status)) return { success: false, retryable: false, error: `Debit marker missing at advanced status ${current.status}` };
            const debit = OperationJournalService.applyEffect(operation.operationId, {
                collection: senderShard,
                defaultData: DEFAULT_MONEY_DB,
                validate: validateMoneyData,
                field: "appliedJournals",
                effectId: "debit",
                postStatus: "debit_applied",
                step: "debit",
                mutate: data => {
                    const rec = data.players[p.senderId];
                    if (!rec) throw new Error("Sender record missing");
                    const balance = Math.max(0, Math.floor(Number(rec.balance) || 0));
                    if (balance < amount) throw new Error("Insufficient funds for recovered transfer");
                    rec.balance = balance - amount;
                    rec.updatedAt = now();
                    data.stats.lastUpdated = now();
                    return { senderBalance: rec.balance };
                }
            });
            if (!debit.success) return debit;
        } else {
            const postStatus = ["created", "validated"].includes(current.status) ? "debit_applied" : null;
            const recorded = OperationJournalService.recordAppliedEffect(operation.operationId, { collection: senderShard, field: "appliedJournals", effectId: "debit", defaultData: DEFAULT_MONEY_DB, validate: validateMoneyData }, postStatus, { step: "debit", stepStatus: "applied" });
            if (!recorded.success) return recorded;
        }

        current = OperationJournalService.operation(operation.operationId);
        if (current.status === "debit_applied") {
            const obligation = OperationJournalService.transition(operation.operationId, "obligation_persisted", { step: "obligation", stepStatus: "done", reason: "money_recovery_obligation" });
            if (!obligation.success) return obligation;
            current = obligation.operation;
        }

        if (!targetMarker?.credit) {
            if (!["obligation_persisted"].includes(current.status)) return { success: false, retryable: false, error: `Credit marker missing at advanced status ${current.status}` };
            const credit = OperationJournalService.applyEffect(operation.operationId, {
                collection: targetShard,
                defaultData: DEFAULT_MONEY_DB,
                validate: validateMoneyData,
                field: "appliedJournals",
                effectId: "credit",
                postStatus: "credit_applied",
                step: "credit",
                mutate: data => {
                    let rec = data.players[p.targetId];
                    if (!rec) {
                        rec = { id: p.targetId, name: p.targetName || "Unknown", balance: 0, firstSeen: now(), lastSeen: 0, updatedAt: now() };
                        data.players[p.targetId] = rec;
                    }
                    const balance = Math.max(0, Math.floor(Number(rec.balance) || 0));
                    if (balance > MAX_MONEY - amount) throw new Error(`Target balance capacity exceeded (${balance} + ${amount} > ${MAX_MONEY})`);
                    rec.balance = balance + amount;
                    rec.name = p.targetName || rec.name || "Unknown";
                    rec.updatedAt = now();
                    data.stats.totalKnownPlayers = Object.keys(data.players || {}).length;
                    data.stats.lastUpdated = now();
                    return { targetBalance: rec.balance };
                }
            });
            if (!credit.success) {
                if (credit.destinationApplied || credit.safeToCompensate === false) return credit;
                const rollback = OperationJournalService.applyEffect(operation.operationId, {
                    collection: senderShard,
                    defaultData: DEFAULT_MONEY_DB,
                    validate: validateMoneyData,
                    field: "appliedJournals",
                    effectId: "rollback",
                    step: "rollback",
                    mutate: data => {
                        const marker = data.appliedJournals?.[operation.operationId];
                        if (!marker?.debit) throw new Error("Debit marker missing; rollback refused");
                        const rec = data.players[p.senderId];
                        if (!rec) throw new Error("Sender record missing during rollback");
                        const balance = Math.max(0, Math.floor(Number(rec.balance) || 0));
                        if (balance > MAX_MONEY - amount) throw new Error("Sender rollback capacity exceeded");
                        rec.balance = balance + amount;
                        rec.updatedAt = now();
                        return { senderBalance: rec.balance };
                    }
                });
                if (!rollback.success) return credit;
                const cancelled = OperationJournalService.cancel(operation.operationId, credit.error || "Target credit failed; debit rolled back");
                MoneyService.refreshBalanceMirror(p.senderId);
                return cancelled.success ? { success: true, cancelled: true } : cancelled;
            }
        } else {
            const postStatus = ["validated", "debit_applied", "obligation_persisted"].includes(current.status) ? "credit_applied" : null;
            const recorded = OperationJournalService.recordAppliedEffect(operation.operationId, { collection: targetShard, field: "appliedJournals", effectId: "credit", defaultData: DEFAULT_MONEY_DB, validate: validateMoneyData }, postStatus, { step: "credit", stepStatus: "applied" });
            if (!recorded.success) return recorded;
        }

        current = OperationJournalService.operation(operation.operationId);
        if (current.status === "credit_applied") {
            const accounting = OperationJournalService.transition(operation.operationId, "accounting_applied", { step: "accounting", stepStatus: "skipped", reason: "money_recovery_accounting" });
            if (!accounting.success) return accounting;
        }
        const completed = OperationJournalService.complete(operation.operationId);
        if (!completed.success) return completed;
        MoneyService.refreshBalanceMirror(p.senderId);
        MoneyService.refreshBalanceMirror(p.targetId);
        try {
            AuditService.record("money.transfer.recovered", "money", p.senderId, p.senderName || "Unknown", `Recovered cross-shard transfer ${MoneyUtils.formatCents(amount)} to ${p.targetName || p.targetId}`, { operationId: operation.operationId, targetId: p.targetId, amount }, "warn");
        } catch (error) { Logger.debug("FinancialJournal", "Recovered transfer audit failed", error); }
        return { success: true, completed: true };
    }

    static #recoverContractReward(operation) {
        const p = operation.payload || {};
        const reward = safeAmount(p.rewardCents ?? operation.amount);
        const score = safeAmount(p.score);
        let current = OperationJournalService.operation(operation.operationId);
        if (current.status === "created") {
            const validated = OperationJournalService.transition(operation.operationId, "validated", { step: "validation", stepStatus: "done" });
            if (!validated.success) return validated;
            current = validated.operation;
        }
        if (current.status === "validated") {
            const obligation = OperationJournalService.transition(operation.operationId, "obligation_persisted", { step: "obligation", stepStatus: "done" });
            if (!obligation.success) return obligation;
            current = obligation.operation;
        }

        if (reward > 0) {
            const payout = FinanceService.addPayout(operation.targetId, reward, p.reason || "Contract reward", "contracts", {
                contractId: p.contractId,
                toName: operation.targetName,
                operationId: operation.operationId,
                journalId: operation.operationId,
                operationEffect: "contract_payout",
                obligationId: p.obligationId || ""
            });
            if (!payout?.success) return { success: false, error: payout?.message || "Payout failed" };
            const collection = FinanceService.payoutCollectionFor(operation.targetId);
            const recorded = OperationJournalService.recordAppliedEffect(operation.operationId, {
                collection,
                field: "appliedOperations",
                effectId: "contract_payout",
                defaultData: DEFAULT_FINANCE_DB,
                validate: validateFinanceData
            }, ["obligation_persisted"].includes(current.status) ? "delivery_applied" : null, { step: "payout", stepStatus: "applied" });
            if (!recorded.success) return recorded;
            current = recorded.operation;
        }

        if (score > 0) {
            const levelCollection = LevelService.collectionFor(operation.targetId);
            const levelDb = Database.collection(levelCollection, DEFAULT_LEVEL_DB, { validate: validateLevelData });
            if (current.steps?.score?.status === "done" && !AppliedOperationStore.has(levelDb, operation.operationId, "contract_score")) {
                // In the legacy flow, step=done was persisted only after the
                // DB-authoritative score mutation succeeded. Backfill the new
                // marker without adding score a second time.
                const backfill = Database.transaction(levelCollection, data => {
                    const existingScore = Math.max(0, Math.floor(Number(data.players?.[operation.targetId]?.score) || 0));
                    AppliedOperationStore.mark(data, operation.operationId, "contract_score", { amount: score, value: { score: existingScore, delta: score, legacyBackfill: true } });
                });
                if (!backfill.success || !Database.flushCritical(levelCollection, "contract_score_marker_backfill").ok) return { success: false, error: backfill.error || "Legacy score marker backfill failed" };
            }
            const scoreResult = LevelService.addScoreOffline(operation.targetId, operation.targetName || p.playerName || "Unknown", score, "contract_reward_operation", {
                operationId: operation.operationId,
                operationEffect: "contract_score"
            });
            if (!scoreResult?.success) return { success: false, error: scoreResult?.message || "Score failed" };
            const collection = LevelService.collectionFor(operation.targetId);
            const postStatus = current.status === "obligation_persisted" ? "delivery_applied" : null;
            const recorded = OperationJournalService.recordAppliedEffect(operation.operationId, {
                collection,
                field: "appliedOperations",
                effectId: "contract_score",
                defaultData: DEFAULT_LEVEL_DB,
                validate: validateLevelData
            }, postStatus, { step: "score", stepStatus: "applied" });
            if (!recorded.success) return recorded;
            current = recorded.operation;
        }

        current = OperationJournalService.operation(operation.operationId);
        if (["obligation_persisted", "delivery_applied"].includes(current.status)) {
            const accounting = OperationJournalService.transition(operation.operationId, "accounting_applied", { step: "accounting", stepStatus: "done" });
            if (!accounting.success) return accounting;
        }
        const completed = OperationJournalService.complete(operation.operationId);
        if (!completed.success) return completed;
        this.#markRewardObligation(p.obligationId, "completed", operation.operationId, "");
        return { success: true, completed: true };
    }

    static #resolveMoneyMarker(operation, requirement) {
        const p = operation.payload || {};
        const sender = p.senderShard || MoneyShard.collectionFor(p.senderId);
        const target = p.targetShard || MoneyShard.collectionFor(p.targetId);
        const collection = requirement.collection === sender ? sender : target;
        Database.collection(collection, DEFAULT_MONEY_DB, { validate: validateMoneyData });
    }

    static #resolveRewardMarker(operation, requirement) {
        if (requirement.effectId === "contract_payout") FinanceService.payoutDBFor(operation.targetId);
        else if (requirement.effectId === "contract_score") LevelService.dbFor(operation.targetId);
    }

    static #contractDB() { return Database.collection(CONFIG.CONTRACTS.COLLECTION, DEFAULT_CONTRACT_DB, { validate: validateContractData }); }

    static #markRewardObligation(obligationId, status, operationId = "", error = "") {
        if (!obligationId) return { success: true };
        const tx = Database.transaction(CONFIG.CONTRACTS.COLLECTION, data => {
            const obligation = data.rewardQueue?.[obligationId];
            if (!obligation) return { missing: true };
            const wasCompleted = obligation.status === "completed";
            obligation.status = status;
            obligation.journalId = operationId || obligation.journalId || "";
            obligation.operationId = operationId || obligation.operationId || "";
            obligation.updatedAt = now();
            obligation.lastError = String(error || "").substring(0, 300);
            obligation.attempts = (obligation.attempts || 0) + (status === "completed" ? 0 : 1);
            data.stats.lastUpdated = now();
            if (status === "completed" && !wasCompleted) data.stats.totalRewardsDelivered = (data.stats.totalRewardsDelivered || 0) + (obligation.rewardCents || 0);
            return { missing: false, wasCompleted };
        });
        if (!tx.success) return { success: false, error: tx.error };
        const flush = Database.flushCritical(CONFIG.CONTRACTS.COLLECTION, `contract_reward_obligation_${status}`);
        return { success: flush.ok, error: flush.ok ? "" : "Obligation flush failed" };
    }

    static #journalPendingContractRewards() {
        const db = this.#contractDB();
        let created = 0, checked = 0;
        for (const [id, obligation] of Object.entries(db.rewardQueue || {})) {
            if (!obligation || !["pending", "failed", "journaled"].includes(obligation.status)) continue;
            if (checked >= BRIDGE_BATCH) break;
            checked++;
            const operationId = obligation.operationId || obligation.journalId || `reward_${id}`;
            const existingOperation = OperationJournalService.operation(operationId);
            if (obligation.status === "journaled" && existingOperation) {
                if (existingOperation.status === "completed") this.#markRewardObligation(id, "completed", operationId, "");
                continue;
            }
            const pseudo = { id: obligation.playerId, name: obligation.playerName || "Unknown" };
            const result = this.deliverContractReward(pseudo, {
                obligationId: id,
                contractId: obligation.contractId,
                rewardCents: obligation.rewardCents,
                score: obligation.score,
                reason: obligation.reason,
                operationId,
                journalId: operationId
            });
            if (result?.success) created++;
        }
        return { checked, created };
    }

    static #legacyUnbridgedCount() {
        const db = this.db();
        return (db.order || []).reduce((count, id) => count + (db.journals[id]?.bridgedAt ? 0 : 1), 0);
    }

    static #legacyView(operation) {
        return operation ? { ...operation, id: operation.operationId, type: operation.operationType } : null;
    }
}

export default FinancialJournalService;
