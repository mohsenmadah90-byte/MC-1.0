// MCity Dashboard V2 - Land Protection Events
// Phase 8: Advanced Protection (Explosions & Pistons)
// Phase 1 Critical Fix: Register shield state cleanup with DisposableRegistry.
// Patch 3 (v1.6.7): database.restored chunk cache invalidation hook.
// New Changes Phase 6 (v1.8.7): claim preview markers break without drops.

import { system, world, Player, ItemStack } from "@minecraft/server";
import { ActionFormData } from "@minecraft/server-ui";
import { CONFIG } from "../../config.js";
import { Logger } from "../../core/logger.js";
import { DisposableRegistry } from "../../core/disposableRegistry.js";
import { PlayerRegistry } from "../../core/playerRegistry.js";
import { EventBus } from "../../core/eventBus.js";
import { LandService } from "./landService.js";
import { BedrockCompat } from "../../core/bedrockCompat.js";
import { SubscriptionRegistry } from "../../core/subscriptionRegistry.js";
import { RuntimeHandleRegistry } from "../../core/runtimeHandleRegistry.js";
import { Database } from "../../core/database.js";

const LC = CONFIG.LAND;
const runtime = { initialized: false, intervals: new Set() };

function deny(player, message) { try { player.sendMessage(CONFIG.PREFIX + "§c" + message); } catch {} }
function isContainerBlock(block) { const id = String(block?.typeId || ""); return id.includes("chest") || id.includes("barrel") || id.includes("furnace") || id.includes("hopper") || id.includes("shulker") || id.includes("dispenser") || id.includes("dropper"); }
function isRedstoneBlock(block) { const id = String(block?.typeId || ""); return id.includes("button") || id.includes("lever") || id.includes("pressure_plate") || id.includes("tripwire") || id.includes("redstone") || id.includes("repeater") || id.includes("comparator") || id.includes("daylight_detector"); }
function isFireItem(itemId) { const id = String(itemId || ""); return id.includes("flint_and_steel") || id.includes("fire_charge"); }
function isLiquidItem(itemId) { const id = String(itemId || ""); return id.includes("water_bucket") || id.includes("lava_bucket") || id.includes("powder_snow_bucket"); }

// Spatial Cache for fast lookup
// Phase 7.7 (v1.0.0): Replaced unbounded Map + 60s bulk-clear with an
// LRU+TTL cache. This bounds memory to MAX_ENTRIES and gives each entry
// a 10-second TTL, so stale nulls (from unclaimed chunks) are evicted
// quickly without waiting for a bulk clear.
const MAX_CHUNK_CACHE_ENTRIES = 4096;
const CHUNK_CACHE_TTL_MS = 10_000;
const chunkCache = new Map();  // key -> {claimId, t}

function chunkCacheGet(key) {
    const v = chunkCache.get(key);
    if (!v) return undefined;
    if (Date.now() - v.t > CHUNK_CACHE_TTL_MS) {
        chunkCache.delete(key);
        return undefined;
    }
    // LRU refresh: delete + re-insert to move to end (most-recently-used).
    chunkCache.delete(key);
    chunkCache.set(key, v);
    return v.claimId;
}

function chunkCacheSet(key, claimId) {
    // Evict oldest if at capacity. Map iteration is insertion-order, so
    // the first entry is the least-recently-used.
    if (chunkCache.size >= MAX_CHUNK_CACHE_ENTRIES) {
        const firstKey = chunkCache.keys().next().value;
        if (firstKey !== undefined) chunkCache.delete(firstKey);
    }
    chunkCache.set(key, { claimId, t: Date.now() });
}

function chunkCacheDelete(key) {
    chunkCache.delete(key);
}

function chunkCacheClear() {
    chunkCache.clear();
}

// Energy Shield State
const shieldState = {
    safeLocations: new Map(), // playerId -> {x,y,z,dimensionId}
    activePollers: new Map(), // playerId -> { intervalId, frequency, distance }
    taxPrompts: new Set(),    // playerId (to prevent prompt spam)
    masterPoller: null
};

