// MCity Dashboard V2 - Land Service
// Phase 6: Base/Child Claim Architecture
// Phase 7 (v0.21.0): Migrated to atomic MoneyService.debit + safe rollback with payout fallback.
// Phase 5 (v1.5.5): Land/finance ledger consistency and refund safety.
// Phase 8 (v1.5.8): Lighter claim snapshots for index updates.
// New Changes Phase 5 (v1.8.6): Land tax diagnostics and simulated accrual.
// New Changes Phase 6 (v1.8.7): Claim boundary preview markers before purchase.

import { world, Player } from "@minecraft/server";
import { CONFIG } from "../../config.js";
import { Database } from "../../core/database.js";
import { Logger } from "../../core/logger.js";
import { MoneyUtils } from "../../core/moneyUtils.js";
import { MoneyService } from "../economy/moneyService.js";
import { FinanceService } from "../finance/financeService.js";
import { NotificationService } from "../../dashboard/dashboardNotifications.js";
// Phase 2 Fix: PlayerRegistry imported for evictTenant tenant lookup.
import { PlayerRegistry } from "../../core/playerRegistry.js";
import { DisposableRegistry } from "../../core/disposableRegistry.js";
import { DEFAULT_LAND_DB, validateLandData, sanitizeClaim, sanitizeZone, rebuildLandIndexes, updateSpatialIndexForClaim, updatePlayerIndexForClaim, removeClaimFromIndexes, claimId, chunkCoord, dimShort, claimAtChunk, minDistanceToAnyClaim } from "../../schemas/landSchema.js";
import { AuditService } from "../audit/auditService.js";
import { LandTax } from "./landTax.js";
import { LandShardService } from "./landShardService.js";
// Phase 7.3 (v0.21.2) (LD3): Lazy import LandProtection to call
// invalidateChunkCache after claim mutations. This creates a circular
// import (LandProtection imports LandService), but ES module live
// bindings make this safe: both classes are only referenced inside
// method bodies (runtime), never at module-evaluation time.
import { LandProtection } from "./landProtection.js";
import { RuntimeHandleRegistry } from "../../core/runtimeHandleRegistry.js";
import { BatchTaskService } from "../../core/batchTaskService.js";

const LC = CONFIG.LAND;
const COLLECTION = LC.COLLECTION;
const DAY_MS = 24 * 60 * 60 * 1000;
function now() { return Date.now(); }
function listingId() { return `land_${Date.now()}_${Math.floor(Math.random() * 1000000)}`; }

export class LandService {
    static #initialized = false;
    static #taxCursor = 0;
    static #claimPreviews = new Map(); // playerId -> { claimId, markers, expiresAt }
    static #previewCleanupInterval = null;

