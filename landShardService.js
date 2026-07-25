// MCity Dashboard V2 - Land Shard Service
// v1.9.8 Sharding Phase 6: entry-pass player shards + region naming helpers.

import { CONFIG } from "../../config.js";
import { Database } from "../../core/database.js";
import { Logger } from "../../core/logger.js";
import { ShardUtils } from "../../core/shardUtils.js";
import { DEFAULT_LAND_DB, validateLandData } from "../../schemas/landSchema.js";
import { DEFAULT_LAND_ENTRY_PASS_SHARD_DB, validateLandEntryPassShardData } from "../../schemas/landEntryPassShardSchema.js";
import { DisposableRegistry } from "../../core/disposableRegistry.js";

const LC = CONFIG.LAND;
const COLLECTION = LC.COLLECTION;
const CFG = CONFIG.DATABASE?.SHARDING?.MODULES?.LAND_ENTRY_PASSES || { ENABLED: false, BASE: "land_entry_passes", SHARD_COUNT: 8 };
const REGION_CFG = CONFIG.DATABASE?.SHARDING?.MODULES?.LAND_REGIONS || { ENABLED: false, BASE: "land", REGION_SIZE_CHUNKS: 16 };
function now() { return Date.now(); }

export class LandShardService {
    static #initialized = false;

