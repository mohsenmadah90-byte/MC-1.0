// MCity Dashboard V2 - Durable Finance Payout Operations
// Phase 3.3: payout creation and claims use OperationJournalService.

import { Player } from "@minecraft/server";
import { CONFIG } from "../../config.js";
import { Database } from "../../core/database.js";
import { Logger } from "../../core/logger.js";
import { ShardUtils } from "../../core/shardUtils.js";
import { MoneyShard } from "../../core/moneyShard.js";
import { OperationJournalService } from "../../core/operationJournalService.js";
import { AppliedOperationStore } from "../../core/appliedOperationStore.js";
import { DisposableRegistry } from "../../core/disposableRegistry.js";
import { MoneyService } from "../economy/moneyService.js";
import { NotificationService } from "../../dashboard/dashboardNotifications.js";
import { DEFAULT_FINANCE_DB, validateFinanceData } from "../../schemas/financeSchema.js";
import { DEFAULT_MONEY_DB, validateMoneyData } from "../../schemas/moneySchema.js";
import { FinanceLedgerService } from "./financeLedgerService.js";

const FC = CONFIG.FINANCE;
const BASE_COLLECTION = FC.COLLECTION;
const MAX_MONEY = CONFIG.MONEY.MAX_MONEY_CENTS;
const ROUTING_ALGORITHM = ShardUtils.HASH_ALGORITHM;
function now() { return Date.now(); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function safeText(value, max = 120) { return String(value || "").replace(/[\u0000-\u001f\u007f]/g, "").substring(0, max); }
function exactPositive(value) {
    const number = Number(value);
    return Number.isSafeInteger(number) && number > 0 ? number : 0;
}
function operationKey(prefix, value) {
    const raw = String(value || "");
    const hash = ShardUtils.fnv1a(raw).toString(16).padStart(8, "0");
    const tail = raw.replace(/[^a-zA-Z0-9_-]/g, "_").slice(-36);
    return `${prefix}_${hash}_${tail || "key"}`.substring(0, 120);
}

export class FinancePayoutService {
    static #initialized = false;
    static #routing = null;
    static #routingError = "";

    static initialize() {
        if (this.#initialized) return this.routingStatus();
        this.#initialized = true;
        OperationJournalService.initialize();
        this.#loadOrLockRouting();
        for (const name of this.allPayoutCollections()) Database.collection(name, DEFAULT_FINANCE_DB, { validate: validateFinanceData });
        OperationJournalService.registerHandler("finance_payout_create", {
            recover: operation => this.#recoverPayoutCreate(operation),
            resolveMarker: (operation, requirement) => this.#resolveMarker(operation, requirement)
        });
        OperationJournalService.registerHandler("finance_payout_claim", {
            recover: operation => this.#recoverPayoutClaim(operation),
            resolveMarker: (operation, requirement) => this.#resolveMarker(operation, requirement)
        });
        Database.registerRefreshHandler("FinancePayoutService", () => this.refreshRouting());
        FinanceLedgerService.initialize(this.allPayoutCollections().filter(name => name !== BASE_COLLECTION));
        DisposableRegistry.registerShutdownCleanup("FinancePayoutService.lifecycle", () => this.shutdown());
        Logger.startup("FinancePayout", `Durable payout service initialized (${this.#routing?.base}/${this.#routing?.shardCount}${this.#routingError ? ", routing error" : ""})`);
        return this.routingStatus();
    }

    static shutdown() {
        OperationJournalService.unregisterHandler("finance_payout_create");
        OperationJournalService.unregisterHandler("finance_payout_claim");
        Database.unregisterRefreshHandler("FinancePayoutService");
        FinanceLedgerService.shutdown();
        this.#routing = null;
        this.#routingError = "";
        this.#initialized = false;
    }

    static routingStatus() {
        if (!this.#initialized) this.initialize();
        return { ...(clone(this.#routing) || {}), healthy: !this.#routingError, error: this.#routingError };
    }

    static refreshRouting() {
        const base = Database.collection(BASE_COLLECTION, DEFAULT_FINANCE_DB, { validate: validateFinanceData });
        this.#routing = clone(base.payoutRouting || {});
        this.#routingError = this.#routingMismatch(this.#routing);
        FinanceLedgerService.initialize(this.allPayoutCollections().filter(name => name !== BASE_COLLECTION));
        return this.routingStatus();
    }

    static payoutCollectionFor(playerId) {
        if (!this.#initialized) this.initialize();
        const routing = this.#routing || { base: BASE_COLLECTION, shardCount: 1 };
        return ShardUtils.hashShardName(routing.base || BASE_COLLECTION, playerId, routing.shardCount || 1);
    }

    static payoutDBFor(playerId) {
        return Database.collection(this.payoutCollectionFor(playerId), DEFAULT_FINANCE_DB, { validate: validateFinanceData });
    }

    static allPayoutCollections() {
        const routing = this.#routing || this.#configuredRouting();
        return ShardUtils.allHashShardNames(routing.base || BASE_COLLECTION, routing.shardCount || 1);
    }

    static allFinanceCollections() {
        return [...new Set([BASE_COLLECTION, ...this.allPayoutCollections()])];
    }

    static addPayout(playerId, amount, reason = "Payout", source = "system", meta = {}) {
        if (!this.#initialized) this.initialize();
        const gate = this.#writeGate();
        if (!gate.success) return gate;
        const exactAmount = exactPositive(amount);
        if (!playerId || !exactAmount) return { success: false, message: "Invalid payout.", errorCode: "PAYOUT_INVALID" };
        const parentKey = safeText(meta.operationId || meta.journalId || "", 120);
        const operationEffect = safeText(meta.operationEffect || "payout", 64) || "payout";
        const payoutId = safeText(meta.payoutId || (parentKey ? operationKey("payout", `${playerId}:${parentKey}:${operationEffect}`) : OperationJournalService.newId("payout")), 96);
        const operationId = operationKey("finance_create", parentKey || payoutId);
        const playerName = safeText(meta.toName || meta.playerName || "Unknown", 32);
        const payout = {
            id: payoutId,
            amount: exactAmount,
            originalAmount: exactAmount,
            status: "pending",
            reservedAmount: 0,
            claimOperationId: "",
            reason: safeText(reason || "Payout", 120),
            source: safeText(source || "system", 64),
            fromId: safeText(meta.fromId || "", 64),
            fromName: safeText(meta.fromName || "", 32),
            operationId: parentKey || operationId,
            createdAt: now(),
            updatedAt: now(),
            meta: this.#safeMeta(meta)
        };
        const created = OperationJournalService.create("finance_payout_create", {
            actorId: safeText(meta.fromId || "", 64),
            actorName: safeText(meta.fromName || "", 32),
            targetId: safeText(playerId, 64),
            targetName: playerName,
            amount: exactAmount,
            payload: { playerId: safeText(playerId, 64), playerName, payout, parentOperationId: parentKey, parentOperationTracked: !!OperationJournalService.operation(parentKey), parentEffect: operationEffect },
            steps: { obligation: "pending", ledger: "pending" }
        }, { operationId });
        if (!created.success) return { success: false, message: created.error || "Payout operation could not be persisted.", errorCode: created.code, operationId };
        const existingPayload = created.operation?.payload || {};
        if (existingPayload.playerId !== playerId || existingPayload.payout?.amount !== exactAmount || existingPayload.payout?.id !== payoutId || existingPayload.payout?.reason !== payout.reason || existingPayload.payout?.source !== payout.source) {
            return { success: false, message: "Payout dedupe key conflicts with a different obligation.", errorCode: "PAYOUT_DEDUPE_CONFLICT", operationId };
        }
        const recovered = OperationJournalService.recover(operationId);
        const stored = this.#findPayout(playerId, payoutId, parentKey);
        const accepted = !!stored || ["obligation_persisted", "accounting_applied", "completed"].includes(OperationJournalService.operation(operationId)?.status);
        if (created.created && accepted) this.#notifyPayout(playerId, stored || payout, playerName);
        return {
            success: accepted || recovered.success,
            pending: !recovered.success || OperationJournalService.operation(operationId)?.status !== "completed",
            durableOperation: true,
            operationId,
            parentOperationId: parentKey,
            payout: clone(stored || payout),
            alreadyApplied: !created.created,
            message: accepted ? "Payout obligation accepted." : (recovered.error || "Payout operation is pending recovery.")
        };
    }

    static claimPayouts(player) {
        if (!this.#initialized) this.initialize();
        if (!(player instanceof Player)) return { success: false, claimed: 0, amount: 0, credited: 0, remainder: 0, message: "Invalid player." };
        const gate = this.#writeGate();
        if (!gate.success) return { ...gate, claimed: 0, amount: 0, credited: 0, remainder: this.pendingStats(player.id).amount };
        const db = this.payoutDBFor(player.id);
        const existingLock = db.claimLocks?.[player.id];
        if (existingLock?.operationId) {
            const existingOperation = OperationJournalService.operation(existingLock.operationId);
            if (existingOperation && !["completed", "cancelled"].includes(existingOperation.status)) {
                const recovered = OperationJournalService.recover(existingLock.operationId);
                return this.#claimResult(existingLock.operationId, recovered);
            }
        }
        const list = Array.isArray(db.payouts?.[player.id]) ? db.payouts[player.id] : [];
        const outstanding = list.reduce((sum, payout) => sum + exactPositive(payout?.amount), 0);
        const claimable = list.filter(payout => payout?.status !== "reserved" && exactPositive(payout?.amount) > 0);
        if (!claimable.length || outstanding <= 0) return { success: false, claimed: 0, amount: 0, credited: 0, remainder: outstanding, message: outstanding > 0 ? "A previous payout claim is still reserved." : "No pending payouts." };
        const moneyDb = MoneyService.dbFor(player.id);
        const currentBalance = Math.max(0, Math.floor(Number(moneyDb.players?.[player.id]?.balance) || MoneyService.getBalance(player)));
        const capacity = Math.max(0, MAX_MONEY - currentBalance);
        if (capacity <= 0) return { success: false, claimed: 0, amount: 0, credited: 0, remainder: outstanding, message: "Balance is at maximum; payouts remain pending." };
        const maxPayouts = Math.max(1, Math.min(200, Math.floor(Number(FC.CLAIM_BATCH_SIZE) || 50)));
        const allocations = [];
        let remainingCapacity = capacity;
        for (const payout of claimable.slice(0, maxPayouts)) {
            if (remainingCapacity <= 0) break;
            const allocated = Math.min(exactPositive(payout.amount), remainingCapacity);
            if (allocated <= 0) continue;
            allocations.push({ payoutId: payout.id, amount: allocated });
            remainingCapacity -= allocated;
        }
        const creditAmount = allocations.reduce((sum, item) => sum + item.amount, 0);
        if (creditAmount <= 0) return { success: false, claimed: 0, amount: 0, credited: 0, remainder: outstanding, message: "No payout amount fits the current balance capacity." };
        const operationId = OperationJournalService.newId(`finance_claim_${safeText(player.id, 24)}`);
        const created = OperationJournalService.create("finance_payout_claim", {
            actorId: player.id,
            actorName: player.name,
            targetId: player.id,
            targetName: player.name,
            amount: creditAmount,
            payload: {
                playerId: player.id,
                playerName: player.name,
                allocations,
                creditAmount,
                outstandingAtStart: outstanding,
                remainderAtStart: Math.max(0, outstanding - creditAmount),
                payoutCollection: this.payoutCollectionFor(player.id),
                moneyCollection: MoneyShard.collectionFor(player.id)
            },
            steps: { reservation: "pending", credit: "pending", settlement: "pending", ledger: "pending" }
        }, { operationId });
        if (!created.success) return { success: false, claimed: 0, amount: 0, credited: 0, remainder: outstanding, message: created.error || "Claim operation could not be persisted.", operationId };
        const recovered = OperationJournalService.recover(operationId);
        return this.#claimResult(operationId, recovered);
    }

    static pendingFor(playerId) {
        const list = this.payoutDBFor(playerId).payouts?.[playerId] || [];
        return list.filter(payout => exactPositive(payout?.amount) > 0).map(clone).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    }

    static pendingStats(playerId) {
        const list = this.pendingFor(playerId);
        let amount = 0, reservedAmount = 0, reservedCount = 0;
        for (const payout of list) {
            amount += exactPositive(payout.amount);
            if (payout.status === "reserved") { reservedCount++; reservedAmount += exactPositive(payout.reservedAmount); }
        }
        return { count: list.length, amount, reservedCount, reservedAmount, claimOperationId: this.payoutDBFor(playerId).claimLocks?.[playerId]?.operationId || "" };
    }

    static aggregatePendingStats() {
        let pendingAmount = 0, pendingCount = 0, pendingPlayers = 0, reservedCount = 0, reservedAmount = 0, activeClaims = 0;
        for (const name of this.allPayoutCollections()) {
            const db = Database.collection(name, DEFAULT_FINANCE_DB, { validate: validateFinanceData });
            activeClaims += Object.keys(db.claimLocks || {}).length;
            for (const list of Object.values(db.payouts || {})) {
                if (!Array.isArray(list) || !list.length) continue;
                pendingPlayers++;
                for (const payout of list) {
                    pendingCount++;
                    pendingAmount += exactPositive(payout.amount);
                    if (payout.status === "reserved") { reservedCount++; reservedAmount += exactPositive(payout.reservedAmount); }
                }
            }
        }
        return { pendingAmount, pendingCount, pendingPlayers, reservedCount, reservedAmount, activeClaims, payoutShards: this.allPayoutCollections().length };
    }

    static repair() {
        let summariesRebuilt = 0, malformedZeroRemoved = 0, orphanReservations = 0;
        for (const name of this.allPayoutCollections()) {
            Database.collection(name, DEFAULT_FINANCE_DB, { validate: validateFinanceData });
            const tx = Database.transaction(name, data => {
                let rebuilt = 0, zero = 0, orphan = 0;
                for (const [playerId, list] of Object.entries(data.payouts || {})) {
                    if (!Array.isArray(list)) continue;
                    const valid = [];
                    for (const payout of list) {
                        if (!payout || exactPositive(payout.amount) <= 0) { zero++; continue; }
                        if (payout.status === "reserved" && !OperationJournalService.operation(payout.claimOperationId)) orphan++;
                        valid.push(payout);
                    }
                    data.payouts[playerId] = valid;
                    this.#recomputeSummary(data, playerId, data.playerSummary?.[playerId]?.name || "Unknown");
                    rebuilt++;
                }
                return { rebuilt, zero, orphan };
            });
            if (tx.success) { summariesRebuilt += tx.result.rebuilt; malformedZeroRemoved += tx.result.zero; orphanReservations += tx.result.orphan; }
        }
        return { summariesRebuilt, malformedZeroRemoved, orphanReservations, trimmed: 0, removed: malformedZeroRemoved };
    }

    static #recoverPayoutCreate(operation) {
        const payload = operation.payload || {};
        const payout = payload.payout || {};
        if (!payload.playerId || !payout.id || !exactPositive(payout.amount)) return { success: false, retryable: false, error: "Invalid payout creation payload" };
        let current = OperationJournalService.operation(operation.operationId);
        if (current.status === "created") {
            const validated = OperationJournalService.transition(operation.operationId, "validated", { step: "validation", stepStatus: "done" });
            if (!validated.success) return validated;
            current = validated.operation;
        }
        const collection = this.payoutCollectionFor(payload.playerId);
        const payoutDb = Database.collection(collection, DEFAULT_FINANCE_DB, { validate: validateFinanceData });
        const alreadyStored = AppliedOperationStore.has(payoutDb, operation.operationId, "payout_obligation")
            || (payoutDb.payouts?.[payload.playerId] || []).some(item => item?.id === payout.id || (payload.parentOperationId && (item?.operationId === payload.parentOperationId || item?.meta?.journalId === payload.parentOperationId)));
        const size = Database.stats(collection)?.size || 0;
        if (!alreadyStored && size >= Math.max(100_000, Math.floor(Number(FC.PAYOUT_SHARD_SOFT_LIMIT_BYTES) || 850_000))) return { success: false, error: `Payout shard ${collection} is near its safe limit` };
        const obligation = OperationJournalService.applyEffect(operation.operationId, {
            collection,
            defaultData: DEFAULT_FINANCE_DB,
            validate: validateFinanceData,
            effectId: "payout_obligation",
            postStatus: current.status === "validated" ? "obligation_persisted" : null,
            step: "obligation",
            mutate: data => {
                if (!data.payouts[payload.playerId]) data.payouts[payload.playerId] = [];
                const list = data.payouts[payload.playerId];
                let existing = list.find(item => item?.id === payout.id);
                if (!existing && payload.parentOperationId) existing = list.find(item => item?.operationId === payload.parentOperationId || item?.meta?.operationId === payload.parentOperationId || item?.meta?.journalId === payload.parentOperationId);
                if (!existing) {
                    existing = clone(payout);
                    list.push(existing);
                } else if (exactPositive(existing.amount) !== exactPositive(payout.amount)) {
                    throw new Error("Existing payout dedupe record has a different remaining amount");
                }
                if (payload.parentOperationId && payload.parentOperationTracked) AppliedOperationStore.mark(data, payload.parentOperationId, payload.parentEffect || "payout", { amount: payout.amount, value: { payoutId: existing.id, payout: existing } });
                this.#recomputeSummary(data, payload.playerId, payload.playerName);
                data.stats.lastUpdated = now();
                return { payoutId: existing.id, payout: clone(existing) };
            }
        });
        if (!obligation.success) return obligation;
        current = OperationJournalService.operation(operation.operationId);
        const actualPayoutId = obligation.value?.payoutId || payout.id;
        const ledgerId = operationKey("ledger_payout", actualPayoutId);
        const ledger = OperationJournalService.applyEffect(operation.operationId, {
            collection: BASE_COLLECTION,
            defaultData: DEFAULT_FINANCE_DB,
            validate: validateFinanceData,
            effectId: "payout_ledger",
            postStatus: current.status === "obligation_persisted" ? "accounting_applied" : null,
            step: "ledger",
            mutate: data => FinanceLedgerService.recordInData(data, {
                id: ledgerId,
                type: "payout_pending",
                amount: payout.amount,
                count: 1,
                payoutId: actualPayoutId,
                operationId: operation.operationId,
                parentOperationId: payload.parentOperationId || "",
                toId: payload.playerId,
                toName: payload.playerName,
                reason: payout.reason,
                source: payout.source,
                createdAt: payout.createdAt
            })
        });
        if (!ledger.success) return ledger;
        const completed = OperationJournalService.complete(operation.operationId);
        return completed.success ? { success: true, completed: true, payoutId: actualPayoutId } : completed;
    }

    static #recoverPayoutClaim(operation) {
        const payload = operation.payload || {};
        const amount = exactPositive(payload.creditAmount || operation.amount);
        const allocations = Array.isArray(payload.allocations) ? payload.allocations : [];
        if (!payload.playerId || !amount || !allocations.length) return { success: false, retryable: false, error: "Invalid payout claim payload" };
        const payoutCollection = payload.payoutCollection || this.payoutCollectionFor(payload.playerId);
        const moneyCollection = payload.moneyCollection || MoneyShard.collectionFor(payload.playerId);
        let current = OperationJournalService.operation(operation.operationId);
        if (current.status === "created") {
            const validated = OperationJournalService.transition(operation.operationId, "validated", { step: "validation", stepStatus: "done" });
            if (!validated.success) return validated;
            current = validated.operation;
        }
        const reservation = OperationJournalService.applyEffect(operation.operationId, {
            collection: payoutCollection,
            defaultData: DEFAULT_FINANCE_DB,
            validate: validateFinanceData,
            effectId: "claim_reservation",
            postStatus: current.status === "validated" ? "obligation_persisted" : null,
            step: "reservation",
            mutate: data => {
                const lock = data.claimLocks?.[payload.playerId];
                if (lock?.operationId && lock.operationId !== operation.operationId) throw new Error(`Another payout claim ${lock.operationId} is active`);
                if (!data.claimLocks) data.claimLocks = {};
                const list = data.payouts?.[payload.playerId] || [];
                for (const allocation of allocations) {
                    const payout = list.find(item => item?.id === allocation.payoutId);
                    if (!payout) throw new Error(`Reserved payout ${allocation.payoutId} is missing`);
                    const allocated = exactPositive(allocation.amount);
                    if (!allocated || exactPositive(payout.amount) < allocated) throw new Error(`Payout ${allocation.payoutId} cannot reserve ${allocated}`);
                    if (payout.status === "reserved" && payout.claimOperationId !== operation.operationId) throw new Error(`Payout ${allocation.payoutId} is reserved by another claim`);
                    payout.status = "reserved";
                    payout.reservedAmount = allocated;
                    payout.claimOperationId = operation.operationId;
                    payout.updatedAt = now();
                }
                data.claimLocks[payload.playerId] = { operationId: operation.operationId, createdAt: lock?.createdAt || now(), updatedAt: now() };
                this.#recomputeSummary(data, payload.playerId, payload.playerName);
                return { reservedAmount: amount, allocationCount: allocations.length };
            }
        });
        if (!reservation.success) return reservation;
        current = OperationJournalService.operation(operation.operationId);
        const credit = OperationJournalService.applyEffect(operation.operationId, {
            collection: moneyCollection,
            defaultData: DEFAULT_MONEY_DB,
            validate: validateMoneyData,
            field: "appliedOperations",
            effectId: "claim_credit",
            postStatus: current.status === "obligation_persisted" ? "credit_applied" : null,
            step: "credit",
            mutate: data => {
                let record = data.players[payload.playerId];
                if (!record) {
                    record = { id: payload.playerId, name: payload.playerName || "Unknown", balance: 0, firstSeen: now(), lastSeen: 0, updatedAt: now() };
                    data.players[payload.playerId] = record;
                }
                const balance = Math.max(0, Math.floor(Number(record.balance) || 0));
                if (balance > MAX_MONEY - amount) throw new Error(`Payout claim capacity exceeded (${balance} + ${amount} > ${MAX_MONEY})`);
                record.balance = balance + amount;
                record.name = payload.playerName || record.name || "Unknown";
                record.updatedAt = now();
                data.stats.totalKnownPlayers = Object.keys(data.players || {}).length;
                data.stats.lastUpdated = now();
                return { balance: record.balance, credited: amount };
            }
        });
        if (!credit.success) return credit;
        current = OperationJournalService.operation(operation.operationId);
        const settlement = OperationJournalService.applyEffect(operation.operationId, {
            collection: payoutCollection,
            defaultData: DEFAULT_FINANCE_DB,
            validate: validateFinanceData,
            effectId: "claim_settlement",
            postStatus: current.status === "credit_applied" ? "accounting_applied" : null,
            step: "settlement",
            mutate: data => {
                const list = data.payouts?.[payload.playerId] || [];
                let fullySettled = 0;
                for (const allocation of allocations) {
                    const index = list.findIndex(item => item?.id === allocation.payoutId);
                    if (index < 0) throw new Error(`Settlement payout ${allocation.payoutId} is missing`);
                    const payout = list[index];
                    const allocated = exactPositive(allocation.amount);
                    if (payout.status !== "reserved" || payout.claimOperationId !== operation.operationId || exactPositive(payout.reservedAmount) !== allocated) throw new Error(`Payout ${allocation.payoutId} reservation mismatch`);
                    const remaining = exactPositive(payout.amount) - allocated;
                    if (remaining < 0) throw new Error(`Payout ${allocation.payoutId} settlement underflow`);
                    if (remaining === 0) { list.splice(index, 1); fullySettled++; }
                    else {
                        payout.amount = remaining;
                        payout.status = "pending";
                        payout.reservedAmount = 0;
                        payout.claimOperationId = "";
                        payout.updatedAt = now();
                    }
                }
                if (!list.length) delete data.payouts[payload.playerId];
                if (data.claimLocks?.[payload.playerId]?.operationId === operation.operationId) delete data.claimLocks[payload.playerId];
                if (!data.playerSummary[payload.playerId]) data.playerSummary[payload.playerId] = { name: payload.playerName || "Unknown", totalReceived: 0, totalPending: 0, lastClaimedAt: 0 };
                data.playerSummary[payload.playerId].totalReceived = (data.playerSummary[payload.playerId].totalReceived || 0) + amount;
                data.playerSummary[payload.playerId].lastClaimedAt = now();
                this.#recomputeSummary(data, payload.playerId, payload.playerName);
                data.stats.lastUpdated = now();
                return { credited: amount, allocationCount: allocations.length, fullySettled, remaining: (data.payouts?.[payload.playerId] || []).reduce((sum, payout) => sum + exactPositive(payout.amount), 0) };
            }
        });
        if (!settlement.success) return settlement;
        const ledgerId = operationKey("ledger_claim", operation.operationId);
        const ledger = OperationJournalService.applyEffect(operation.operationId, {
            collection: BASE_COLLECTION,
            defaultData: DEFAULT_FINANCE_DB,
            validate: validateFinanceData,
            effectId: "claim_ledger",
            step: "ledger",
            mutate: data => FinanceLedgerService.recordInData(data, {
                id: ledgerId,
                type: "payout_claim",
                amount,
                count: allocations.length,
                operationId: operation.operationId,
                toId: payload.playerId,
                toName: payload.playerName,
                reason: "Claim pending payouts",
                source: "finance",
                createdAt: now()
            })
        });
        if (!ledger.success) return ledger;
        const completed = OperationJournalService.complete(operation.operationId);
        if (!completed.success) return completed;
        MoneyService.refreshBalanceMirror(payload.playerId);
        return { success: true, completed: true, credited: amount, remainder: settlement.value?.remaining ?? payload.remainderAtStart };
    }

    static #claimResult(operationId, recoveryResult = null) {
        const operation = OperationJournalService.operation(operationId);
        if (!operation) return { success: false, claimed: 0, amount: 0, credited: 0, remainder: 0, operationId, message: "Claim operation is missing." };
        const payload = operation.payload || {};
        const completed = operation.status === "completed";
        const credited = completed ? exactPositive(payload.creditAmount || operation.amount) : 0;
        const currentPending = payload.playerId ? this.pendingStats(payload.playerId).amount : exactPositive(payload.outstandingAtStart);
        if (completed && recoveryResult?.recovered !== false) this.#notifyClaim(payload.playerId, credited, payload.allocations?.length || 0, operationId);
        return {
            success: completed,
            pending: !completed,
            claimed: completed ? (payload.allocations?.length || 0) : 0,
            amount: credited,
            credited,
            remainder: currentPending,
            operationId,
            status: operation.status,
            message: completed ? `Claimed ${credited} cents; ${currentPending} cents remain pending.` : (recoveryResult?.error || operation.lastError || "Claim is pending automatic recovery.")
        };
    }

    static #findPayout(playerId, payoutId, parentOperationId = "") {
        const list = this.payoutDBFor(playerId).payouts?.[playerId] || [];
        return list.find(item => item?.id === payoutId) || (parentOperationId ? list.find(item => item?.operationId === parentOperationId || item?.meta?.operationId === parentOperationId || item?.meta?.journalId === parentOperationId) : null) || null;
    }

    static #recomputeSummary(data, playerId, playerName = "Unknown") {
        if (!data.playerSummary) data.playerSummary = {};
        const existing = data.playerSummary[playerId] || { name: playerName, totalReceived: 0, totalPending: 0, lastClaimedAt: 0 };
        existing.name = safeText(playerName || existing.name || "Unknown", 32);
        existing.totalPending = (data.payouts?.[playerId] || []).reduce((sum, payout) => sum + exactPositive(payout?.amount), 0);
        existing.totalReceived = Math.max(0, Math.floor(Number(existing.totalReceived) || 0));
        existing.lastClaimedAt = Math.max(0, Number(existing.lastClaimedAt) || 0);
        data.playerSummary[playerId] = existing;
        return existing;
    }

    static #resolveMarker(operation, requirement) {
        if (requirement.effectId === "claim_credit") Database.collection(requirement.collection, DEFAULT_MONEY_DB, { validate: validateMoneyData });
        else Database.collection(requirement.collection, DEFAULT_FINANCE_DB, { validate: validateFinanceData });
    }

    static #loadOrLockRouting() {
        const configured = this.#configuredRouting();
        const base = Database.collection(BASE_COLLECTION, DEFAULT_FINANCE_DB, { validate: validateFinanceData });
        const existing = base.payoutRouting || {};
        if (existing.locked) {
            this.#routing = clone(existing);
            this.#routingError = this.#routingMismatch(existing);
            if (this.#routingError) Logger.error("FinancePayout", this.#routingError);
            return;
        }
        const hasBasePayouts = Object.values(base.payouts || {}).some(list => Array.isArray(list) && list.length);
        let selected;
        if (base.payoutSharded && Number(base.payoutShardCount) > 1) {
            selected = { enabled: true, base: "finance_payouts", shardCount: Math.floor(Number(base.payoutShardCount)), algorithm: ROUTING_ALGORITHM, locked: true, lockedAt: now(), sourceBase: BASE_COLLECTION };
        } else if (!hasBasePayouts && configured.enabled) {
            selected = { ...configured, locked: true, lockedAt: now(), sourceBase: BASE_COLLECTION };
        } else {
            // Preserve legacy base obligations rather than running the old
            // destructive in-memory migration. Full re-sharding remains Part 5.2.
            selected = { enabled: false, base: BASE_COLLECTION, shardCount: 1, algorithm: ROUTING_ALGORITHM, locked: true, lockedAt: now(), sourceBase: BASE_COLLECTION };
        }
        const tx = Database.transaction(BASE_COLLECTION, data => {
            data.payoutRouting = selected;
            data.payoutSharded = selected.enabled && selected.shardCount > 1;
            data.payoutShardCount = selected.shardCount;
            data.ledgerMeta.canonical = true;
            data.ledgerMeta.canonicalSince = data.ledgerMeta.canonicalSince || now();
            data.stats.lastUpdated = now();
            return selected;
        });
        if (!tx.success || !Database.flushCritical(BASE_COLLECTION, "finance_payout_routing_lock").ok) {
            this.#routingError = tx.error || "Finance payout routing lock could not be persisted";
            this.#routing = selected;
        } else {
            this.#routing = clone(selected);
            this.#routingError = "";
        }
    }

    static #configuredRouting() {
        const definition = CONFIG.DATABASE?.SHARDING?.MODULES?.FINANCE_PAYOUTS || {};
        const enabled = !!definition.ENABLED;
        return {
            enabled,
            base: enabled ? safeText(definition.BASE || "finance_payouts", 64) : BASE_COLLECTION,
            shardCount: enabled ? ShardUtils.clampCount(definition.SHARD_COUNT || CONFIG.DATABASE?.SHARDING?.PLAYER_SHARD_COUNT || 8, 8) : 1,
            algorithm: ROUTING_ALGORITHM,
            locked: false,
            lockedAt: 0,
            sourceBase: BASE_COLLECTION
        };
    }

    static #routingMismatch(routing) {
        const configured = this.#configuredRouting();
        if (!routing?.locked) return "Finance payout routing is not locked";
        if (routing.algorithm !== ROUTING_ALGORITHM) return `Finance payout routing algorithm mismatch: ${routing.algorithm}`;
        if (routing.enabled && configured.enabled && (routing.base !== configured.base || Number(routing.shardCount) !== Number(configured.shardCount))) return `Locked Finance payout routing is ${routing.base}/${routing.shardCount}; configured ${configured.base}/${configured.shardCount}`;
        if (!routing.enabled && (routing.base !== BASE_COLLECTION || Number(routing.shardCount) !== 1)) return `Invalid locked legacy Finance payout routing ${routing.base}/${routing.shardCount}`;
        return "";
    }

    static #writeGate() {
        if (this.#routingError) return { success: false, message: this.#routingError, errorCode: "FINANCE_ROUTING_MISMATCH" };
        const runtime = Database.runtimeStatus();
        if (runtime.mode !== "NORMAL") return { success: false, message: `Database mode ${runtime.mode} rejects payout writes`, errorCode: "FINANCE_DATABASE_MODE" };
        return { success: true };
    }

    static #notifyPayout(playerId, payout, playerName) {
        try {
            NotificationService.create(playerId, {
                type: "payout",
                source: payout.source,
                title: "Pending Payout",
                message: `${payout.amount} cents is waiting to be claimed. Reason: ${payout.reason}`,
                action: "payouts",
                meta: { payoutId: payout.id, amount: payout.amount }
            });
        } catch (error) { Logger.debug("FinancePayout", `Payout notification failed for ${playerName || playerId}`, error); }
    }

    static #notifyClaim(playerId, amount, count, operationId) {
        if (!playerId) return;
        try {
            NotificationService.create(playerId, {
                type: "payout_claimed",
                source: "finance",
                title: "Payouts Claimed",
                message: `You claimed ${amount} cents from ${count} payout allocation(s).`,
                action: "",
                meta: { amount, count, operationId }
            });
        } catch (error) { Logger.debug("FinancePayout", `Claim notification failed for ${playerId}`, error); }
    }

    static #safeMeta(meta) {
        try {
            const json = JSON.stringify(meta || {});
            if (json.length > 1200) return { truncated: true, preview: json.slice(0, 1200) };
            return JSON.parse(json);
        } catch { return {}; }
    }
}

export default FinancePayoutService;