    /**
     * Phase 7 (v0.21.0): Safe atomic deduction helper.
     *
     * Uses MoneyService.debit() (which checks balance AND deducts inside one
     * DB transaction — no race-condition clamp exploit). Returns
     * { success, balance? } so callers can branch cleanly.
     */
    static #atomicDebit(player, amount, reason) {
        return MoneyService.debit(player, amount, reason);
    }

    /**
     * Phase 7 (v0.21.0): Safe rollback helper.
     *
     * Refunds `amount` to `player` with reason `reason`. If the refund
     * itself fails (e.g. player disconnected between deduction and rollback),
     * logs CRITICAL, records an audit event, and queues a delayed payout
     * via FinanceService so the player can recover the funds on next login.
     *
     * This closes the silent-money-loss gap that existed in v0.20.2 where
     * rollback return values were discarded.
     */
    static #safeRollback(player, amount, reason, claimIdValue = null, extraMeta = {}) {
        const refund = MoneyService.addMoney(player, amount, reason);
        if (!refund || !refund.success) {
            Logger.error("Land", `CRITICAL: ${reason} failed for player ${player.id} (${player.name}), amount ${amount}c. Money not refunded.`);
            try {
                AuditService.record("land.rollback.failed", "land", player.id, player.name,
                    `CRITICAL rollback failure: ${amount}c lost (${reason})`,
                    { claimId: claimIdValue, amount, reason, ...extraMeta }, "error");
            } catch (e) { Logger.error("Land", "Audit record also failed", e); }
            // Queue a delayed payout so the player can recover the funds later.
            try {
                FinanceService.addPayout(player.id, amount, `Land rollback (delayed): ${reason}`, "land",
                    { claimId: claimIdValue, reason, ...extraMeta });
            } catch (e) { Logger.error("Land", "Fallback payout also failed", e); }
        }
        return refund;
    }

    /**
     * Phase 5 (v1.5.5): Safe positive credit helper for land payouts/refunds.
     *
     * Used when the land DB has already committed an irreversible state change
     * (for example, selling a claim back to the server). If immediate money
     * credit fails, we queue a Finance payout so the player can claim the
     * funds later instead of losing the refund.
     */
    static #safeCredit(player, amount, reason, claimIdValue = null, extraMeta = {}) {
        amount = Math.max(0, Math.floor(Number(amount) || 0));
        if (amount <= 0) return { success: true, balance: MoneyService.getBalance(player), amount: 0 };

        const credit = MoneyService.addMoney(player, amount, reason);
        if (!credit || !credit.success) {
            Logger.error("Land", `CRITICAL: ${reason} credit failed for player ${player.id} (${player.name}), amount ${amount}c. Queueing delayed payout.`);
            try {
                AuditService.record("land.credit.failed", "land", player.id, player.name,
                    `CRITICAL credit failure: ${amount}c (${reason}). Delayed payout queued.`,
                    { claimId: claimIdValue, amount, reason, ...extraMeta }, "error");
            } catch (e) { Logger.error("Land", "Audit record also failed", e); }
            try {
                const payout = FinanceService.addPayout(player.id, amount, `Land credit delayed: ${reason}`, "land",
                    { claimId: claimIdValue, reason, toName: player.name, ...extraMeta });
                if (!payout || !payout.success) {
                    Logger.error("Land", `DOUBLE CRITICAL: delayed payout failed for ${player.id}, ${amount}c. Manual compensation required.`, payout?.message || payout);
                    try {
                        AuditService.record("land.credit.payout_failed", "land", player.id, player.name,
                            `DOUBLE CRITICAL: delayed payout failed for ${amount}c (${reason}). Manual compensation required.`,
                            { claimId: claimIdValue, amount, reason, payoutError: payout?.message || "unknown", ...extraMeta }, "error");
                    } catch {}
                }
            } catch (e) {
                Logger.error("Land", "Fallback payout also failed", e);
            }
        }
        return credit;
    }

    static #claimIndexSnapshot(c) {
        if (!c) return null;
        return {
            id: c.id,
            dimension: c.dimension,
            chunkX: c.chunkX,
            chunkZ: c.chunkZ,
            ownerId: c.ownerId,
            tenantId: c.tenantId,
            isBase: c.isBase,
            trusted: c.trusted ? { ...c.trusted } : {}
        };
    }

    static #invalidateClaimProtectionCache(claimOrDimension, cx = null, cz = null) {
        try {
            if (claimOrDimension && typeof claimOrDimension === "object") {
                LandProtection.invalidateChunkCache(claimOrDimension.dimension, claimOrDimension.chunkX, claimOrDimension.chunkZ);
            } else {
                LandProtection.invalidateChunkCache(claimOrDimension, cx, cz);
            }
        } catch (e) {
            Logger.debug("Land", "chunkCache invalidate failed (non-fatal)", e);
        }
    }

    static #recordFinanceIn(amount, reason, meta = {}) {
        const fin = FinanceService.addTreasury("land", amount, reason, meta);
        if (!fin.success) {
            Logger.warn("Land", `Finance ledger income failed for '${reason}': ${fin.error || "unknown"}`);
            try {
                AuditService.record("land.finance.in_failed", "land", meta.playerId || "", meta.playerName || "system",
                    `Land finance income failed: ${reason}`, { amount, reason, error: fin.error, ...meta }, "warn");
            } catch {}
        }
        return fin;
    }

    static #recordFinanceOut(amount, reason, meta = {}) {
        const fin = FinanceService.withdrawTreasury("land", amount, reason, meta, { allowNegative: true });
        if (!fin.success) {
            Logger.warn("Land", `Finance ledger withdrawal failed for '${reason}': ${fin.error || "unknown"}`);
            try {
                AuditService.record("land.finance.out_failed", "land", meta.playerId || "", meta.playerName || "system",
                    `Land finance withdrawal failed: ${reason}`, { amount, reason, error: fin.error, ...meta }, "warn");
            } catch {}
        }
        return fin;
    }

    static initialize() {
        if (this.#initialized) return;
        this.#initialized = true;
        this.db();
        BatchTaskService.register("land_tax", {
            process: task => this.#processTaxBatch(task),
            afterCommit: effects => this.#afterTaxBatch(effects)
        });
        // Phase 7.3 (v0.21.2) (LD4): Register cleanup for entryPasses on
        // player leave. Previously entryPasses[playerId] was never cleaned
        // up when a player left, causing unbounded memory growth and
        // eventual DP cap blowup on long-running servers.
        DisposableRegistry.registerPlayerCleanup("LandService.entryPasses", (playerId) => {
            try {
                const removedShard = LandShardService.clearPlayerPasses(playerId);
                const db = this.db();
                if (db.entryPasses && db.entryPasses[playerId]) {
                    delete db.entryPasses[playerId];
                    Database.markDirty(COLLECTION);
                }
                Logger.debug("Land", `Cleaned entryPasses for ${playerId} (shard removed ${removedShard})`);
            } catch (e) { Logger.warn("Land", `entryPasses cleanup failed for ${playerId}`, e); }
        });
        this.#previewCleanupInterval = RuntimeHandleRegistry.interval("LandService.previewCleanup", () => this.#cleanupExpiredPreviews(), 100);
        DisposableRegistry.registerShutdownCleanup("LandService.claimPreviews", () => {
            if (this.#previewCleanupInterval) RuntimeHandleRegistry.clear(this.#previewCleanupInterval);
            for (const pid of [...this.#claimPreviews.keys()]) this.clearClaimPreview(pid);
            this.#previewCleanupInterval = null;
            this.#initialized = false;
        });
        DisposableRegistry.registerPlayerCleanup("LandService.claimPreview", (playerId) => this.clearClaimPreview(playerId));
        Logger.startup("Land", "Land service initialized (Phase 7.3 v0.21.2 Architecture)");
    }

    static db() { return Database.collection(COLLECTION, DEFAULT_LAND_DB, { validate: validateLandData }); }

    static previewCurrentChunk(player) {
        const v = this.validateClaimable(player);
        if (!v.ok) return { success: false, message: `§c${v.reason}`, validation: v };
        this.clearClaimPreview(player.id);
        const duration = Math.max(5000, Math.floor(Number(LC.CLAIM_PREVIEW_DURATION_MS) || 60000));
        const markerType = LC.CLAIM_PREVIEW_MARKER_BLOCK || "minecraft:white_wool";
        const dim = player.dimension;
        const minX = v.pc.cx * 16, maxX = minX + 15;
        const minZ = v.pc.cz * 16, maxZ = minZ + 15;
        const baseY = Math.floor(player.location.y);
        const corners = [
            { x: minX, z: minZ }, { x: maxX, z: minZ },
            { x: minX, z: maxZ }, { x: maxX, z: maxZ }
        ];
        const markers = [];
        for (const corner of corners) {
            const placed = this.#placePreviewMarker(dim, corner.x, baseY, corner.z, markerType);
            if (placed) markers.push(placed);
        }
        const preview = { playerId: player.id, claimId: v.pc.id, markers, expiresAt: Date.now() + duration, markerType };
        this.#claimPreviews.set(player.id, preview);
        return { success: true, validation: v, preview, markers: markers.length, expiresAt: preview.expiresAt, durationMs: duration };
    }

    static clearClaimPreview(playerId) {
        const preview = this.#claimPreviews.get(playerId);
        if (!preview) return 0;
        let removed = 0;
        for (const m of preview.markers || []) {
            try {
                const dim = world.getDimension(m.dimensionId);
                const block = dim?.getBlock({ x: m.x, y: m.y, z: m.z });
                if (block?.typeId === m.typeId) { block.setType("minecraft:air"); removed++; }
            } catch {}
        }
        this.#claimPreviews.delete(playerId);
        return removed;
    }

    static isClaimPreviewMarker(block) {
        if (!block?.location || !block.dimension) return false;
        const key = this.#markerKey(block.dimension.id, block.location.x, block.location.y, block.location.z);
        for (const preview of this.#claimPreviews.values()) {
            if ((preview.markers || []).some(m => m.key === key && block.typeId === m.typeId)) return true;
        }
        return false;
    }

    static removeClaimPreviewMarker(block) {
        if (!this.isClaimPreviewMarker(block)) return false;
        try { block.setType("minecraft:air"); } catch {}
        return true;
    }

    static #placePreviewMarker(dimension, x, baseY, z, markerType) {
        for (let dy = 0; dy <= 4; dy++) {
            const y = baseY + dy;
            try {
                const block = dimension.getBlock({ x, y, z });
                if (!block || block.typeId !== "minecraft:air") continue;
                block.setType(markerType);
                return { dimensionId: dimension.id, x, y, z, typeId: markerType, key: this.#markerKey(dimension.id, x, y, z) };
            } catch {}
        }
        return null;
    }

    static #markerKey(dimensionId, x, y, z) {
        return `${String(dimensionId || "minecraft:overworld")}:${Math.floor(x)}:${Math.floor(y)}:${Math.floor(z)}`;
    }

    static #cleanupExpiredPreviews() {
        const t = Date.now();
        for (const [pid, preview] of [...this.#claimPreviews.entries()]) {
            if ((preview.expiresAt || 0) <= t) this.clearClaimPreview(pid);
        }
    }

    static playerChunk(player) {
        const l = player.location;
        const cx = chunkCoord(l.x), cz = chunkCoord(l.z);
        return { cx, cz, y: Math.floor(l.y), dimensionId: player.dimension.id, id: claimId(player.dimension.id, cx, cz) };
    }

    static zonesForChunk(dimensionId, cx, cz) {
        const dim = String(dimensionId || "minecraft:overworld");
        return Object.values(this.db().zones || {})
            .filter(z => z.dimension === dim && cx >= z.minChunkX && cx <= z.maxChunkX && cz >= z.minChunkZ && cz <= z.maxChunkZ)
            .sort((a, b) => (b.priority || 0) - (a.priority || 0) || (b.createdAt || 0) - (a.createdAt || 0));
    }

    static zoneForChunk(dimensionId, cx, cz) { return this.zonesForChunk(dimensionId, cx, cz)[0] || null; }
    static zoneForPlayer(player) { const pc = this.playerChunk(player); return this.zoneForChunk(pc.dimensionId, pc.cx, pc.cz); }

    static getClaimAt(target) {
        const loc = target?.location;
        if (!loc) return null;
        const dim = target.dimension?.id || target.dimensionId || "minecraft:overworld";
        const cx = chunkCoord(loc.x);
        const cz = chunkCoord(loc.z);
        // Phase 2 Performance: O(1) spatial index lookup instead of constructing
        // a string key and looking up in db.claims (which still works, but
        // spatialIndex is faster and supports neighborhood queries).
        const db = this.db();
        const id = claimAtChunk(db.spatialIndex, dim, cx, cz);
        if (!id) return null;
        const c = db.claims[id];
        if (!c) return null;
        const y = Math.floor(loc.y);
        return y >= c.minY && y <= c.maxY ? c : null;
    }

    /**
     * Phase 2 Performance: Minimum Manhattan distance (in chunks) from a
     * player to any claim. Uses the spatial index ring search — O(1) for
     * the common case where the player is far from any claim (returns as
     * soon as the search ring finds one).
     * 
     * Used by LandProtection's master poller to set per-player polling
     * frequency without scanning every claim.
     */
    static minDistanceToClaim(player) {
        if (!player?.location) return Infinity;
        const dim = player.dimension?.id || "minecraft:overworld";
        const cx = chunkCoord(player.location.x);
        const cz = chunkCoord(player.location.z);
        const db = this.db();
        return minDistanceToAnyClaim(db.spatialIndex, dim, cx, cz);
    }

    static currentClaim(player) { return this.getClaimAt(player); }

    static canManage(claim, player) {
        if (!claim || !(player instanceof Player)) return false;
        if (player.hasTag?.(CONFIG.TAGS.ADMIN) || player.hasTag?.(CONFIG.TAGS.LAND_ADMIN) || player.hasTag?.(CONFIG.TAGS.OWNER)) return true;
        if (claim.ownerId === player.id) return true;
        const role = claim.trusted?.[player.id]?.role;
        return !!(role && LC.ROLES[role]?.manage);
    }

    static roleOf(claim, player) { return claim?.trusted?.[player.id]?.role || null; }
    static isTenant(claim, player) { return claim?.tenantId === player.id && (claim.rentExpiresAt || 0) > now(); }
    static isTrusted(claim, player) { return !!this.roleOf(claim, player); }

    static checkPermission(claim, player, action) {
        if (!claim) return true;
        if (this.canManage(claim, player)) return true;
        if (claim.ownerId === player.id) return true;
        const role = this.roleOf(claim, player);
        const perms = role ? LC.ROLES[role] : null;
        if ((action === "break" || action === "place") && perms?.build) return true;
        if (action === "interact" && perms?.interact) return true;
        if (action === "containers" && perms?.containers) return true;
        if (this.isTenant(claim, player) && ["break", "place", "interact"].includes(action)) return true;
        const mode = claim.flags?.[action] || "owner_trusted";
        if (action === "entry" && mode === "taxed") return this.hasEntryPass(player, claim);
        if (mode === "public") return true;
        if (mode === "trusted" || mode === "owner_trusted") return this.isTrusted(claim, player);
        return false;
    }

    static validateClaimable(player) {
        const pc = this.playerChunk(player);
        if (pc.dimensionId !== "minecraft:overworld") return { ok: false, reason: "Only the Overworld can be claimed." };
        if (pc.y < LC.MIN_CLAIM_Y || pc.y > LC.MAX_CLAIM_Y) return { ok: false, reason: `Stand between Y ${LC.MIN_CLAIM_Y}-${LC.MAX_CLAIM_Y} to claim.` };
        
        const db = this.db();
        const zone = this.zoneForChunk(pc.dimensionId, pc.cx, pc.cz);
        if (zone && zone.claimAllowed === false) return { ok: false, reason: `Claiming is disabled in zone '${zone.name}'.` };
        if (zone && zone.allowBuy === false) return { ok: false, reason: `Buying is disabled in zone '${zone.name}'.` };
        if (db.claims[pc.id]) return { ok: false, reason: "This chunk is already claimed." };
        
        try {
            const spawn = world.getDefaultSpawnLocation?.() || { x: 0, z: 0 };
            const scx = chunkCoord(spawn.x || 0), scz = chunkCoord(spawn.z || 0);
            if (Math.abs(pc.cx - scx) <= LC.SPAWN_PROTECTION_RADIUS_CHUNKS && Math.abs(pc.cz - scz) <= LC.SPAWN_PROTECTION_RADIUS_CHUNKS) return { ok: false, reason: "This chunk is inside spawn protection." };
        } catch (error) {
            Logger.debug("Land", `Spawn protection check failed for ${player.name}`, error);
        }
        
        const max = player.hasTag?.(LC.VIP_TAG) ? LC.MAX_CLAIMS_VIP : LC.MAX_CLAIMS_DEFAULT;
        const owned = db.playerIndex[player.id]?.owned?.length || 0;
        if (owned >= max) return { ok: false, reason: `Claim limit reached (${owned}/${max}).` };

        // Phase 6: Base/Child Adjacency Check
        let isBase = false;
        if (owned === 0) {
            isBase = true; // First claim is always base
        } else {
            let baseId = db.playerIndex[player.id]?.baseClaimId;
            if (!baseId && owned > 0) {
                baseId = db.playerIndex[player.id].owned[0];
                db.claims[baseId].isBase = true;
                db.playerIndex[player.id].baseClaimId = baseId;
            }
            if (!baseId) return { ok: false, reason: "Error finding your Base Chunk. Ask admin for repair." };
            
            const baseClaim = db.claims[baseId];
            if (!baseClaim) return { ok: false, reason: "Base Chunk is missing." };

            // Check if within 3x3 grid (Math.abs diff <= 1)
            const dx = Math.abs(pc.cx - baseClaim.chunkX);
            const dz = Math.abs(pc.cz - baseClaim.chunkZ);
            
            if (dx > 1 || dz > 1) {
                return { ok: false, reason: "You can only claim chunks directly attached to your Base Chunk (3x3 area)." };
            }
        }

        return { ok: true, pc, zone, isBase, price: Math.max(0, Math.floor(LC.BASE_PRICE_CENTS * (zone?.priceMultiplier ?? 1))) };
    }

    static buyCurrentChunk(player) {
        const v = this.validateClaimable(player);
        if (!v.ok) return { success: false, message: `§c${v.reason}` };
        if (MoneyService.getBalance(player) < v.price) return { success: false, message: `§cNeed ${MoneyUtils.formatCents(v.price)} to buy this chunk.` };
        
        // Phase 7 (v0.21.0): Atomic debit replaces addMoney(-price).
        const deduction = this.#atomicDebit(player, v.price, "land_buy");
        if (!deduction.success) {
            return { success: false, message: `§c${deduction.message || "Failed to deduct balance."}` };
        }
        const tx = Database.transaction(COLLECTION, data => {
            if (data.claims[v.pc.id]) throw new Error("Claim already exists.");
            
            const c = sanitizeClaim({
                id: v.pc.id,
                dimension: v.pc.dimensionId,
                chunkX: v.pc.cx,
                chunkZ: v.pc.cz,
                isBase: v.isBase,
                ownerId: player.id,
                ownerName: player.name,
                minY: LC.MIN_CLAIM_Y,
                maxY: LC.MAX_CLAIM_Y,
                flags: LC.DEFAULT_FLAGS,
                createdAt: now(),
                lastTaxAt: now()
            });
            
            data.claims[c.id] = c;
            data.treasury.balance = (data.treasury.balance || 0) + v.price;
            data.treasury.totalSales = (data.treasury.totalSales || 0) + v.price;
            data.stats.totalClaimsCreated = (data.stats.totalClaimsCreated || 0) + 1;
            data.stats.lastUpdated = now();
            
            // Phase 2 Performance: incremental index update instead of full rebuild
            updateSpatialIndexForClaim(data, c);
            updatePlayerIndexForClaim(data, c);
            return c;
        });
        
        if (!tx.success) { 
            // Phase 7 (v0.21.0): Safe rollback with payout fallback.
            this.#safeRollback(player, v.price, "land_buy_rollback", tx.result?.id, { price: v.price });
            return { success: false, message: `§cClaim failed: ${tx.error}` }; 
        }
        
        this.#recordFinanceIn(v.price, "Land claim purchase", { playerId: player.id, playerName: player.name, claimId: tx.result.id });
        // Phase 7.3 (v0.21.2) (LD3): Invalidate chunkCache so protection
        // events see the new claim immediately (was cached as null).
        this.#invalidateClaimProtectionCache(v.pc.dimensionId, v.pc.cx, v.pc.cz);
        AuditService.record("land.claim.buy", "land", player.id, player.name, `Bought claim ${tx.result.id}`, { claimId: tx.result.id, price: v.price });
        
        const typeStr = v.isBase ? "§bBase Chunk" : "§7Child Chunk";
        return { success: true, claim: tx.result, message: `§aClaim purchased: §f${tx.result.id} (${typeStr}§a) §7for §e${MoneyUtils.formatCents(v.price)}` };
    }

    static payTax(player, claimIdValue, options = {}) {
        const db = this.db(); const claim = db.claims[claimIdValue];
        if (!claim) return { success: false, message: "§cClaim not found." };
        if (!this.canManage(claim, player)) return { success: false, message: "§cYou cannot manage this claim." };
        const debt = Math.max(0, claim.taxDebt || 0);
        if (debt <= 0) return { success: true, paid: 0, message: "§aNo tax due." };
        if (options.expectedDebt !== undefined && Math.floor(Number(options.expectedDebt) || 0) !== debt) {
            return { success: false, stale: true, message: "§cTax amount changed. Please reopen the sale form." };
        }
        if (MoneyService.getBalance(player) < debt) return { success: false, message: `§cNeed ${MoneyUtils.formatCents(debt)}.` };

        // Phase 7 (v0.21.0): Atomic debit replaces addMoney(-debt).
        const deduction = this.#atomicDebit(player, debt, "land_tax");
        if (!deduction.success) {
            return { success: false, message: `§c${deduction.message || "Failed to deduct balance."}` };
        }

        const tx = Database.transaction(COLLECTION, data => {
            const c = data.claims[claimIdValue]; if (!c) throw new Error("Claim missing.");
            if (options.expectedDebt !== undefined && Math.max(0, c.taxDebt || 0) !== debt) throw new Error("Tax amount changed before payment.");
            c.taxDebt = 0; c.updatedAt = now();
            data.treasury.balance = (data.treasury.balance || 0) + debt;
            data.treasury.totalTaxCollected = (data.treasury.totalTaxCollected || 0) + debt;
            data.stats.lastUpdated = now();
        });

        if (!tx.success) {
            // Phase 7 (v0.21.0): Safe rollback with payout fallback.
            this.#safeRollback(player, debt, "land_tax_rollback", claimIdValue, { debt });
            return { success: false, message: `§cTax payment failed: ${tx.error}` };
        }

        this.#recordFinanceIn(debt, "Land tax payment", { playerId: player.id, playerName: player.name, claimId: claimIdValue });
        AuditService.record("land.tax.pay", "land", player.id, player.name, `Paid tax for ${claimIdValue}`, { claimId: claimIdValue, amount: debt });
        return { success: true, paid: debt, message: `§aTax paid: §e${MoneyUtils.formatCents(debt)}` };
    }

    static sellToServer(player, claimIdValue) {
        const claim = this.db().claims[claimIdValue];
        if (!claim) return { success: false, message: "§cClaim not found." };
        if (claim.ownerId !== player.id) return { success: false, message: "§cOnly owner can sell this claim." };
        if ((claim.taxDebt || 0) > 0) return { success: false, message: "§cPay tax debt before selling this claim." };
        
        // Prevent selling Base Chunk if Child Chunks exist
        if (claim.isBase) {
            const owned = this.db().playerIndex[player.id]?.owned || [];
            if (owned.length > 1) {
                return { success: false, message: "§cYou must sell all Child Chunks before selling your Base Chunk." };
            }
        }

        const refund = Math.floor(LC.BASE_PRICE_CENTS * LC.SELL_REFUND_RATIO);
        const tx = Database.transaction(COLLECTION, data => {
            const c = data.claims[claimIdValue]; if (!c) throw new Error("Claim missing.");
            if (c.listingId) delete data.market.listings[c.listingId];
            // Phase 2 Performance: remove from indexes before deleting claim
            removeClaimFromIndexes(data, c);
            delete data.claims[claimIdValue];
            data.treasury.balance = Math.max(0, (data.treasury.balance || 0) - refund);
            data.stats.totalClaimsDeleted = (data.stats.totalClaimsDeleted || 0) + 1;
            data.stats.lastUpdated = now();
        });
        if (!tx.success) return { success: false, message: `§cSell failed: ${tx.error}` };
        this.#safeCredit(player, refund, "land_sell_refund", claimIdValue, { refund });
        this.#recordFinanceOut(refund, "Land claim sold back", { playerId: player.id, playerName: player.name, claimId: claimIdValue, refund });
        // Phase 7.3 (v0.21.2) (LD3): Invalidate chunkCache so protection
        // events see the claim is gone immediately.
        this.#invalidateClaimProtectionCache(claim);
        AuditService.record("land.claim.sell", "land", player.id, player.name, `Sold claim ${claimIdValue} to server`, { claimId: claimIdValue, refund });
        return { success: true, message: `§aClaim sold to server. Refund: §e${MoneyUtils.formatCents(refund)}` };
    }

    static setTrusted(player, claimIdValue, targetPlayerName, targetPlayerId, role) {
        const claim = this.db().claims[claimIdValue]; if (!claim) return { success: false, message: "§cClaim not found." };
        if (!this.canManage(claim, player)) return { success: false, message: "§cNo permission." };
        if (claim.ownerId === targetPlayerId) return { success: false, message: "§cCannot change owner's role." };
        const tx = Database.transaction(COLLECTION, data => {
            const c = data.claims[claimIdValue]; if (!c) throw new Error("Claim missing.");
            // Phase 5 Fix: Shallow snapshot of only the fields that
            // updatePlayerIndexForClaim reads, instead of a full deep clone.
            //
            // PROBLEM (pre-Phase 5):
            //   `const oldClaim = JSON.parse(JSON.stringify(c))` did a FULL
            //   deep clone of the claim on every setTrusted call. For claims
            //   with large `trusted` maps or long `deliveries` arrays, this
            //   was expensive (O(total claim size) allocation + serialization).
            //
            // SOLUTION (Phase 5):
            //   updatePlayerIndexForClaim only reads `ownerId`, `tenantId`,
            //   `trusted`, and `id` from oldClaim. We create a shallow
            //   snapshot of just these fields. The `trusted` object is
            //   shallow-copied (one level) so mutations to the live `c.trusted`
            //   don't affect the snapshot. This reduces the clone from
            //   O(total claim size) to O(trusted map size), which is
            //   typically much smaller.
            const oldClaim = {
                id: c.id,
                ownerId: c.ownerId,
                tenantId: c.tenantId,
                isBase: c.isBase,
                trusted: c.trusted ? { ...c.trusted } : {}
            };
            if (!c.trusted) c.trusted = {};
            if (role) c.trusted[targetPlayerId] = { role, name: targetPlayerName }; else delete c.trusted[targetPlayerId];
            c.updatedAt = now();
            updatePlayerIndexForClaim(data, c, oldClaim);
        });
        if (tx.success) AuditService.record("land.trusted.update", "land", player.id, player.name, `Updated trusted ${targetPlayerName} to ${role || "none"} on ${claimIdValue}`, { claimId: claimIdValue, targetId: targetPlayerId, role });
        return tx.success ? { success: true, message: `§aRole updated for ${targetPlayerName}.` } : { success: false, message: `§cUpdate failed: ${tx.error}` };
    }

    static updateFlags(player, claimIdValue, updates) {
        const claim = this.db().claims[claimIdValue]; if (!claim) return { success: false, message: "§cClaim not found." };
        if (!this.canManage(claim, player)) return { success: false, message: "§cNo permission." };
        const tx = Database.transaction(COLLECTION, data => { const c = data.claims[claimIdValue]; if (!c) throw new Error("Claim missing."); c.flags = { ...c.flags, ...updates }; c.updatedAt = now(); });
        if (tx.success) AuditService.record("land.flags.update", "land", player.id, player.name, `Updated flags on ${claimIdValue}`, { claimId: claimIdValue, updates });
        return tx.success ? { success: true, message: "§aFlags updated." } : { success: false, message: `§cUpdate failed: ${tx.error}` };
    }

    /**
     * Phase 7.3 (v0.21.2) (LD1): Set rent terms for a claim.
     *
     * Previously, the rentSettings UI tried to update `rentEnabled` and
     * `rentPricePerDay` via a broken fire-and-forget Promise, but:
     *   1. `rentLand` checks `listedForRent` (which was never set).
     *   2. The schema stored `rentPricePerDay` but `rentLand` read
     *      `rentPricePerDayCents` — field name mismatch.
     *   3. The Promise was never awaited, so the success message lied.
     *
     * This method fixes all three: sets `listedForRent`, uses
     * `rentPricePerDayCents`, and is a synchronous transaction with a
     * verified return value.
     */
    static setRentTerms(player, claimIdValue, enabled, priceCents) {
        const claim = this.db().claims[claimIdValue];
        if (!claim) return { success: false, message: "§cClaim not found." };
        if (claim.ownerId !== player.id) return { success: false, message: "§cOnly the owner can set rent terms." };
        const price = Math.max(0, Math.floor(Number(priceCents) || 0));
        const tx = Database.transaction(COLLECTION, data => {
            const c = data.claims[claimIdValue];
            if (!c) throw new Error("Claim missing.");
            c.listedForRent = !!enabled;
            c.rentPricePerDayCents = price;
            // Keep legacy fields in sync for backward compat.
            c.rentEnabled = !!enabled;
            // rentPricePerDayCents is the sole canonical write field.
            c.updatedAt = now();
        });
        if (tx.success) {
            AuditService.record("land.rent.settings", "land", player.id, player.name,
                `Rent ${enabled ? "enabled" : "disabled"} on ${claimIdValue} at ${MoneyUtils.formatCents(price)}/day`,
                { claimId: claimIdValue, enabled: !!enabled, pricePerDayCents: price });
        }
        return tx.success
            ? { success: true, message: `§aRent ${enabled ? "enabled" : "disabled"} at §e${MoneyUtils.formatCents(price)}/day§a.` }
            : { success: false, message: `§cFailed: ${tx.error}` };
    }

    static listForSale(player, claimIdValue, price) {
        const claim = this.db().claims[claimIdValue]; if (!claim) return { success: false, message: "§cClaim not found." };
        if (claim.ownerId !== player.id) return { success: false, message: "§cOnly owner can list." };
        if (claim.taxDebt > 0) return { success: false, message: "§cPay tax debt before listing." };
        
        // Prevent listing base chunk if children exist
        if (claim.isBase) {
            const owned = this.db().playerIndex[player.id]?.owned || [];
            if (owned.length > 1) return { success: false, message: "§cYou must sell your Child Chunks before listing the Base Chunk." };
        }

        const tx = Database.transaction(COLLECTION, data => {
            const c = data.claims[claimIdValue]; if (c.listingId) delete data.market.listings[c.listingId];
            const lid = listingId(); c.listedForSale = true; c.salePriceCents = price; c.listingId = lid;
            // Phase 7.3 (v0.21.2) (LD2): Also persist the listing record so
            // buyPlayerLand can read the authoritative price from it inside
            // the transaction, surviving schema reloads.
            data.market.listings[lid] = { id: lid, claimId: c.id, sellerId: c.ownerId, sellerName: c.ownerName, price: price, createdAt: now() }; c.updatedAt = now();
        });
        if (tx.success) AuditService.record("land.market.list", "land", player.id, player.name, `Listed ${claimIdValue} for ${price}`, { claimId: claimIdValue, price });
        return tx.success ? { success: true, message: "§aClaim listed for sale." } : { success: false, message: `§cListing failed: ${tx.error}` };
    }

    static unlistForSale(player, claimIdValue) {
        const claim = this.db().claims[claimIdValue]; if (!claim) return { success: false, message: "§cClaim not found." };
        if (!this.canManage(claim, player)) return { success: false, message: "§cNo permission." };
        const tx = Database.transaction(COLLECTION, data => { const c = data.claims[claimIdValue]; if (c.listingId) delete data.market.listings[c.listingId]; c.listedForSale = false; c.salePriceCents = 0; c.listingId = null; c.updatedAt = now(); });
        if (tx.success) AuditService.record("land.market.unlist", "land", player.id, player.name, `Unlisted ${claimIdValue}`, { claimId: claimIdValue });
        return tx.success ? { success: true, message: "§aListing removed." } : { success: false, message: `§cUnlist failed: ${tx.error}` };
    }

    static buyPlayerLand(player, claimIdValue) {
        const db = this.db(); const claim = db.claims[claimIdValue];
        if (!claim || !claim.listedForSale) return { success: false, message: "§cClaim not listed." };
        if (claim.ownerId === player.id) return { success: false, message: "§cYou own this." };
        
        // Base chunk enforcement: if buying, it either becomes their base or must attach to their base
        const owned = db.playerIndex[player.id]?.owned || [];
        const maxClaims = player.hasTag?.(LC.VIP_TAG) ? LC.MAX_CLAIMS_VIP : LC.MAX_CLAIMS_DEFAULT;
        if (owned.length >= maxClaims) return { success:false, message:`§cClaim limit reached (${owned.length}/${maxClaims}).` };
        const purchaseZone = this.zoneForChunk(claim.dimension, claim.chunkX, claim.chunkZ);
        if (purchaseZone && purchaseZone.allowBuy === false) return { success:false, message:`§cBuying is disabled in zone '${purchaseZone.name}'.` };
        if (owned.length > 0) {
            const baseId = db.playerIndex[player.id]?.baseClaimId;
            const baseClaim = db.claims[baseId];
            if (baseClaim) {
                const dx = Math.abs(claim.chunkX - baseClaim.chunkX);
                const dz = Math.abs(claim.chunkZ - baseClaim.chunkZ);
                if (dx > 1 || dz > 1) return { success: false, message: "§cThis land is not attached to your Base Chunk." };
            }
        }
        
        // Phase 7.3 (v0.21.2) (LD2): Read the authoritative price from the
        // listing record INSIDE the transaction. Previously, the price was
        // read from `claim.salePriceCents` which was stripped by
        // sanitizeClaim on DB reload — so after a restart, listings were
        // free. Now we read from `data.market.listings[listingId].price`
        // inside the tx, and fall back to `claim.salePriceCents` (now also
        // preserved in the schema) only if the listing record is missing.
        const listingId = claim.listingId;
        const listing = listingId ? db.market.listings[listingId] : null;
        const price = listing ? listing.price : (claim.salePriceCents || 0);
        if (MoneyService.getBalance(player) < price) return { success: false, message: `§cNeed ${MoneyUtils.formatCents(price)}.` };
        // Phase 7 (v0.21.0): Atomic debit replaces addMoney(-price).
        const deduction = this.#atomicDebit(player, price, "land_market_buy");
        if (!deduction.success) {
            return { success: false, message: `§c${deduction.message || "Failed to deduct balance."}` };
        }

        const tx = Database.transaction(COLLECTION, data => {
            const c = data.claims[claimIdValue]; if (!c || !c.listedForSale) throw new Error("Listing changed.");
            // Phase 7.3 (v0.21.2) (LD2): Re-read the price INSIDE the tx from
            // the authoritative listing record. If the listing was modified
            // between our pre-check and this tx, we use the in-tx price.
            const lid = c.listingId;
            const inTxListing = lid ? data.market.listings[lid] : null;
            const inTxPrice = inTxListing ? inTxListing.price : (c.salePriceCents || 0);
            if (inTxPrice !== price) {
                // Price changed between pre-check and tx. We deducted the
                // old price; if the new price is higher, we may not have
                // enough. Throw to abort and let the caller refund.
                throw new Error(`Price changed (was ${price}, now ${inTxPrice}).`);
            }
            // Phase 2 Performance: capture old state for incremental index update
            const oldClaim = this.#claimIndexSnapshot(c);
            if (c.listingId) delete data.market.listings[c.listingId];
            c.listedForSale = false; c.salePriceCents = 0; c.listingId = null;
            
            const prevOwnerId = c.ownerId; const prevOwnerName = c.ownerName;
            c.ownerId = player.id; c.ownerName = player.name; 
            
            // Reassign isBase dynamically based on buyer's state
            const buyerOwned = data.playerIndex[player.id]?.owned?.length || 0;
            c.isBase = buyerOwned === 0;
            
            const tenantId=c.tenantId,tenantName=c.tenantName,rentExpiresAt=c.rentExpiresAt||0,rentRate=c.rentPricePerDayCents||0;
            const tenantRefundCents=tenantId&&rentExpiresAt>now()?Math.max(0,Math.ceil((rentExpiresAt-now())/DAY_MS)*rentRate):0;
            c.trusted = {}; c.tenantId = null; c.tenantName = null; c.rentExpiresAt = 0; c.flags = LC.DEFAULT_FLAGS; c.updatedAt = now();
            c.pendingTenantRefund=tenantRefundCents>0?{id:`land_sale_tenant_refund_${c.id}_${listingId}`,tenantId,tenantName,amount:tenantRefundCents,status:"pending",createdAt:now()}:null;
            data.stats.totalMarketSales = (data.stats.totalMarketSales || 0) + 1;
            updateSpatialIndexForClaim(data, c, oldClaim);
            updatePlayerIndexForClaim(data, c, oldClaim);
            return { prevOwnerId, prevOwnerName, price, tenantId, tenantName, tenantRefundCents };
        });
        if (!tx.success) {
            // Phase 7 (v0.21.0): Safe rollback with payout fallback.
            this.#safeRollback(player, price, "land_market_buy_rollback", claimIdValue, { price });
            return { success: false, message: `§cBuy failed: ${tx.error}` };
        }
        // Phase 7.3 (v0.21.2) (LD3): Invalidate chunkCache for this chunk
        // so protection events see the new owner immediately.
        this.#invalidateClaimProtectionCache(claim);
        FinanceService.addPayout(tx.result.prevOwnerId, tx.result.price, "Land market sale", "land", { fromName: player.name, claimId: claimIdValue, toName: tx.result.prevOwnerName, journalId:`land_sale_${claimIdValue}_${listingId}` });
        if(tx.result.tenantRefundCents>0)FinanceService.addPayout(tx.result.tenantId,tx.result.tenantRefundCents,"Land sale tenant prepaid rent refund","land",{claimId:claimIdValue,toName:tx.result.tenantName,journalId:`land_sale_tenant_refund_${claimIdValue}_${listingId}`});
        NotificationService.create(tx.result.prevOwnerId, { type: "land_sold", source: "land", title: "Land Sold", message: `${player.name} bought ${claimIdValue} for ${MoneyUtils.formatCents(tx.result.price)}.`, action: "payouts" });
        AuditService.record("land.market.buy", "land", player.id, player.name, `Bought ${claimIdValue} from ${tx.result.prevOwnerName}`, { claimId: claimIdValue, price: tx.result.price, prevOwnerId: tx.result.prevOwnerId });
        return { success: true, message: `§aBought claim. Payout pending for previous owner.` };
    }

    static rentLand(player, claimIdValue, days) {
        const claim = this.db().claims[claimIdValue]; if (!claim) return { success: false, message: "§cClaim not found." };
        if (!claim.listedForRent) return { success: false, message: "§cNot available for rent." };
        if (claim.ownerId === player.id) return { success: false, message: "§cYou own this." };
        if (claim.tenantId && claim.tenantId !== player.id && claim.rentExpiresAt > now()) return { success: false, message: "§cAlready rented by someone else." };
        days = Math.max(1, Math.min(30, Math.floor(days || 1)));
        const total = (claim.rentPricePerDayCents || LC.RENT_PRICE_PER_DAY_CENTS) * days;
        if (MoneyService.getBalance(player) < total) return { success: false, message: `§cNeed ${MoneyUtils.formatCents(total)}.` };

        // Phase 7 (v0.21.0): Atomic debit replaces addMoney(-total).
        const deduction = this.#atomicDebit(player, total, "land_rent");
        if (!deduction.success) {
            return { success: false, message: `§c${deduction.message || "Failed to deduct balance."}` };
        }

        const tx = Database.transaction(COLLECTION, data => {
            const c = data.claims[claimIdValue]; if (!c) throw new Error("Claim missing.");
            // Phase 2 Performance: capture old state for incremental index update
            const oldClaim = this.#claimIndexSnapshot(c);
            c.tenantId = player.id; c.tenantName = player.name; c.rentExpiresAt = Math.max(now(), c.rentExpiresAt || 0) + days * DAY_MS; c.updatedAt = now();
            data.stats.totalRentals = (data.stats.totalRentals || 0) + 1;
            updatePlayerIndexForClaim(data, c, oldClaim);
            return { ownerId: c.ownerId, ownerName: c.ownerName, total, rentExpiresAt:c.rentExpiresAt };
        });
        if (!tx.success) {
            // Phase 7 (v0.21.0): Safe rollback with payout fallback.
            this.#safeRollback(player, total, "land_rent_rollback", claimIdValue, { days, total });
            return { success: false, message: `§cRent failed: ${tx.error}` };
        }
        FinanceService.addPayout(tx.result.ownerId, total, "Land rent payment", "land", { fromName: player.name, claimId: claimIdValue, toName: tx.result.ownerName, journalId:`land_rent_${claimIdValue}_${player.id}_${days}_${tx.result.rentExpiresAt||0}` });
        this.#recordFinanceIn(0, "Land rent recorded", { claimId: claimIdValue, amount: total });
        NotificationService.create(tx.result.ownerId, { type: "land_rent", source: "land", title: "Land Rented", message: `${player.name} rented ${claimIdValue} for ${MoneyUtils.formatCents(total)}.`, action: "payouts" });
        AuditService.record("land.rent", "land", player.id, player.name, `Rented claim ${claimIdValue}`, { claimId: claimIdValue, days, total, ownerId: tx.result.ownerId });
        return { success: true, message: `§aRented land for ${days} day(s). Owner payout pending: §e${MoneyUtils.formatCents(total)}` };
    }

    /**
     * Phase 2 Fix: Evict tenant WITH prorated rent refund.
     *
     * PROBLEM (pre-Phase 2):
     *   `evictTenant` simply cleared `tenantId`, `tenantName`, and
     *   `rentExpiresAt` to null/0. A tenant who paid for 30 days of rent
     *   and was evicted on day 1 LOST 29 days of prepaid rent with no
     *   refund, no audit, and no notification. This was a significant
     *   player-experience bug and a potential fund-loss vector if an
     *   admin evicted maliciously or by mistake.
     *
     * SOLUTION (Phase 2):
     *   1. Capture the tenant's rent terms BEFORE clearing them
     *      (tenantId, rentExpiresAt, rentPricePerDayCents).
     *   2. Compute the prorated refund:
     *        remainingMs = rentExpiresAt - now()
     *        remainingDays = floor(remainingMs / DAY_MS)
     *        refundCents = remainingDays * rentPricePerDayCents
     *   3. If refundCents > 0, queue a `FinanceService.addPayout` for the
     *      tenant with reason "land_rent_eviction_refund".
     *   4. Notify the tenant (if online) via chat + Dashboard notification.
     *   5. Record an audit event with full details (tenant, refund amount,
     *      remaining days).
     *   6. The eviction transaction itself is unchanged — we still clear
     *      the tenant fields and update the player index atomically.
     *
     * Edge cases handled:
     *   - Rent already expired (rentExpiresAt <= now): no refund, eviction
     *     proceeds normally.
     *   - rentPricePerDayCents missing: defaults to LC.RENT_PRICE_PER_DAY_CENTS.
     *   - tenantId missing (no tenant to evict): returns success with
     *     "no tenant" message, no refund.
     *   - Refund of less than 1 cent: rounded down to 0, no payout queued.
     */
    static evictTenant(player, claimIdValue) {
        const claim = this.db().claims[claimIdValue]; if (!claim) return { success: false, message: "§cClaim not found." };
        if (!this.canManage(claim, player)) return { success: false, message: "§cNo permission." };

        // Phase 2 Fix: Capture tenant info BEFORE the transaction clears it.
        const tenantId = claim.tenantId;
        const tenantName = claim.tenantName;
        const rentExpiresAt = claim.rentExpiresAt || 0;
        const rentPricePerDayCents = claim.rentPricePerDayCents || LC.RENT_PRICE_PER_DAY_CENTS;

        // If there's no tenant, nothing to evict.
        if (!tenantId) {
            return { success: true, message: "§aNo tenant to evict." };
        }

        // Compute prorated refund.
        const tNow = now();
        let refundCents = 0;
        let remainingDays = 0;
        if (rentExpiresAt > tNow) {
            const remainingMs = rentExpiresAt - tNow;
            remainingDays = Math.floor(remainingMs / DAY_MS);
            refundCents = Math.max(0, remainingDays * rentPricePerDayCents);
        }

        // Perform the eviction transaction (clears tenant fields).
        const tx = Database.transaction(COLLECTION, data => {
            const c = data.claims[claimIdValue]; if (!c) return;
            const oldClaim = this.#claimIndexSnapshot(c);
            c.tenantId = null;
            c.tenantName = null;
            c.rentExpiresAt = 0;
            c.updatedAt = tNow;
            updatePlayerIndexForClaim(data, c, oldClaim);
            return { evicted: true };
        });

        if (!tx.success) {
            return { success: false, message: `§cEviction failed: ${tx.error}` };
        }

        // Phase 2 Fix: Queue prorated refund for the tenant.
        if (refundCents > 0 && tenantId) {
            try {
                FinanceService.addPayout(
                    tenantId,
                    refundCents,
                    `Land rent eviction refund (${remainingDays} day(s) remaining)`,
                    "land",
                    {
                        fromId: player.id,
                        fromName: player.name,
                        toName: tenantName || "Unknown",
                        claimId: claimIdValue,
                        remainingDays,
                        rentPricePerDayCents
                    }
                );
            } catch (refundErr) {
                Logger.error("Land", `evictTenant: refund payout failed for tenant ${tenantId}: ${refundErr?.message || refundErr}. Eviction proceeded but tenant was NOT refunded. Manual intervention required.`);
                // Audit the refund failure so admins can manually compensate.
                try {
                    AuditService.record(
                        "land.rent.evict_refund_failed",
                        "land",
                        tenantId,
                        tenantName || "Unknown",
                        `CRITICAL: Eviction refund payout failed for tenant. Manual compensation needed: ${MoneyUtils.formatCents(refundCents)} (${remainingDays} days).`,
                        { claimId: claimIdValue, tenantId, tenantName, refundCents, remainingDays, error: String(refundErr?.message || refundErr).substring(0, 200) },
                        "error"
                    );
                } catch (e) { /* audit failure should not block */ }
            }

            // Notify the tenant (if online) via chat.
            const tenant = PlayerRegistry.findOnlineById(tenantId);
            if (tenant) {
                try {
                    tenant.sendMessage(CONFIG.PREFIX + `§eYou were evicted from land §f${claimIdValue}§e by §f${player.name}§e. A refund of §a${MoneyUtils.formatCents(refundCents)}§e for §f${remainingDays}§e remaining day(s) has been queued. Claim it from Dashboard → Payouts.`);
                } catch (e) { /* player may be offline */ }
            }

            // Dashboard notification (persists for offline tenants).
            try {
                NotificationService.create(tenantId, {
                    type: "land_eviction",
                    source: "land",
                    title: "Land Eviction — Refund Queued",
                    message: `You were evicted from ${claimIdValue} by ${player.name}. Refund of ${MoneyUtils.formatCents(refundCents)} for ${remainingDays} day(s) queued.`,
                    action: "payouts",
                    meta: { claimId: claimIdValue, refundCents, remainingDays, evictedBy: player.name }
                });
            } catch (e) { /* notification failure should not block */ }
        }

        // Audit the eviction (with refund details).
        AuditService.record(
            "land.rent.evict",
            "land",
            player.id,
            player.name,
            `Evicted tenant ${tenantName || tenantId} from ${claimIdValue}${refundCents > 0 ? ` (refund: ${MoneyUtils.formatCents(refundCents)} for ${remainingDays} day(s))` : " (no refund — rent expired)"}`,
            { claimId: claimIdValue, tenantId, tenantName, refundCents, remainingDays, rentPricePerDayCents },
            refundCents > 0 ? "warn" : "info"
        );

        const refundMsg = refundCents > 0
            ? ` §7Refund of §e${MoneyUtils.formatCents(refundCents)}§7 (${remainingDays} day(s)) queued for tenant.`
            : "";
        return { success: true, message: `§aTenant evicted.${refundMsg}` };
    }

    static hasEntryPass(player, claim) {
        const shardPass = LandShardService.getEntryPass(player.id, claim.id);
        const legacyPass = Number(this.db().entryPasses?.[player.id]?.[claim.id] || 0);
        const pass = Math.max(shardPass || 0, legacyPass || 0);
        return !!(pass && pass > now());
    }

    /**
     * Phase 2 Fix: grantEntryPass now uses Database.transaction.
     *
     * PROBLEM (pre-Phase 2):
     *   `grantEntryPass` wrote directly to `db.entryPasses` (the live proxy
     *   data) and called `Database.markDirty(COLLECTION)`. This was NOT
     *   atomic — the write went through the Proxy's dirty-tracking trap,
     *   but there was no transaction wrapper. If two players triggered
     *   `payEntryTax` for the same claim in the same tick (rare but
     *   possible), both could read the same `entryPasses` state, both
     *   could write, and one write could clobber the other. More
     *   critically, the write was not atomic with the `payEntryTax`
     *   transaction that precedes it — if the tax transaction succeeded
     *   but `grantEntryPass` failed (e.g., DB write error), the player
     *   paid the tax but got no entry pass.
     *
     * SOLUTION (Phase 2):
     *   1. Wrap the entryPasses mutation in `Database.transaction`.
     *   2. Return `{ success, message }` so callers can detect failure
     *      and react (e.g., refund the tax if the pass grant fails).
     *   3. The transaction re-reads `data.entryPasses` inside the callback
     *      to get the latest state (handles concurrent grants).
     *   4. Defensive: handle missing `entryPasses` object, missing player
     *      sub-object, and expired passes (overwrites with new expiry).
     *
     * Callers updated:
     *   - `payEntryTax` (free pass path, line ~720): checks return value,
     *     returns failure message if grant fails.
     *   - `payEntryTax` (paid pass path, line ~744): checks return value,
     *     refunds the tax via `#safeRollback` if grant fails, then returns
     *     failure message. This prevents the player from paying without
     *     receiving the pass.
     */
    static grantEntryPass(player, claim) {
        if (!player || !claim) return { success: false, message: "Invalid player or claim." };
        const expiresAt = now() + LC.ENTRY_TAX_COOLDOWN_MS;
        if (LandShardService.entryPassEnabled()) {
            const res = LandShardService.setEntryPass(player.id, claim.id, expiresAt);
            if (!res.success) {
                Logger.error("Land", `grantEntryPass shard failed for player ${player.id}, claim ${claim.id}: ${res.message}`);
                return { success: false, message: "Failed to grant entry pass." };
            }
            return { success: true, expiresAt };
        }
        const tx = Database.transaction(COLLECTION, data => {
            if (!data.entryPasses) data.entryPasses = {};
            if (!data.entryPasses[player.id]) data.entryPasses[player.id] = {};
            data.entryPasses[player.id][claim.id] = expiresAt;
            return { expiresAt };
        });
        if (!tx.success) {
            Logger.error("Land", `grantEntryPass failed for player ${player.id}, claim ${claim.id}: ${tx.error}`);
            return { success: false, message: "Failed to grant entry pass." };
        }
        return { success: true, expiresAt };
    }

    static payEntryTax(player, claimIdValue) {
        const claim = this.db().claims[claimIdValue]; if (!claim) return { success: false, message: "§cClaim not found." };
        if (claim.ownerId === player.id || this.isTrusted(claim, player) || this.isTenant(claim, player)) return { success: true, message: "§aYou already have access." };
        const fee = Math.max(0, Math.floor(claim.flags?.entryTaxCents ?? LC.DEFAULT_ENTRY_TAX_CENTS));
        // Phase 2 Fix: Check grantEntryPass return value (free pass path).
        if (fee <= 0) {
            const grant = this.grantEntryPass(player, claim);
            if (!grant.success) return { success: false, message: `§c${grant.message || "Failed to grant entry pass."}` };
            return { success: true, message: "§aEntry pass granted." };
        }
        if (MoneyService.getBalance(player) < fee) return { success: false, message: `§cNeed ${MoneyUtils.formatCents(fee)} for entry tax.` };

        // Phase 7 (v0.21.0): Atomic debit replaces addMoney(-fee).
        const deduction = this.#atomicDebit(player, fee, "land_entry_tax");
        if (!deduction.success) {
            return { success: false, message: `§c${deduction.message || "Failed to deduct balance."}` };
        }

        const tx = Database.transaction(COLLECTION, data => {
            const c = data.claims[claimIdValue];
            if (c) {
                c.stats.entryTaxPaid = (c.stats.entryTaxPaid || 0) + fee;
                data.treasury.totalEntryTaxTransferred = (data.treasury.totalEntryTaxTransferred || 0) + fee;
                data.stats.totalEntryTaxPaid = (data.stats.totalEntryTaxPaid || 0) + fee;
            }
        });

        if (!tx.success) {
            // Phase 7 (v0.21.0): Safe rollback with payout fallback. Do NOT grant pass.
            this.#safeRollback(player, fee, "land_entry_tax_rollback", claimIdValue, { fee });
            return { success: false, message: `§cEntry tax failed: ${tx.error}` };
        }

        // Phase 2 Fix: Check grantEntryPass return value (paid pass path).
        // If the pass grant fails after the tax was successfully deducted,
        // we must refund the tax via #safeRollback so the player doesn't
        // pay without receiving the pass.
        const grant = this.grantEntryPass(player, claim);
        if (!grant.success) {
            Logger.error("Land", `payEntryTax: grantEntryPass failed after tax deduction for ${player.id}. Refunding tax of ${fee}c.`);
            this.#safeRollback(player, fee, "land_entry_tax_pass_grant_failed", claimIdValue, { fee, grantError: grant.message });
            AuditService.record(
                "land.entry_tax.grant_failed",
                "land",
                player.id,
                player.name,
                `CRITICAL: Entry pass grant failed after tax payment. Tax refunded via safe rollback. Player: ${player.name}, Claim: ${claimIdValue}, Fee: ${fee}.`,
                { claimId: claimIdValue, fee, grantError: grant.message },
                "error"
            );
            return { success: false, message: `§cEntry tax was paid but pass grant failed. Your ${MoneyUtils.formatCents(fee)} has been refunded.` };
        }

        FinanceService.addPayout(claim.ownerId, fee, "Land entry tax", "land", { fromName: player.name, claimId: claimIdValue, toName: claim.ownerName, journalId:`land_entry_${claimIdValue}_${player.id}_${Math.floor(Date.now()/LC.ENTRY_TAX_COOLDOWN_MS)}` });
        AuditService.record("land.entry_tax.pay", "land", player.id, player.name, `Paid entry tax for ${claimIdValue}`, { claimId: claimIdValue, fee, ownerId: claim.ownerId });
        return { success: true, message: `§aEntry tax paid: §e${MoneyUtils.formatCents(fee)}§a. You may enter for 1 hour.` };
    }

    static createZone(player, params = {}) {
        if (!player.hasTag?.(CONFIG.TAGS.ADMIN) && !player.hasTag?.(CONFIG.TAGS.LAND_ADMIN) && !player.hasTag?.(CONFIG.TAGS.OWNER)) return { success: false, message: "§cNo permission." };
        const pc = this.playerChunk(player); const radius = Math.max(0, Math.min(32, Math.floor(Number(params.radius) || 0)));
        const id = `zone_${Date.now()}_${Math.floor(Math.random()*1000000)}`;
        const zone = sanitizeZone({ id, name: params.name || "Land Zone", type: params.type || "generic", dimension: pc.dimensionId, minChunkX: pc.cx - radius, maxChunkX: pc.cx + radius, minChunkZ: pc.cz - radius, maxChunkZ: pc.cz + radius, claimAllowed: params.claimAllowed, allowBuy: params.allowBuy, allowRent: params.allowRent, priceMultiplier: params.priceMultiplier, rentMultiplier: params.rentMultiplier, priority: params.priority, note: params.note, createdBy: player.name });
        const tx = Database.transaction(COLLECTION, data => { data.zones[zone.id] = zone; data.stats.lastUpdated = now(); return zone; });
        if (tx.success) AuditService.record("land.zone.create", "land", player.id, player.name, `Created zone ${zone.name}`, { zoneId: zone.id });
        return tx.success ? { success: true, zone, message: `§aZone created: §f${zone.name}` } : { success: false, message: `§cZone failed: ${tx.error}` };
    }

    static deleteZone(player, zoneId) {
        if (!player.hasTag?.(CONFIG.TAGS.ADMIN) && !player.hasTag?.(CONFIG.TAGS.LAND_ADMIN) && !player.hasTag?.(CONFIG.TAGS.OWNER)) return { success: false, message: "§cNo permission." };
        const tx = Database.transaction(COLLECTION, data => { if (!data.zones[zoneId]) throw new Error("Zone not found."); delete data.zones[zoneId]; });
        if (tx.success) AuditService.record("land.zone.delete", "land", player.id, player.name, `Deleted zone ${zoneId}`, { zoneId });
        return tx.success ? { success: true, message: "§aZone deleted." } : { success: false, message: `§cDelete failed: ${tx.error}` };
    }

    static integrityCheck(fix = false) {
        const report = { orphanListings: 0, invalidTrusted: 0, expiredEntryPasses: 0, emptyPassPlayers: 0, indexesRebuilt: false, zones: 0, fixed: !!fix };
        const tx = Database.transaction(COLLECTION, data => {
            for (const [lid, l] of Object.entries(data.market.listings || {})) if (!data.claims[l.claimId]) { report.orphanListings++; if (fix) delete data.market.listings[lid]; }
            for (const c of Object.values(data.claims || {})) {
                for (const [pid, t] of Object.entries(c.trusted || {})) if (!t || !t.role || !LC.ROLES[t.role]) { report.invalidTrusted++; if (fix) delete c.trusted[pid]; }
            }
            const tNow = now();
            for (const [pid, passes] of Object.entries(data.entryPasses || {})) {
                for (const [cid, expires] of Object.entries(passes || {})) if (!data.claims[cid] || expires <= tNow) { report.expiredEntryPasses++; if (fix) delete passes[cid]; }
                if (Object.keys(passes || {}).length === 0) { report.emptyPassPlayers++; if (fix) delete data.entryPasses[pid]; }
            }
            report.zones = Object.keys(data.zones || {}).length;
            if (fix) { rebuildLandIndexes(data); report.indexesRebuilt = true; }
            return report;
        });
        return tx.success ? tx.result : { ...report, error: tx.error };
    }

    static ownedClaims(player) { const db = this.db(); return (db.playerIndex[player.id]?.owned || []).map(id => db.claims[id]).filter(Boolean); }
    static trustedClaims(player) { const db = this.db(); return (db.playerIndex[player.id]?.trusted || []).map(id => db.claims[id]).filter(Boolean); }
    static listings() { return Object.values(this.db().market.listings || {}).sort((a,b)=>(b.createdAt||0)-(a.createdAt||0)); }

    static taxInfo(claimOrId) {
        const claim = typeof claimOrId === "string" ? this.db().claims[claimOrId] : claimOrId;
        return LandTax.taxInfo(claim);
    }

    static accrueTaxes(full = false, options = {}) {
        const started = BatchTaskService.start("land_tax", {
            snapshotTime: now(),
            full: !!full,
            options
        }, { dedupeKey: "land_tax" });
        return {
            started: !!started.started,
            taskId: started.task?.id || null,
            message: started.started ? "Tax accrual queued as a persisted batch task." : started.message,
            error: started.success ? undefined : started.message
        };
    }

    static #processTaxBatch(task) {
        let batch = null;
        const tx = Database.transaction(COLLECTION, data => {
            batch = LandTax.processBatch(data, task, 25);
            return batch;
        });
        if (!tx.success) return { error: tx.error, retryable: tx.errorCode === "DB_REVISION_CONFLICT" };
        const previous = task.progress || {};
        const progress = {
            processed: (previous.processed || 0) + (batch.processed || 0),
            changed: (previous.changed || 0) + (batch.changed || 0),
            amount: (previous.amount || 0) + (batch.amount || 0)
        };
        return {
            done: !!batch.done,
            cursor: batch.cursor,
            progress,
            resultPatch: progress,
            effects: batch.effects,
            flushCollections: [COLLECTION]
        };
    }

    static #afterTaxBatch(effects = []) {
        for (const effect of effects) {
            try {
                NotificationService.create(effect.playerId, {
                    type: "land_tax", source: "land", title: "Land Tax Due",
                    message: `${MoneyUtils.formatCents(effect.amount)} tax accrued on ${effect.claimId}.`, action: "land"
                });
            } catch (error) {
                Logger.debug("LandTax", `Deferred tax notification failed for ${effect.playerId}`, error);
            }
        }
    }

    static stats(player = null) {
        const db = this.db();
        const claims = Object.values(db.claims || {});
        const listings = Object.values(db.market.listings || {});
        const taxDebt = claims.reduce((a,c)=>a+(c.taxDebt||0),0);
        if (player) {
            const owned = this.ownedClaims(player);
            return { owned: owned.length, trusted: this.trustedClaims(player).length, rented: (db.playerIndex[player.id]?.rented || []).length, taxDebt: owned.reduce((a,c)=>a+(c.taxDebt||0),0), listings: owned.filter(c=>c.listedForSale).length };
        }
        return { claims: claims.length, listings: listings.length, taxDebt, treasury: db.treasury.balance || 0, zones: Object.keys(db.zones || {}).length };
    }
}

export default LandService;