    static initialize() {
        if (this.#initialized) return;
        this.#initialized = true;
        if (this.entryPassEnabled()) this.migrateEntryPassesFromLegacy();
        DisposableRegistry.registerShutdownCleanup("LandShardService.lifecycle", () => { this.#initialized = false; });
        Logger.startup("LandShards", `Initialized (entryPassShards=${this.entryPassEnabled() ? this.entryPassShardCount() : 0}, regionReady=${this.regionEnabled()})`);
    }

    static entryPassEnabled() { return !!CFG.ENABLED; }
    static entryPassShardCount() { return ShardUtils.clampCount(CFG.SHARD_COUNT || CONFIG.DATABASE?.SHARDING?.PLAYER_SHARD_COUNT || 8, 8); }
    static entryPassBase() { return CFG.BASE || "land_entry_passes"; }
    static entryPassShardName(playerId) { return ShardUtils.playerShardName(this.entryPassBase(), playerId, this.entryPassShardCount()); }
    static allEntryPassShardNames() { return ShardUtils.allHashShardNames(this.entryPassBase(), this.entryPassShardCount()); }
    static entryPassDB(playerId) { return this.entryPassDBByName(this.entryPassShardName(playerId)); }
    static entryPassDBByName(name) { return Database.collection(name, DEFAULT_LAND_ENTRY_PASS_SHARD_DB, { validate: validateLandEntryPassShardData }); }
    static legacyLandDB() { return Database.collection(COLLECTION, DEFAULT_LAND_DB, { validate: validateLandData }); }

    static migrateEntryPassesFromLegacy() {
        if (!this.entryPassEnabled()) return { migratedPlayers: 0, migratedPasses: 0, skipped: "disabled" };
        const legacy = this.legacyLandDB();
        if (legacy.entryPassesSharded?.moved && legacy.entryPassesSharded?.shardCount === this.entryPassShardCount()) return { migratedPlayers: 0, migratedPasses: 0, skipped: "already migrated" };
        let migratedPlayers = 0, migratedPasses = 0;
        for (const [pid, passes] of Object.entries(legacy.entryPasses || {})) {
            if (!passes || typeof passes !== "object" || Array.isArray(passes)) continue;
            const shardName = this.entryPassShardName(pid);
            const shard = this.entryPassDB(pid);
            if (!shard.entryPasses[pid]) shard.entryPasses[pid] = {};
            for (const [claimId, expires] of Object.entries(passes)) {
                const expiry = Math.max(0, Math.floor(Number(expires) || 0));
                if (expiry > now()) { shard.entryPasses[pid][claimId] = expiry; migratedPasses++; }
            }
            if (Object.keys(shard.entryPasses[pid]).length === 0) delete shard.entryPasses[pid];
            this.#recount(shard);
            Database.markDirty(shardName);
            delete legacy.entryPasses[pid];
            migratedPlayers++;
        }
        legacy.entryPassesSharded = { moved: true, shardCount: this.entryPassShardCount(), movedAt: now() };
        Database.markDirty(COLLECTION);
        if (migratedPlayers) Logger.startup("LandShards", `Moved ${migratedPasses} entry pass(es) for ${migratedPlayers} player(s) into ${this.entryPassShardCount()} shard(s)`);
        return { migratedPlayers, migratedPasses };
    }

    static getEntryPass(playerId, claimId) {
        if (!this.entryPassEnabled()) return 0;
        return Number(this.entryPassDB(playerId).entryPasses?.[playerId]?.[claimId] || 0);
    }

    static setEntryPass(playerId, claimId, expiresAt) {
        if (!this.entryPassEnabled()) return { success: false, skipped: "disabled" };
        const shardName = this.entryPassShardName(playerId);
        const tx = Database.transaction(shardName, data => {
            if (!data.entryPasses[playerId]) data.entryPasses[playerId] = {};
            data.entryPasses[playerId][claimId] = Math.max(0, Math.floor(Number(expiresAt) || 0));
            this.#recount(data);
            return { expiresAt: data.entryPasses[playerId][claimId] };
        });
        return tx.success ? { success: true, expiresAt: tx.result.expiresAt } : { success: false, message: tx.error };
    }

    static clearPlayerPasses(playerId) {
        if (!this.entryPassEnabled()) return 0;
        let removed = 0;
        const shardName = this.entryPassShardName(playerId);
        const tx = Database.transaction(shardName, data => {
            removed = Object.keys(data.entryPasses?.[playerId] || {}).length;
            delete data.entryPasses[playerId];
            this.#recount(data);
            return removed;
        });
        return tx.success ? removed : 0;
    }

    static pruneExpired(validClaimIds = null) {
        if (!this.entryPassEnabled()) return { removedPasses: 0, removedPlayers: 0, skipped: "disabled" };
        const t = now();
        let removedPasses = 0, removedPlayers = 0;
        for (const name of this.allEntryPassShardNames()) {
            this.entryPassDBByName(name);
            const tx = Database.transaction(name, data => {
                let rp = 0, rpl = 0;
                for (const [pid, passes] of Object.entries(data.entryPasses || {})) {
                    for (const [cid, expires] of Object.entries(passes || {})) {
                        if (Number(expires) <= t || (validClaimIds && !validClaimIds.has(cid))) { delete passes[cid]; rp++; }
                    }
                    if (Object.keys(passes || {}).length === 0) { delete data.entryPasses[pid]; rpl++; }
                }
                this.#recount(data);
                return { removedPasses: rp, removedPlayers: rpl };
            });
            if (tx.success) { removedPasses += tx.result.removedPasses || 0; removedPlayers += tx.result.removedPlayers || 0; }
        }
        return { removedPasses, removedPlayers };
    }

    static regionEnabled() { return !!REGION_CFG.ENABLED; }
    static regionSizeChunks() { return Math.max(1, Math.floor(Number(REGION_CFG.REGION_SIZE_CHUNKS || CONFIG.DATABASE?.SHARDING?.REGION_SIZE_CHUNKS || 16))); }
    static regionNameForChunk(dimensionId, cx, cz) { return ShardUtils.regionShardName(REGION_CFG.BASE || "land", dimensionId, cx, cz, this.regionSizeChunks()); }
    static regionNameForClaim(claim) { return this.regionNameForChunk(claim?.dimension, claim?.chunkX, claim?.chunkZ); }

    static status() {
        const legacy = this.legacyLandDB();
        const legacyPlayers = Object.keys(legacy.entryPasses || {}).length;
        let shardPlayers = 0, shardPasses = 0;
        if (this.entryPassEnabled()) for (const name of this.allEntryPassShardNames()) {
            const shard = this.entryPassDBByName(name);
            shardPlayers += Object.keys(shard.entryPasses || {}).length;
            shardPasses += Object.values(shard.entryPasses || {}).reduce((s, p) => s + Object.keys(p || {}).length, 0);
        }
        return {
            entryPasses: { enabled: this.entryPassEnabled(), shardCount: this.entryPassShardCount(), legacyPlayers, shardPlayers, shardPasses },
            regions: { enabled: this.regionEnabled(), regionSizeChunks: this.regionSizeChunks(), base: REGION_CFG.BASE || "land" }
        };
    }

    static #recount(data) {
        data.stats.totalPlayers = Object.keys(data.entryPasses || {}).length;
        data.stats.totalPasses = Object.values(data.entryPasses || {}).reduce((s, p) => s + Object.keys(p || {}).length, 0);
        data.stats.lastUpdated = now();
    }
}

export default LandShardService;
