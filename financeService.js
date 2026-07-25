// MCity Dashboard V2 - Finance Facade and Treasury
// Phase 3.3: durable payout operations and one logical canonical ledger view.

import { Player } from "@minecraft/server";
import { CONFIG } from "../../config.js";
import { Database } from "../../core/database.js";
import { Logger } from "../../core/logger.js";
import { DisposableRegistry } from "../../core/disposableRegistry.js";
import { PlayerRegistry } from "../../core/playerRegistry.js";
import { DEFAULT_FINANCE_DB, validateFinanceData } from "../../schemas/financeSchema.js";
import { FinancePayoutService } from "./financePayoutService.js";
import { FinanceLedgerService } from "./financeLedgerService.js";

const FC = CONFIG.FINANCE;
const COLLECTION = FC.COLLECTION;
function now() { return Date.now(); }
function txId(prefix = "fin") { return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1000000)}`; }
function exactPositive(value) { const number = Number(value); return Number.isSafeInteger(number) && number > 0 ? number : 0; }

export class FinanceService {
    static #initialized = false;

    static initialize() {
        if (this.#initialized) return;
        this.#initialized = true;
        this.db();
        FinancePayoutService.initialize();
        DisposableRegistry.registerShutdownCleanup("FinanceService.lifecycle", () => {
            FinancePayoutService.shutdown();
            this.#initialized = false;
        });
        Logger.startup("Finance", `Finance service initialized (payout shards=${this.allPayoutCollections().length}, canonical ledger)`);
    }

    static db() { return Database.collection(COLLECTION, DEFAULT_FINANCE_DB, { validate: validateFinanceData }); }
    static payoutCollectionFor(playerId) { return FinancePayoutService.payoutCollectionFor(playerId); }
    static payoutDBFor(playerId) { return FinancePayoutService.payoutDBFor(playerId); }
    static allPayoutCollections() { return FinancePayoutService.allPayoutCollections(); }
    static payoutRoutingStatus() { return FinancePayoutService.routingStatus(); }

    static addTreasury(bucket, amount, reason = "Treasury income", meta = {}) {
        amount = exactPositive(amount);
        if (amount <= 0) return { success: true, amount: 0 };
        const id = String(meta.ledgerId || (meta.operationId ? `treasury_in:${bucket}:${meta.operationId}` : txId("treasury_in"))).substring(0, 120);
        const tx = Database.transaction(COLLECTION, data => {
            if (data.ledgerIndex?.[id] !== undefined) return { alreadyApplied: true };
            const target = this.#bucket(data, bucket);
            target.balance = (Number(target.balance) || 0) + amount;
            target.totalIn = (target.totalIn || 0) + amount;
            data.stats.totalTreasuryIn = (data.stats.totalTreasuryIn || 0) + amount;
            FinanceLedgerService.recordInData(data, { id, type: "treasury_in", amount, bucket, reason, ...meta, createdAt: now() });
            return { alreadyApplied: false };
        });
        if (!tx.success) return { success: false, amount, error: tx.error };
        const flush = Database.flushCritical(COLLECTION, "finance_treasury_in");
        return { success: flush.ok, amount, alreadyApplied: !!tx.result?.alreadyApplied, error: flush.ok ? "" : "Treasury ledger flush failed" };
    }

    static withdrawTreasury(bucket, amount, reason = "Treasury out", meta = {}, { allowNegative = true } = {}) {
        amount = exactPositive(amount);
        if (amount <= 0) return { success: true, amount: 0 };
        const id = String(meta.ledgerId || (meta.operationId ? `treasury_out:${bucket}:${meta.operationId}` : txId("treasury_out"))).substring(0, 120);
        const tx = Database.transaction(COLLECTION, data => {
            if (data.ledgerIndex?.[id] !== undefined) return { alreadyApplied: true };
            const target = this.#bucket(data, bucket);
            const balance = Number(target.balance) || 0;
            if (!allowNegative && balance < amount) throw new Error("Insufficient treasury balance.");
            target.balance = balance - amount;
            target.totalOut = (target.totalOut || 0) + amount;
            data.stats.totalTreasuryOut = (data.stats.totalTreasuryOut || 0) + amount;
            FinanceLedgerService.recordInData(data, { id, type: "treasury_out", amount, bucket, reason, ...meta, createdAt: now() });
            return { alreadyApplied: false };
        });
        if (!tx.success) return { success: false, amount, error: tx.error };
        const flush = Database.flushCritical(COLLECTION, "finance_treasury_out");
        return { success: flush.ok, amount, alreadyApplied: !!tx.result?.alreadyApplied, error: flush.ok ? "" : "Treasury ledger flush failed" };
    }

    static burn(amount, reason = "Burn", source = "system", meta = {}) {
        amount = exactPositive(amount);
        if (amount <= 0) return { success: true, amount: 0 };
        const id = String(meta.ledgerId || (meta.operationId ? `burn:${source}:${meta.operationId}` : txId("burn"))).substring(0, 120);
        const tx = Database.transaction(COLLECTION, data => {
            if (data.ledgerIndex?.[id] !== undefined) return { alreadyApplied: true };
            if (!data.treasury.burned) data.treasury.burned = { total: 0 };
            data.treasury.burned.total = (data.treasury.burned.total || 0) + amount;
            FinanceLedgerService.recordInData(data, { id, type: "burn", amount, source, reason, ...meta, createdAt: now() });
            return { alreadyApplied: false };
        });
        if (!tx.success) return { success: false, amount, error: tx.error };
        const flush = Database.flushCritical(COLLECTION, "finance_burn");
        return { success: flush.ok, amount, alreadyApplied: !!tx.result?.alreadyApplied, error: flush.ok ? "" : "Burn ledger flush failed" };
    }

    static recordMint(amount, reason = "Mint", source = "system", meta = {}) {
        amount = exactPositive(amount);
        if (amount <= 0) return { success: true, amount: 0 };
        const id = String(meta.ledgerId || (meta.operationId ? `mint:${source}:${meta.operationId}` : txId("mint"))).substring(0, 120);
        const tx = Database.transaction(COLLECTION, data => {
            if (data.ledgerIndex?.[id] !== undefined) return { alreadyApplied: true };
            if (!data.treasury.atm) data.treasury.atm = { minted: 0 };
            data.treasury.atm.minted = (data.treasury.atm.minted || 0) + amount;
            FinanceLedgerService.recordInData(data, { id, type: "mint", amount, source, reason, ...meta, createdAt: now() });
            return { alreadyApplied: false };
        });
        if (!tx.success) return { success: false, amount, error: tx.error };
        const flush = Database.flushCritical(COLLECTION, "finance_mint");
        return { success: flush.ok, amount, alreadyApplied: !!tx.result?.alreadyApplied, error: flush.ok ? "" : "Mint ledger flush failed" };
    }

    static addPayout(playerId, amount, reason = "Payout", source = "system", meta = {}) {
        return FinancePayoutService.addPayout(playerId, amount, reason, source, meta);
    }

    static payPlayer(playerId, amount, reason = "Payment", source = "system", meta = {}) {
        const payout = this.addPayout(playerId, amount, reason, source, meta);
        if (!payout.success || !FC.DIRECT_PAY_ONLINE) return payout;
        const online = PlayerRegistry.findOnlineById(playerId);
        if (!(online instanceof Player)) return payout;
        const claim = this.claimPayouts(online);
        return claim.success
            ? { success: true, delivered: true, amount: claim.credited, remainder: claim.remainder, payout, claim }
            : { ...payout, delivered: false, claimPending: !!claim.pending, claim };
    }

    static pendingFor(playerId) { return FinancePayoutService.pendingFor(playerId); }
    static pendingStats(playerId) { return FinancePayoutService.pendingStats(playerId); }
    static claimPayouts(player) { return FinancePayoutService.claimPayouts(player); }

    static getStats() {
        const base = this.db();
        const pending = FinancePayoutService.aggregatePendingStats();
        const ledger = FinanceLedgerService.aggregateStats(this.allPayoutCollections().filter(name => name !== COLLECTION));
        return {
            treasury: base.treasury,
            stats: ledger.stats,
            baseStats: ledger.baseStats,
            legacyShardStats: ledger.legacyShardStats,
            ledgerMeta: ledger.ledgerMeta,
            pendingPlayers: pending.pendingPlayers,
            pendingCount: pending.pendingCount,
            pendingAmount: pending.pendingAmount,
            reservedCount: pending.reservedCount,
            reservedAmount: pending.reservedAmount,
            activeClaims: pending.activeClaims,
            txCount: ledger.stats.totalTransactions || 0,
            payoutShards: pending.payoutShards,
            payoutRouting: this.payoutRoutingStatus()
        };
    }

    static recentTransactions(limit = 20, filter = null) {
        return FinanceLedgerService.recentTransactions(limit, filter, this.allPayoutCollections().filter(name => name !== COLLECTION));
    }

    static repair() {
        const payout = FinancePayoutService.repair();
        const tx = Database.transaction(COLLECTION, data => {
            const limit = Math.max(100, Math.floor(Number(FC.MAX_LEDGER_HISTORY) || 1500));
            if (data.transactions.length > limit) data.transactions = data.transactions.slice(-limit);
            data.ledgerIndex = {};
            for (const entry of data.transactions) if (entry?.id) data.ledgerIndex[entry.id] = entry.createdAt || 0;
            data.stats.lastUpdated = now();
            return { ledgerHistory: data.transactions.length };
        });
        return { ...payout, ledgerHistory: tx.result?.ledgerHistory || 0, error: tx.success ? undefined : tx.error };
    }

    static #bucket(data, bucket) {
        const key = String(bucket || "server").substring(0, 64);
        if (!data.treasury[key]) data.treasury[key] = { balance: 0, totalIn: 0, totalOut: 0 };
        return data.treasury[key];
    }
}

export default FinanceService;
