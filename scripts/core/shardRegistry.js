// MCity Dashboard V2 - Shard Registry
// v1.9.0: read-only registry of configured shard domains.

import { CONFIG } from "../config.js";
import { ShardUtils } from "./shardUtils.js";

export class ShardRegistry {
    static config() { return CONFIG.DATABASE?.SHARDING || {}; }
    static modules() { return this.config().MODULES || {}; }

    static definition(name) {
        const def = this.modules()?.[name] || null;
        if (!def) return null;
        return { name, ...def };
    }

    static listDefinitions() {
        return Object.entries(this.modules()).map(([name, def]) => ({ name, ...def }));
    }

    static enabledDefinitions() {
        return this.listDefinitions().filter(d => !!d.ENABLED);
    }

    static targetCollections(name) {
        const def = this.definition(name);
        if (!def) return [];
        if (!def.ENABLED) return [def.BASE || name.toLowerCase()];
        if (def.TYPE === "player_hash" || def.TYPE === "item_hash" || def.TYPE === "operation_hash") {
            return ShardUtils.allHashShardNames(def.BASE, def.SHARD_COUNT || this.config().PLAYER_SHARD_COUNT || 1);
        }
        if (def.TYPE === "region") return [`${def.BASE}_region_<dim>_<rx>_<rz>`];
        return [def.BASE];
    }

    static status() {
        const defs = this.listDefinitions();
        return {
            enabled: !!this.config().ENABLED,
            playerShardCount: this.config().PLAYER_SHARD_COUNT || 1,
            itemShardCount: this.config().ITEM_SHARD_COUNT || 1,
            regionSizeChunks: this.config().REGION_SIZE_CHUNKS || 16,
            modules: defs.map(d => ({
                name: d.name,
                enabled: !!d.ENABLED,
                type: d.TYPE || "unknown",
                base: d.BASE || "",
                shardCount: d.SHARD_COUNT || (d.TYPE === "item_hash" ? this.config().ITEM_SHARD_COUNT : this.config().PLAYER_SHARD_COUNT) || 1,
                targetCollections: this.targetCollections(d.name)
            }))
        };
    }
}

export default ShardRegistry;
