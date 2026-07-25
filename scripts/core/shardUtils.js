// MCity Dashboard V2 - Shard Utilities
// v1.9.0: deterministic shard naming helpers for player/item/region data.

import { CONFIG } from "../config.js";

const SH = CONFIG.DATABASE?.SHARDING || {};

export class ShardUtils {
    static HASH_ALGORITHM = "fnv1a_imul_v2";
    static LEGACY_HASH_ALGORITHM = "fnv1a_float_v1";

    static fnv1a(key = "") {
        const s = String(key || "");
        let hash = 2166136261;
        for (let i = 0; i < s.length; i++) {
            hash ^= s.charCodeAt(i);
            hash = Math.imul(hash, 16777619) >>> 0;
        }
        return hash >>> 0;
    }

    static fnv1aLegacy(key = "") {
        const s = String(key || "");
        let hash = 2166136261;
        for (let i = 0; i < s.length; i++) {
            hash ^= s.charCodeAt(i);
            hash = (hash * 16777619) >>> 0;
        }
        return hash >>> 0;
    }

    static clampCount(n, fallback = 1) {
        return Math.max(1, Math.min(128, Math.floor(Number(n) || fallback)));
    }

    static hashIndex(key, shardCount = 1) {
        const count = this.clampCount(shardCount, 1);
        return this.fnv1a(key) % count;
    }

    static legacyHashIndex(key, shardCount = 1) {
        const count = this.clampCount(shardCount, 1);
        return this.fnv1aLegacy(key) % count;
    }

    static hashShardName(base, key, shardCount = 1) {
        const count = this.clampCount(shardCount, 1);
        if (count <= 1) return base;
        return `${base}_shard_${this.hashIndex(key, count)}`;
    }

    static playerShardName(base, playerId, shardCount = SH.PLAYER_SHARD_COUNT || 8) {
        return this.hashShardName(base, playerId, shardCount);
    }

    static itemShardName(base, itemId, shardCount = SH.ITEM_SHARD_COUNT || 8) {
        return this.hashShardName(base, String(itemId || "").toLowerCase(), shardCount);
    }

    static allHashShardNames(base, shardCount = 1) {
        const count = this.clampCount(shardCount, 1);
        if (count <= 1) return [base];
        const out = [];
        for (let i = 0; i < count; i++) out.push(`${base}_shard_${i}`);
        return out;
    }

    static dimShort(dimensionId = "minecraft:overworld") {
        const d = String(dimensionId || "minecraft:overworld").replace("minecraft:", "");
        if (d === "the_nether") return "nether";
        if (d === "the_end") return "end";
        return d || "overworld";
    }

    static chunkCoord(v) { return Math.floor(Number(v) / 16); }
    static regionCoord(chunkCoord, regionSizeChunks = SH.REGION_SIZE_CHUNKS || 16) {
        return Math.floor(Number(chunkCoord) / Math.max(1, Math.floor(Number(regionSizeChunks) || 16)));
    }

    static regionShardName(base, dimensionId, chunkX, chunkZ, regionSizeChunks = SH.REGION_SIZE_CHUNKS || 16) {
        const dim = this.dimShort(dimensionId);
        const rx = this.regionCoord(chunkX, regionSizeChunks);
        const rz = this.regionCoord(chunkZ, regionSizeChunks);
        return `${base}_region_${dim}_${rx}_${rz}`;
    }

    static regionShardNameFromBlock(base, block, regionSizeChunks = SH.REGION_SIZE_CHUNKS || 16) {
        const cx = this.chunkCoord(block?.location?.x || 0);
        const cz = this.chunkCoord(block?.location?.z || 0);
        return this.regionShardName(base, block?.dimension?.id || "minecraft:overworld", cx, cz, regionSizeChunks);
    }

    static moduleConfig(name) {
        return SH.MODULES?.[name] || null;
    }

    static shardNameForModule(name, key) {
        const cfg = this.moduleConfig(name);
        if (!cfg || !cfg.ENABLED) return cfg?.BASE || String(name || "").toLowerCase();
        if (cfg.TYPE === "player_hash") return this.playerShardName(cfg.BASE, key, cfg.SHARD_COUNT || SH.PLAYER_SHARD_COUNT || 8);
        if (cfg.TYPE === "item_hash") return this.itemShardName(cfg.BASE, key, cfg.SHARD_COUNT || SH.ITEM_SHARD_COUNT || 8);
        return this.hashShardName(cfg.BASE, key, cfg.SHARD_COUNT || 1);
    }
}

export default ShardUtils;
