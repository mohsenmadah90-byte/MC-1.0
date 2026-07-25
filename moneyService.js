// MCity Dashboard V2 - Money Service
// Commandless economy service used by Dashboard UIs and future modules.
// Phase 1 Critical Fix: Register cache cleanup with DisposableRegistry.
// Phase 4 Scalability: Rate limiting on transfer + EventBus integration + sharding.
// Phase 7 (v0.21.0): Atomic debit() method + mirror-on-read safety.
// Phase 2 (v1.5.2): DB-authoritative money core; scoreboard is a mirror.
// Phase 8 (v1.5.8): Use PlayerRegistry for online refresh paths.
// Hotfix 3 (v1.6.3): Cross-shard transfer journal markers.
// Patch 3 (v1.6.7): database.restored cache/scoreboard refresh hook.

import { world, Player } from "@minecraft/server";
import { CONFIG } from "../../config.js";
import { Database } from "../../core/database.js";
import { Logger } from "../../core/logger.js";
import { MoneyUtils } from "../../core/moneyUtils.js";
import { DisposableRegistry } from "../../core/disposableRegistry.js";
import { RateLimiter } from "../../core/rateLimiter.js";
import { EventBus } from "../../core/eventBus.js";
import { MoneyShard } from "../../core/moneyShard.js";
import { OperationJournalService } from "../../core/operationJournalService.js";
import { PlayerRegistry } from "../../core/playerRegistry.js";
import { DEFAULT_MONEY_DB, validateMoneyData } from "../../schemas/moneySchema.js";
import { AuditService } from "../audit/auditService.js";

const MC = CONFIG.MONEY;
const COLLECTION = MC.COLLECTION;
const MAX_MONEY = MC.MAX_MONEY_CENTS;

export class MoneyService {
    static #dollarObj = null;
    static #centObj = null;
    static #balanceCache = new Map();
    static #topCache = { data: null, time: 0 };
    static #rankIndex = null;  // Phase 7.7 (v1.0.0) (P2): Map<playerId, rank>
    static #shardCache = new Map();  // Phase 7.7 (v1.0.0) (P3): playerId -> shardName
    static #initialized = false;