// Phase 4 Scalability: AFK Detection
// Tracks the last known position of each player. If a player hasn't moved
// more than AFK_THRESHOLD blocks in AFK_TIMEOUT_MS milliseconds, they are
// considered AFK and their polling frequency is reduced by AFK_FREQ_DIVISOR.
const AFK_TIMEOUT_MS = 30_000;       // 30 seconds of no movement → AFK
const AFK_THRESHOLD_BLOCKS = 0.5;    // less than half a block = no movement
const AFK_FREQ_DIVISOR = 4;          // AFK players polled 4x less often

const afkState = {
    lastPositions: new Map(),  // playerId -> { x, y, z, time }
    afkPlayers: new Set()      // playerId set of currently-AFK players
};

export class LandProtection {
    static initialize() {
        if (runtime.initialized || !LC.ENABLED) return;
        runtime.initialized = true;
        this.#registerProtection();
        EventBus.on("database.restored", event => this.onDatabaseRestored(event));
        Database.registerRefreshHandler("LandProtection", event => this.onDatabaseRestored(event));
        
        runtime.intervals.add(RuntimeHandleRegistry.interval("LandProtection.cacheClear", () => chunkCacheClear(), 1200));
        // Phase 7.7 (v1.0.0): The bulk clear above is now a safety net —
        // the LRU+TTL cache self-evicts stale entries on access, so the
        // 60s clear is less critical but kept for belt-and-suspenders.
        
        // Start the Master Poller for Dynamic Energy Shield
        // Phase 2 Performance: reduced from 200 to 100 ticks for more responsive
        // frequency adjustments when players move toward/away from claims.
        shieldState.masterPoller = RuntimeHandleRegistry.interval("LandProtection.masterPoller", () => this.#masterPollerTick(), 5); 
        runtime.intervals.add(shieldState.masterPoller);

        // Phase 1 Fix: Clean up per-player shield state on leave to prevent memory leak.
        DisposableRegistry.registerPlayerCleanup("LandProtection.shieldState", (playerId) => {
            const p = shieldState.activePollers.get(playerId);
            if (p) {
                RuntimeHandleRegistry.clear(p.intervalId)
                shieldState.activePollers.delete(playerId);
            }
            shieldState.safeLocations.delete(playerId);
            shieldState.taxPrompts.delete(playerId);
            // Phase 4: clear AFK state too.
            afkState.lastPositions.delete(playerId);
            afkState.afkPlayers.delete(playerId);
        });

        Logger.startup("LandProtection", "Land protection & Energy Shield initialized (Phase 8 + Phase 4 AFK)");
    }

    static shutdown() {
        SubscriptionRegistry.disposePrefix("LandProtection.");
        for (const id of runtime.intervals) RuntimeHandleRegistry.clear(id)

        for (const p of shieldState.activePollers.values()) {
            RuntimeHandleRegistry.clear(p.intervalId)
        }

        shieldState.activePollers.clear();
        shieldState.safeLocations.clear();
        shieldState.taxPrompts.clear();

        runtime.intervals.clear(); runtime.initialized = false;
        chunkCacheClear();
    }

    /**
     * Phase 7.3 (v0.21.2) (LD3): Invalidate a single chunk's cache entry.
     *
     * Called by LandService after buyCurrentChunk, sellToServer, and
     * buyPlayerLand. Previously, when a player bought a new claim, the
     * chunk's cached `null` (from a prior unclaimed-state lookup) was
     * NOT invalidated — so for up to 60 seconds (the bulk-clear interval),
     * every protection event in that chunk saw `c === null` and skipped
     * the permission check. This let any other player grief the newly-
     * claimed chunk.
     *
     * Now LandService calls this method after every claim mutation so the
     * next protection event re-queries the spatial index and sees the
     * updated state immediately.
     *
     * @param {string} dimensionId - e.g. "minecraft:overworld"
     * @param {number} cx - chunk X
     * @param {number} cz - chunk Z
     */
    static invalidateChunkCache(dimensionId, cx, cz) {
        const dim = String(dimensionId || "minecraft:overworld").replace("minecraft:", "");
        chunkCacheDelete(`${dim}:${cx}:${cz}`);
    }

    /**
     * Phase 7.3 (v0.21.2) (LD3): Clear the entire chunk cache.
     * Useful for admin "reload all" operations.
     */
    static invalidateAllChunkCache() {
        chunkCacheClear();
    }

    static onDatabaseRestored(event = {}) {
        const restored = event.restored || [];
        if (restored.length && !restored.includes(CONFIG.LAND.COLLECTION)) return;
        chunkCacheClear();
        shieldState.taxPrompts.clear();
        Logger.info("LandProtection", "Database restore detected — chunk cache and tax prompts cleared", { restored });
    }
    
    static #fastGetClaimAt(target) {
        if (!target?.location) return null;
        const loc = target.location;
        const dim = target.dimension?.id || target.dimensionId || "minecraft:overworld";
        const cx = Math.floor(loc.x) >> 4;
        const cz = Math.floor(loc.z) >> 4;
        const cacheKey = `${dim}:${cx}:${cz}`;
        
        // Phase 7.7 (v1.0.0): Use LRU+TTL cache helpers.
        let claimId = chunkCacheGet(cacheKey);
        
        if (claimId === undefined) {
            const claim = LandService.getClaimAt(target);
            if (claim) {
                chunkCacheSet(cacheKey, claim.id);
                return claim;
            } else {
                chunkCacheSet(cacheKey, null); 
                return null;
            }
        }
        
        if (claimId === null) return null;
        
        const db = LandService.db();
        const cachedClaim = db.claims[claimId];
        
        const y = Math.floor(loc.y);
        if (cachedClaim && y >= cachedClaim.minY && y <= cachedClaim.maxY) {
            return cachedClaim;
        }
        
        return null;
    }