    static initialize() {
        if (this.#initialized) return;
        this.#initialized = true;
        // Phase 3: Initialize money sharding before loading collections
        MoneyShard.initialize();
        this.db();
        this.ensureObjectives();
        // Phase 1 Fix: Register cache cleanup so player leave doesn't leak memory.
        DisposableRegistry.registerPlayerCleanup("MoneyService.balanceCache", (playerId) => {
            this.#balanceCache.delete(playerId);
        });
        // Phase 7.7 (v1.0.0) (P3): Clean up shard cache on leave.
        DisposableRegistry.registerPlayerCleanup("MoneyService.shardCache", (playerId) => {
            this.#shardCache.delete(playerId);
        });
        DisposableRegistry.registerShutdownCleanup("MoneyService.lifecycle", () => {
            this.#balanceCache.clear();
            this.#shardCache.clear();
            this.#topCache = { data: null, time: 0 };
            this.#rankIndex = null;
            this.#dollarObj = null;
            this.#centObj = null;
            this.#initialized = false;
        });
        EventBus.on("database.restored", event => this.onDatabaseRestored(event));
        Database.registerRefreshHandler("MoneyService", event => this.onDatabaseRestored(event));
        Logger.startup("Money", "Money service initialized");
    }

    static db() {
        // Returns the base (legacy) collection. Use dbFor(playerId) for
        // per-player operations when sharding is enabled.
        return Database.collection(COLLECTION, DEFAULT_MONEY_DB, { validate: validateMoneyData });
    }

    /**
     * Phase 4 Scalability: Returns the appropriate collection for a given
     * player. If sharding is enabled, this returns the shard collection;
     * otherwise, it returns the base collection (legacy behavior).
     */
    static dbFor(playerId) {
        if (!playerId) return this.db();
        // Phase 7.7 (v1.0.0) (P3): Cache the shard name per player to avoid
        // recomputing the FNV-1a hash on every dbFor() call. The cache is
        // cleaned up on player leave via DisposableRegistry.
        let shardName = this.#shardCache.get(playerId);
        if (!shardName) {
            shardName = MoneyShard.collectionFor(playerId);
            this.#shardCache.set(playerId, shardName);
        }
        if (shardName === COLLECTION) return this.db();
        return Database.collection(shardName, DEFAULT_MONEY_DB, { validate: validateMoneyData });
    }

    static ensureObjectives() {
        try {
            if (!this.#dollarObj) this.#dollarObj = world.scoreboard.getObjective(MC.DOLLAR_OBJECTIVE) || world.scoreboard.addObjective(MC.DOLLAR_OBJECTIVE, "§d§lMoney");
            if (!this.#centObj) this.#centObj = world.scoreboard.getObjective(MC.CENT_OBJECTIVE) || world.scoreboard.addObjective(MC.CENT_OBJECTIVE, "§d§lMoney Cents");
        } catch (error) {
            Logger.warn("Money", "Failed to ensure scoreboard objectives", error);
        }
        return { dollarObj: this.#dollarObj, centObj: this.#centObj };
    }

    static getBalance(player) {
        if (!(player instanceof Player)) return 0;
        const cached = this.#balanceCache.get(player.id);
        if (cached && Date.now() - cached.time < MC.BALANCE_CACHE_TTL_MS) return cached.balance;

        // Phase 2 (v1.5.2): The Dynamic Property money DB is now the
        // authoritative balance source. Scoreboard objectives are a legacy /
        // UI mirror only. If a DB record exists, we return it and repair the
        // scoreboard mirror when needed. If no DB record exists yet, we seed
        // from the existing scoreboard value (legacy import path) or the
        // configured starting balance.
        const db = this.dbFor(player.id);
        const rec = db.players[player.id];
        let balance;

        if (rec) {
            balance = this.#clamp(rec.balance);
            if (this.#readScoreBalance(player) !== balance) this.#writeScoreBalance(player, balance);
            this.#touchLastSeen(player, balance, rec);
        } else {
            balance = this.#initialBalanceFor(player);
            this.#touchLastSeen(player, balance, null);
            if (this.#readScoreBalance(player) !== balance) this.#writeScoreBalance(player, balance);
        }

        this.#balanceCache.set(player.id, { balance, time: Date.now() });
        return balance;
    }

    static setBalance(player, cents, reason = "set") {
        if (!(player instanceof Player)) return { success: false, message: "Invalid player." };
        const numeric = Number(cents);
        if (!Number.isFinite(numeric)) return { success: false, message: "Invalid balance." };
        const balance = Math.floor(numeric);
        if (balance < 0 || balance > MAX_MONEY) return { success: false, message: `Balance must be between 0 and ${MAX_MONEY} cents.` };
        const shardName = MoneyShard.collectionFor(player.id);
        this.dbFor(player.id); // ensure collection is loaded

        const tx = Database.transaction(shardName, data => {
            const existing = data.players[player.id];
            const previous = existing ? this.#clamp(existing.balance) : this.#initialBalanceFor(player);
            this.#writeBalanceRecord(data, player, balance, existing);
            return { balance, previous };
        });

        if (!tx.success) {
            Logger.error("Money", `setBalance DB commit failed for ${player.id} (${player.name})`, { reason, error: tx.error });
            return { success: false, message: tx.error || "Balance update failed." };
        }

        this.#afterBalanceWrite(player, balance);
        Logger.info("Money", `Balance set for ${player.name}: ${MoneyUtils.formatCents(balance)} (${reason})`);
        return { success: true, balance, credited: balance - (tx.result.previous ?? balance), remainder: 0 };
    }

    static addMoney(player, cents, reason = "add") {
        if (!(player instanceof Player)) return { success: false, message: "Invalid player." };
        const delta = Math.floor(Number(cents) || 0);
        if (delta === 0) return { success: true, balance: this.getBalance(player), previous: this.getBalance(player), delta: 0, credited: 0, remainder: 0 };

        const shardName = MoneyShard.collectionFor(player.id);
        this.dbFor(player.id); // ensure collection is loaded
        let nextBalance = 0;

        const tx = Database.transaction(shardName, data => {
            let rec = data.players[player.id];
            const current = rec ? this.#clamp(rec.balance) : this.#initialBalanceFor(player);
            const requested = current + delta;
            if (!Number.isSafeInteger(requested)) throw new Error("Balance arithmetic exceeded safe integer range.");
            if (requested < 0) throw new Error(`Insufficient funds: ${current} < ${Math.abs(delta)}`);
            if (requested > MAX_MONEY) throw new Error(`Balance capacity exceeded: ${requested} > ${MAX_MONEY}`);
            nextBalance = requested;
            rec = this.#writeBalanceRecord(data, player, nextBalance, rec);
            return { balance: rec.balance, previous: current, delta, credited: delta, remainder: 0 };
        });

        if (!tx.success) {
            Logger.error("Money", `addMoney DB commit failed for ${player.id} (${player.name})`, { reason, delta, error: tx.error });
            return { success: false, message: tx.error || "Balance update failed.", credited: 0, remainder: delta > 0 ? delta : 0, requestedDelta: delta };
        }

        this.#afterBalanceWrite(player, nextBalance);
        return { success: true, balance: nextBalance, previous: tx.result.previous, delta, credited: delta, remainder: 0 };
    }

    /**
     * Phase 7 (v0.21.0): Atomic debit method.
     *
     * Deducts `cents` from `player` atomically. Unlike `addMoney(player, -cents, ...)`
     * which silently clamps a negative result to 0 (and thus lets the caller
     * believe the deduction succeeded when it actually didn't), this method:
     *
     *   1. Verifies the player record exists in the shard.
     *   2. Performs the balance check AND the deduction inside the same
     *      `Database.transaction` callback, so the check and the mutation
     *      are atomic at the DB level. Two concurrent `debit` calls on the
     *      same player cannot both pass the balance check and then both
     *      deduct (the second transaction sees the updated balance).
     *   3. Returns `{ success: false, message }` when funds are insufficient
     *      or the player is invalid — callers MUST check `.success`.
     *
     * After a successful DB transaction, the scoreboard mirror and caches are
     * updated directly so `getBalance` reflects the new value immediately
     * without running a second DB transaction.
     *
     * Use this instead of `addMoney(player, -X, ...)` for EVERY deduction
     * that grants the player something in return (items, claims, contracts,
     * ATM exchanges, etc.). Failure to do so leaves a race-condition exploit
     * where a player can trigger two purchases in the same tick and pay only
     * once (because both `addMoney(-X)` calls clamp to 0).
     *
     * @param {Player} player
     * @param {number} cents - positive amount to deduct
     * @param {string} reason - audit reason
     * @returns {{ success: boolean, balance?: number, message?: string }}
     */
    static debit(player, cents, reason = "debit") {
        if (!(player instanceof Player)) return { success: false, message: "Invalid player." };
        const amount = Math.floor(Number(cents) || 0);
        if (amount <= 0) return { success: false, message: "Debit amount must be positive." };

        const shardName = MoneyShard.collectionFor(player.id);
        // Ensure the shard collection is loaded before transacting.
        this.dbFor(player.id);

        const tx = Database.transaction(shardName, data => {
            let rec = data.players[player.id];
            if (!rec) {
                // Create a fresh record on first deduction (rare path; usually
                // getBalance has already populated it). Balance starts at 0.
                rec = this.#writeBalanceRecord(data, player, this.#initialBalanceFor(player));
            }
            const currentBal = this.#clamp(rec.balance);
            if (currentBal < amount) {
                throw new Error(`Insufficient funds: ${currentBal} < ${amount}`);
            }
            rec.balance = currentBal - amount;
            rec.updatedAt = Date.now();
            return { balance: rec.balance };
        });

        if (!tx.success) {
            return { success: false, message: tx.error || "Debit failed." };
        }

        // DB already committed above; now update the scoreboard mirror/cache
        // without performing a second DB transaction.
        this.#afterBalanceWrite(player, tx.result.balance);
        return { success: true, balance: tx.result.balance };
    }

    static #transferOperationId() {
        return OperationJournalService.newId("money_transfer");
    }

    static transfer(sender, target, amountCents) {
        if (!(sender instanceof Player) || !(target instanceof Player)) return { success: false, message: "Invalid sender or target." };
        if (sender.id === target.id) return { success: false, message: "§cYou cannot send money to yourself." };
        const amount = Math.floor(Number(amountCents) || 0);
        if (amount <= 0) return { success: false, message: "§cAmount must be greater than zero." };
        if (amount > MC.MAX_TRANSFER_CENTS) return { success: false, message: "§cAmount is too large." };

        const rl = CONFIG.RATE_LIMITS?.MONEY_TRANSFER;
        if (rl && !RateLimiter.check(`money_transfer:${sender.id}`, rl[0], rl[1])) {
            const retryIn = RateLimiter.retryIn(`money_transfer:${sender.id}`, rl[0], rl[1]);
            return { success: false, message: `§cRate limit. Try again in ${Math.ceil(retryIn / 1000)}s.` };
        }

        const senderBalance = this.getBalance(sender);
        if (senderBalance < amount) return { success: false, message: `§cNot enough money. Balance: §e${MoneyUtils.formatCents(senderBalance)}` };
        const targetBalanceBefore = this.getBalance(target);
        if (targetBalanceBefore > MAX_MONEY - amount) {
            return { success: false, message: `§cTarget cannot receive this amount. Available capacity: §e${MoneyUtils.formatCents(MAX_MONEY - targetBalanceBefore)}` };
        }

        const senderShardName = MoneyShard.collectionFor(sender.id);
        const targetShardName = MoneyShard.collectionFor(target.id);
        const sameShard = senderShardName === targetShardName;
        this.dbFor(sender.id);
        this.dbFor(target.id);

        let txResult;
        let operationId = "";
        let pendingRecovery = false;
        if (sameShard) {
            txResult = Database.transaction(senderShardName, data => {
                const sRec = data.players[sender.id];
                if (!sRec) throw new Error("Sender record missing.");
                let tRec = data.players[target.id];
                if (!tRec) tRec = this.#writeBalanceRecord(data, target, this.#initialBalanceFor(target));
                const sBal = this.#clamp(sRec.balance);
                const tBal = this.#clamp(tRec.balance);
                if (sBal < amount) throw new Error("Insufficient funds.");
                if (tBal > MAX_MONEY - amount) throw new Error("Target balance capacity exceeded.");
                sRec.balance = sBal - amount;
                tRec.balance = tBal + amount;
                sRec.name = sender.name;
                tRec.name = target.name;
                sRec.updatedAt = Date.now();
                tRec.updatedAt = Date.now();
                data.stats.totalKnownPlayers = Object.keys(data.players || {}).length;
                data.stats.lastUpdated = Date.now();
                return { senderBalance: sRec.balance, targetBalance: tRec.balance };
            });
        } else {
            operationId = this.#transferOperationId();
            const created = OperationJournalService.create("money_transfer_cross_shard", {
                actorId: sender.id,
                actorName: sender.name,
                targetId: target.id,
                targetName: target.name,
                amount,
                payload: {
                    senderId: sender.id,
                    senderName: sender.name,
                    targetId: target.id,
                    targetName: target.name,
                    amount,
                    senderShard: senderShardName,
                    targetShard: targetShardName
                },
                steps: { debit: "pending", obligation: "pending", credit: "pending", accounting: "pending" }
            }, { operationId });
            if (!created.success) return { success: false, message: `§cTransfer failed to start: ${created.error || "journal unavailable"}` };
            const validated = OperationJournalService.transition(operationId, "validated", { step: "validation", stepStatus: "done", reason: "money_transfer_validated" });
            if (!validated.success) return { success: false, operationId, pendingRecovery: true, message: "§cTransfer intent was saved but validation could not be committed; recovery will inspect it." };

            const debit = OperationJournalService.applyEffect(operationId, {
                collection: senderShardName,
                defaultData: DEFAULT_MONEY_DB,
                validate: validateMoneyData,
                field: "appliedJournals",
                effectId: "debit",
                postStatus: "debit_applied",
                step: "debit",
                mutate: data => {
                    const sRec = data.players[sender.id];
                    if (!sRec) throw new Error("Sender record missing.");
                    const current = this.#clamp(sRec.balance);
                    if (current < amount) throw new Error("Insufficient funds.");
                    sRec.balance = current - amount;
                    sRec.name = sender.name;
                    sRec.updatedAt = Date.now();
                    data.stats.lastUpdated = Date.now();
                    return { senderBalance: sRec.balance };
                }
            });
            if (!debit.success) {
                if (debit.destinationApplied) {
                    OperationJournalService.scheduleRetry(operationId, debit.error || "Sender debit transition requires recovery");
                    return { success: false, operationId, pendingRecovery: true, message: "§eSender debit is safely journaled and pending automatic recovery; do not repeat the transfer." };
                }
                OperationJournalService.cancel(operationId, debit.error || "Sender debit failed");
                return { success: false, operationId, message: `§cTransfer failed: ${debit.error || "sender debit failed"}` };
            }

            const obligation = OperationJournalService.transition(operationId, "obligation_persisted", { step: "obligation", stepStatus: "done", reason: "money_transfer_obligation" });
            if (!obligation.success) {
                OperationJournalService.scheduleRetry(operationId, obligation.error || "Obligation transition failed");
                return { success: false, operationId, pendingRecovery: true, message: "§eTransfer debit is safe and pending automatic recovery." };
            }

            const credit = OperationJournalService.applyEffect(operationId, {
                collection: targetShardName,
                defaultData: DEFAULT_MONEY_DB,
                validate: validateMoneyData,
                field: "appliedJournals",
                effectId: "credit",
                postStatus: "credit_applied",
                step: "credit",
                mutate: data => {
                    let tRec = data.players[target.id];
                    if (!tRec) tRec = this.#writeBalanceRecord(data, target, this.#initialBalanceFor(target));
                    const current = this.#clamp(tRec.balance);
                    if (current > MAX_MONEY - amount) throw new Error("Target balance capacity exceeded.");
                    tRec.balance = current + amount;
                    tRec.name = target.name;
                    tRec.updatedAt = Date.now();
                    data.stats.totalKnownPlayers = Object.keys(data.players || {}).length;
                    data.stats.lastUpdated = Date.now();
                    return { targetBalance: tRec.balance };
                }
            });

            if (!credit.success) {
                if (credit.destinationApplied || credit.safeToCompensate === false) {
                    OperationJournalService.scheduleRetry(operationId, credit.error || "Target credit durability is uncertain");
                    return { success: false, operationId, pendingRecovery: true, message: "§eTarget credit is journaled and pending durability recovery; no compensation was applied." };
                }
                Logger.error("Money", `Cross-shard target credit failed for ${target.id}; applying exact sender rollback.`);
                const rollback = OperationJournalService.applyEffect(operationId, {
                    collection: senderShardName,
                    defaultData: DEFAULT_MONEY_DB,
                    validate: validateMoneyData,
                    field: "appliedJournals",
                    effectId: "rollback",
                    step: "rollback",
                    mutate: data => {
                        const marker = data.appliedJournals?.[operationId];
                        if (!marker?.debit) throw new Error("Debit marker missing; rollback refused.");
                        const sRec = data.players[sender.id];
                        if (!sRec) throw new Error("Sender record missing during rollback.");
                        const current = this.#clamp(sRec.balance);
                        if (current > MAX_MONEY - amount) throw new Error("Sender rollback capacity exceeded.");
                        sRec.balance = current + amount;
                        sRec.updatedAt = Date.now();
                        data.stats.lastUpdated = Date.now();
                        return { senderBalance: sRec.balance };
                    }
                });
                if (rollback.success) {
                    OperationJournalService.cancel(operationId, credit.error || "Target credit failed; sender debit rolled back");
                    const rollbackBalance = rollback.value?.senderBalance ?? senderBalance;
                    this.#afterBalanceWrite(sender, rollbackBalance);
                    return { success: false, operationId, message: "§cTransfer failed. Sender debit was rolled back exactly." };
                }
                OperationJournalService.scheduleRetry(operationId, `Target credit failed and rollback could not complete: ${credit.error || rollback.error}`);
                return { success: false, operationId, pendingRecovery: true, message: "§eTransfer is pending safe automatic recovery; do not repeat it." };
            }

            const accounting = OperationJournalService.transition(operationId, "accounting_applied", { step: "accounting", stepStatus: "skipped", reason: "money_transfer_accounting" });
            const completed = accounting.success ? OperationJournalService.complete(operationId) : accounting;
            pendingRecovery = !completed.success;
            txResult = {
                success: true,
                result: {
                    senderBalance: debit.value?.senderBalance ?? this.getBalance(sender),
                    targetBalance: credit.value?.targetBalance ?? this.getBalance(target)
                }
            };
        }

        if (!txResult.success) return { success: false, operationId, message: `§cTransfer failed: ${txResult.error}` };

        this.#afterBalanceWrite(sender, txResult.result.senderBalance);
        this.#afterBalanceWrite(target, txResult.result.targetBalance);
        AuditService.record("money.transfer", "money", sender.id, sender.name, `Transfer ${MoneyUtils.formatCents(amount)} to ${target.name}`, { targetId: target.id, targetName: target.name, amount, operationId });
        EventBus.emit("money.transferred", {
            senderId: sender.id,
            senderName: sender.name,
            targetId: target.id,
            targetName: target.name,
            amount,
            operationId
        });
        return {
            success: true,
            amount,
            operationId,
            pendingRecovery,
            senderBalance: txResult.result.senderBalance,
            targetBalance: txResult.result.targetBalance,
            message: `§aSent §e${MoneyUtils.formatCents(amount)} §ato §f${target.name}§a.${pendingRecovery ? " §e(Accounting journal will self-heal.)" : ""}`
        };
    }

    static refreshBalanceMirror(playerId) {
        const player = PlayerRegistry.findOnlineById(playerId);
        if (!player) return false;
        const balance = this.dbFor(playerId).players?.[playerId]?.balance;
        if (balance === undefined) return false;
        this.#afterBalanceWrite(player, this.#clamp(balance));
        return true;
    }

    static refreshOnlinePlayers() {
        // Phase 8: use the maintained online registry instead of allocating
        // world.getAllPlayers() on every leaderboard refresh.
        for (const player of PlayerRegistry.online()) {
            try { this.getBalance(player); } catch {}
        }
    }

    static getAllBalances() {
        this.refreshOnlinePlayers();
        // Phase 4: aggregate across all shards if sharding is enabled.
        // Phase 4 Fix: Use getters instead of public field access.
        if (!MoneyShard.isEnabled() || MoneyShard.getShardCount() === 1) {
            const db = this.db();
            return Object.values(db.players || {}).map(rec => ({
                id: rec.id,
                name: rec.name || "Unknown",
                balance: this.#clamp(rec.balance),
                lastSeen: rec.lastSeen || 0
            }));
        }
        const out = [];
        // Phase 7.5 (v0.22.0) (EC4) CRITICAL FIX: Previously had
        // `if (!Database.hasCollection(shardName)) continue;` which SKIPPED
        // shards that hadn't been loaded into memory yet. A shard containing
        // players who hadn't logged in since sharding was enabled was on
        // disk but not in memory — those players were INVISIBLE in the
        // leaderboard.
        //
        // The fix: remove the `hasCollection` guard. `Database.collection(name, ...)`
        // will load the shard from disk on first access. This is slightly
        // more expensive (up to 16 shard loads on first call) but the result
        // is cached by `top()`'s TTL cache, so subsequent calls are free.
        for (const shardName of MoneyShard.allCollections()) {
            if (shardName === COLLECTION) continue;  // skip base (meta only)
            const shard = Database.collection(shardName, DEFAULT_MONEY_DB, { validate: validateMoneyData });
            for (const rec of Object.values(shard.players || {})) {
                out.push({
                    id: rec.id,
                    name: rec.name || "Unknown",
                    balance: this.#clamp(rec.balance),
                    lastSeen: rec.lastSeen || 0
                });
            }
        }
        return out;
    }

    static top(limit = 100) {
        const now = Date.now();
        const CACHE_TTL = MC.TOP_CACHE_TTL_MS || 30_000;
        if (this.#topCache.data && now - this.#topCache.time < CACHE_TTL) return this.#topCache.data.slice(0, limit);
        const list = this.getAllBalances().sort((a, b) => b.balance - a.balance);
        this.#topCache = { data: list, time: now };
        // Phase 7.7 (v1.0.0) (P2): Build a rank index so rankOf() is O(1).
        this.#rankIndex = new Map();
        for (let i = 0; i < list.length; i++) this.#rankIndex.set(list[i].id, i + 1);
        return list.slice(0, limit);
    }

    static rankOf(player) {
        // Phase 7.7 (v1.0.0) (P2): O(1) lookup via #rankIndex instead of
        // O(N) linear scan of top(10000). The index is built when top()
        // cache is populated. If the cache is empty, top(1) populates it.
        if (!player?.id) return null;
        if (!this.#rankIndex) this.top(1);  // ensure populated
        return this.#rankIndex?.get(player.id) ?? null;
    }

    static format(cents) { return MoneyUtils.formatCents(cents); }

    /**
     * Phase 5 Deep Fix: Expose cache statistics for HealthCheckUI.
     * Private fields cannot be read from outside the class; this public
     * method provides a safe, read-only snapshot of cache state.
     */
    static onDatabaseRestored(event = {}) {
        const restored = event.restored || [];
        if (restored.length && !restored.some(n => n === COLLECTION || String(n).startsWith(`${COLLECTION}_shard_`))) return;
        MoneyShard.refreshRouting();
        this.#invalidate();
        this.#shardCache.clear();
        this.refreshOnlinePlayers();
        Logger.info("Money", "Database restore detected — caches cleared and online scoreboards refreshed", { restored });
    }

    static getCacheStats() {
        return {
            balanceCacheSize: this.#balanceCache.size,
            topCacheValid: this.#topCache.data !== null,
            topCacheAgeMs: this.#topCache.data ? Date.now() - this.#topCache.time : 0
        };
    }

    static #writeScoreBalance(player, totalCents) {
        const { dollarObj, centObj } = this.ensureObjectives();
        const dollars = Math.floor(totalCents / 100);
        const cents = totalCents % 100;
        this.#setScore(dollarObj, player, dollars);
        this.#setScore(centObj, player, cents);
    }

    /**
     * Phase 7.6 (v0.23.0) (S2): Lightweight read-path touch.
     *
     * Only updates `lastSeen` (and name, in case of rename) if the existing
     * record's lastSeen is stale by more than 60 seconds. This avoids marking
     * the collection dirty on every getBalance call, which previously caused
     * excessive DB saves on busy servers.
     *
     * If no record exists yet, creates one (this does mark dirty, but only
     * once per player per session).
     */
    static #touchLastSeen(player, balance, existing = null) {
        const db = this.dbFor(player.id);
        const now = Date.now();
        const rec = existing || db.players[player.id];
        if (!rec) {
            // First-time create — write a full record.
            db.players[player.id] = {
                id: player.id,
                name: player.name,
                balance: this.#clamp(balance),
                firstSeen: now,
                lastSeen: now,
                updatedAt: now
            };
            {
                const previousCount = Math.max(0, Math.floor(Number(db.stats.totalKnownPlayers) || 0));
                db.stats.totalKnownPlayers = previousCount ? previousCount + 1 : Object.keys(db.players).length;
            }
            db.stats.lastUpdated = now;
            return;
        }
        // Only update lastSeen if stale by >60s. This bounds DB writes to
        // once per minute per player, even if getBalance is called every tick.
        if (now - (rec.lastSeen || 0) > 60_000) {
            rec.lastSeen = now;
            rec.name = player.name;  // keep name fresh in case of rename
            db.stats.lastUpdated = now;
        }
    }

    static #readScoreBalance(player) {
        const { dollarObj, centObj } = this.ensureObjectives();
        try {
            const d = this.#getScore(dollarObj, player);
            const c = this.#getScore(centObj, player);
            return this.#clamp(d * 100 + c);
        } catch (error) {
            Logger.debug("Money", `Scoreboard balance read failed for ${player?.name || "unknown"}`, error);
            return 0;
        }
    }

    static #initialBalanceFor(player) {
        const scoreBalance = this.#readScoreBalance(player);
        if (scoreBalance > 0) return scoreBalance;
        return this.#clamp(MC.STARTING_BALANCE_CENTS || 0);
    }

    static #writeBalanceRecord(data, player, balance, existing = null) {
        const now = Date.now();
        const alreadyKnown = !!(existing || data.players[player.id]);
        const rec = existing || data.players[player.id] || {};
        const out = {
            id: player.id,
            name: player.name,
            balance: this.#clamp(balance),
            firstSeen: rec.firstSeen || now,
            lastSeen: now,
            updatedAt: now
        };
        data.players[player.id] = out;
        data.stats = data.stats || {};
        const previousCount = Math.max(0, Math.floor(Number(data.stats.totalKnownPlayers) || 0));
        data.stats.totalKnownPlayers = alreadyKnown ? (previousCount || Object.keys(data.players || {}).length) : previousCount + 1;
        data.stats.lastUpdated = now;
        return out;
    }

    static #afterBalanceWrite(player, balance) {
        const normalized = this.#clamp(balance);
        this.#writeScoreBalance(player, normalized);
        this.#invalidate(player.id);
    }

    static #invalidate(playerId = null) {
        if (playerId) this.#balanceCache.delete(playerId);
        else this.#balanceCache.clear();
        this.#topCache = { data: null, time: 0 };
    }

    static #clamp(v) { return Math.max(0, Math.min(MAX_MONEY, Math.floor(Number(v) || 0))); }

    static #getScore(obj, player) {
        try { return obj && player.scoreboardIdentity ? (obj.getScore(player.scoreboardIdentity) ?? 0) : 0; } catch { return 0; }
    }

    static #setScore(obj, player, value) {
        try { if (obj && player.scoreboardIdentity) obj.setScore(player.scoreboardIdentity, Math.max(0, Math.floor(value))); return true; } catch { return false; }
    }
}

export function getBalanceCents(player) { return MoneyService.getBalance(player); }
export function addMoney(player, cents, reason = "add") { return MoneyService.addMoney(player, cents, reason).balance ?? MoneyService.getBalance(player); }

export default MoneyService;