    // --- Dynamic Energy Shield Logic --- //

    static #masterPollerTick() {
        // Phase 2 Performance: Use spatial index ring search instead of
        // scanning every claim for every player (was O(N×M), now O(M×R) where
        // R is the small ring radius that finds the nearest claim — typically
        // a handful of lookups per player instead of thousands).
        // Phase 5 Deep Fix: Use PlayerRegistry.online() instead of world.getAllPlayers()
        // to avoid allocating a new array every 5 seconds. The registry maintains
        // an O(1) Map index that is updated incrementally via spawn/leave events.
        const players = PlayerRegistry.online();
        if (players.length === 0) return;

        const now = Date.now();
        for (const player of players) {
            if (player.dimension.id !== "minecraft:overworld") continue; 
            
            // Phase 4: AFK detection — track position changes over time.
            this.#updateAfkState(player, now);

            // Phase 4.5: one global scheduler; no interval per player.
            this.#playerShieldTick(player);
        }
    }

    /**
     * Phase 4 Scalability: Update AFK state for a player.
     * If the player hasn't moved more than AFK_THRESHOLD_BLOCKS in
     * AFK_TIMEOUT_MS milliseconds, mark them as AFK.
     */
    static #updateAfkState(player, now) {
        try {
            const loc = player.location;
            const pid = player.id;
            const prev = afkState.lastPositions.get(pid);
            if (!prev) {
                afkState.lastPositions.set(pid, { x: loc.x, y: loc.y, z: loc.z, time: now });
                return;
            }
            const dx = loc.x - prev.x;
            const dy = loc.y - prev.y;
            const dz = loc.z - prev.z;
            const moved = Math.sqrt(dx * dx + dy * dy + dz * dz);
            if (moved > AFK_THRESHOLD_BLOCKS) {
                // Player moved — reset their AFK timer.
                afkState.lastPositions.set(pid, { x: loc.x, y: loc.y, z: loc.z, time: now });
                afkState.afkPlayers.delete(pid);
            } else if (now - prev.time > AFK_TIMEOUT_MS) {
                // Player has been stationary long enough → mark AFK.
                afkState.afkPlayers.add(pid);
            }
        } catch {}
    }

    static isAfk(playerId) {
        return afkState.afkPlayers.has(playerId);
    }

    static afkStats() {
        return {
            tracked: afkState.lastPositions.size,
            afk: afkState.afkPlayers.size
        };
    }

    static #playerShieldTick(player) {
        if (!player.isValid) {
            const p = shieldState.activePollers.get(player.id);
            if (p) RuntimeHandleRegistry.clear(p.intervalId);
            shieldState.activePollers.delete(player.id);
            shieldState.safeLocations.delete(player.id);
            return;
        }

        const claim = this.#fastGetClaimAt(player);

        if (!claim) {
            this.#recordSafeLocation(player);
            return;
        }

        const entryMode = claim.flags?.entry || "public";

        if (entryMode === "public") {
            this.#recordSafeLocation(player);
            return;
        }

        if (LandService.canManage(claim, player) || LandService.isTrusted(claim, player) || LandService.isTenant(claim, player)) {
            this.#recordSafeLocation(player);
            return;
        }

        if (entryMode === "trusted" || entryMode === "private") {
            this.#repelIntruder(player, claim, entryMode === "private" ? "This land is strictly Private." : "You do not have permission to enter this Trusted land.");
            return;
        }

        if (entryMode === "taxed") {
            if (LandService.hasEntryPass(player, claim)) {
                this.#recordSafeLocation(player); 
                return;
            }
            this.#repelIntruder(player, claim, "This is a Toll Zone.");
            this.#promptTax(player, claim);
        }
    }

    static #recordSafeLocation(player) {
        shieldState.safeLocations.set(player.id, {
            x: player.location.x,
            y: player.location.y,
            z: player.location.z,
            dimensionId: player.dimension.id,
            rx: player.getRotation().x,
            ry: player.getRotation().y
        });
    }

    static #repelIntruder(player, claim, message) {
        const safe = shieldState.safeLocations.get(player.id);
        
        if (safe && safe.dimensionId === player.dimension.id) {
            player.teleport({ x: safe.x, y: safe.y, z: safe.z }, {
                dimension: player.dimension,
                rotation: { x: safe.rx, y: safe.ry },
                checkForBlocks: true
            });
        } else {
            // Phase 4.5: never use the lethal Y=300 fallback. Use the
            // dimension/default spawn only when it can be resolved safely.
            try {
                const spawn = world.getDefaultSpawnLocation();
                player.teleport({ x: spawn.x, y: spawn.y, z: spawn.z }, { dimension: world.getDimension("minecraft:overworld"), checkForBlocks: true });
            } catch (error) { Logger.warn("LandProtection", `Safe teleport unavailable for ${player.id}; teleport skipped`, error); }
        }

        try {
            player.dimension.spawnParticle("minecraft:endrod", { x: player.location.x, y: player.location.y + 1, z: player.location.z });
            player.playSound("item.shield.block");
            player.onScreenDisplay.setActionBar(`§c⛔ ${message}`);
        } catch {}
    }

    static #promptTax(player, claim) {
        if (shieldState.taxPrompts.has(player.id)) return;
        shieldState.taxPrompts.add(player.id);

        const fee = claim.flags?.entryTaxCents ?? LC.DEFAULT_ENTRY_TAX_CENTS;
        const feeStr = (fee / 100).toFixed(2);

        system.run(async () => {
            try {
                const form = new ActionFormData()
                    .title("§6Toll Gate")
                    .body(`§7You have reached the border of §f${claim.ownerName}'s§7 land.\n\n§eEntry Fee: §a$${feeStr}§7\nValid for: 1 Hour`)
                    .button("§aPay & Enter")
                    .button("§cCancel");
                
                const response = await form.show(player);
                shieldState.taxPrompts.delete(player.id);

                if (response.canceled || response.selection === 1) return;

                if (response.selection === 0) {
                    const result = LandService.payEntryTax(player, claim.id);
                    if (result.success) player.sendMessage(CONFIG.PREFIX + result.message);
                    else player.sendMessage(CONFIG.PREFIX + result.message);
                }
            } catch (e) {
                shieldState.taxPrompts.delete(player.id);
            }
        });
    }

    // --- Block Protection Logic --- //

    static #registerProtection() {
        if (LC.PROTECTION.BREAK) {
            BedrockCompat.subscribe("block.break.before", "LandProtection.break", e => {
                if (LandService.isClaimPreviewMarker(e.block)) {
                    e.cancel = true;
                    system.run(() => LandService.removeClaimPreviewMarker(e.block));
                    return;
                }
                const c = this.#fastGetClaimAt(e.block);
                if (c && !LandService.checkPermission(c, e.player, "break")) {
                    e.cancel = true;
                    deny(e.player, "You cannot break blocks in this land.");
                }
            });
        }

        if (LC.PROTECTION.PLACE) this.#registerPlaceProtection();

        if (LC.PROTECTION.INTERACT) {
            BedrockCompat.subscribe("block.interact.before", "LandProtection.interact", e => {
                const c = this.#fastGetClaimAt(e.block);
                if (!c) return;
                const action = isContainerBlock(e.block) ? "containers" : "interact";
                if (isRedstoneBlock(e.block) && c.flags.redstone === false && !LandService.canManage(c, e.player)) {
                    e.cancel = true;
                    deny(e.player, "Redstone is disabled in this land.");
                    return;
                }
                if (!LandService.checkPermission(c, e.player, action)) {
                    e.cancel = true;
                    deny(e.player, "You cannot interact with this land.");
                }
            });
        }

        if (LC.PROTECTION.FIRE_LIQUID) this.#registerFireLiquidProtection();

        if (LC.PROTECTION.PVP) {
            if (BedrockCompat.signal("entity.hurt.before")) BedrockCompat.subscribe("entity.hurt.before", "LandProtection.pvp", e => { const hurt=e.hurtEntity,attacker=e.damageSource?.damagingEntity;const c=this.#fastGetClaimAt(hurt)||this.#fastGetClaimAt(attacker);if(hurt instanceof Player&&attacker instanceof Player&&c?.flags?.pvp===false){e.cancel=true;deny(attacker,"PVP is disabled in this land.");} });
            else BedrockCompat.subscribe("entity.hurt.after", "LandProtection.pvpCompensating", e => { const hurt=e.hurtEntity,attacker=e.damageSource?.damagingEntity;const c=this.#fastGetClaimAt(hurt)||this.#fastGetClaimAt(attacker);if(hurt instanceof Player&&attacker instanceof Player&&c?.flags?.pvp===false){try{const health=hurt.getComponent("minecraft:health");if(health&&Number(e.damage)>0)health.setCurrentValue(Math.min(health.effectiveMax||health.defaultValue||20,health.currentValue+e.damage));}catch(error){Logger.warn("LandProtection","PVP compensation unavailable",error);}deny(attacker,"PVP is disabled in this land.");} });
        }

        if (LC.PROTECTION.EXPLOSIONS) this.#registerExplosionProtection();
        if (LC.PROTECTION.PISTONS) this.#registerPistonProtection();
    }

    static #registerExplosionProtection() {
        BedrockCompat.subscribe("explosion.before", "LandProtection.explosion", e => {
            const blocksToProtect = [];
            const impactedBlocks = e.getImpactedBlocks();
            for (const block of impactedBlocks) {
                const c = this.#fastGetClaimAt(block);
                if (c && c.flags.explosions === false) blocksToProtect.push(block);
            }
            if (blocksToProtect.length > 0) {
                if (blocksToProtect.length === impactedBlocks.length) e.cancel = true;
                else e.setImpactedBlocks(impactedBlocks.filter(b => !blocksToProtect.includes(b)));
            }
        });
    }

    static #registerPistonProtection() {
        // A cancellable piston before-event is unavailable on the pinned API.
        // Registration failure is surfaced by BedrockCompat/Health Check. A
        // behaviorally safe fallback is deferred to the dedicated protection phase.
        BedrockCompat.subscribe("piston.activate.before", "LandProtection.piston", e => {
            const pistonBlock = e.piston?.block || e.block || e.sourceBlock;
            const pistonClaim = this.#fastGetClaimAt(pistonBlock);
            let affectedLocs = [];
            try {
                if (e.piston?.getAttachedBlocksLocations) affectedLocs = e.piston.getAttachedBlocksLocations();
            } catch {}
            const dim = pistonBlock?.dimension || e.dimension;
            for (const loc of affectedLocs) {
                const blockObj = dim?.getBlock(loc);
                if (!blockObj) continue;
                const c = this.#fastGetClaimAt(blockObj);
                if (c) {
                    if (c.flags.pistons === false || !pistonClaim || pistonClaim.id !== c.id) {
                        e.cancel = true;
                        return;
                    }
                }
            }
        });
    }

    static #registerPlaceProtection() {
        if (BedrockCompat.signal("block.place.before")) {
            BedrockCompat.subscribe("block.place.before", "LandProtection.placeBefore", e => {
                const loc = e.block?.location || e.player.location;
                const c = this.#fastGetClaimAt({ location: loc, dimension: e.player.dimension });
                if (c && !LandService.checkPermission(c, e.player, "place")) {
                    e.cancel = true;
                    deny(e.player, "You cannot place blocks in this land.");
                }
            });
            return;
        }

        BedrockCompat.subscribe("block.place.after", "LandProtection.placeAfter", e => {
            const player = e.player;
            const block = e.block;
            if (!(player instanceof Player) || !block) return;
            const c = this.#fastGetClaimAt(block);
            if (c && !LandService.checkPermission(c, player, "place")) {
                const typeId=block.typeId;
                system.run(() => { try { if(block.typeId===typeId)block.setType("minecraft:air"); const container=player.getComponent("minecraft:inventory")?.container; if(container)container.addItem(new ItemStack(typeId,1)); } catch(error){Logger.warn("LandProtection","Placement compensation failed",error);} });
                deny(player, "You cannot place blocks in this land. Block removed and item refunded.");
            }
        });
    }

    static #registerFireLiquidProtection() {
        if (BedrockCompat.signal("item.useOn.before")) {
            BedrockCompat.subscribe("item.useOn.before", "LandProtection.fireLiquidUseOn", e => {
                const player = e.source; if (!(player instanceof Player)) return;
                const c = this.#fastGetClaimAt(e.block); if (!c) return;
                const id = e.itemStack?.typeId;
                if (isFireItem(id) && c.flags.fire === false && !LandService.checkPermission(c, player, "place")) { e.cancel = true; deny(player, "Fire is disabled in this land."); return; }
                if (isLiquidItem(id) && c.flags.liquids === false && !LandService.checkPermission(c, player, "place")) { e.cancel = true; deny(player, "Liquids are disabled in this land."); }
            });
            return;
        }

        BedrockCompat.subscribe("item.use.before", "LandProtection.fireLiquidUse", e => {
            const player = e.source; if (!(player instanceof Player)) return;
            const c = LandService.currentClaim(player); if (!c) return;
            const id = e.itemStack?.typeId;
            if (isFireItem(id) && c.flags.fire === false && !LandService.checkPermission(c, player, "place")) { e.cancel = true; deny(player, "Fire is disabled in this land."); return; }
            if (isLiquidItem(id) && c.flags.liquids === false && !LandService.checkPermission(c, player, "place")) { e.cancel = true; deny(player, "Liquids are disabled in this land."); }
        });
    }

}

export default LandProtection;