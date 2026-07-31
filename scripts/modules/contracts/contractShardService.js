// MCity Dashboard V2 - Contract Shard Service
// v1.9.6 Sharding Phase 4: player-sharded delivery mailbox facade.

import { CONFIG } from "../../config.js";
import { Database } from "../../core/database.js";
import { Logger } from "../../core/logger.js";
import { ShardUtils } from "../../core/shardUtils.js";
import { DEFAULT_CONTRACT_DB, validateContractData } from "../../schemas/contractSchema.js";
import { DEFAULT_CONTRACT_MAILBOX_SHARD_DB, validateContractMailboxShardData } from "../../schemas/contractShardSchema.js";
import { DisposableRegistry } from "../../core/disposableRegistry.js";

const CC = CONFIG.CONTRACTS;
const COLLECTION = CC.COLLECTION;
const CFG = CONFIG.DATABASE?.SHARDING?.MODULES?.CONTRACT_MAILBOX || { ENABLED: false, BASE: "contract_mailbox", SHARD_COUNT: 8 };
function now() { return Date.now(); }

export class ContractShardService {
    static #initialized = false;

    static initialize() {
        if (this.#initialized) return;
        this.#initialized = true;
        if (this.enabled()) {
            this.migrateMailboxFromLegacy();
        }
        DisposableRegistry.registerShutdownCleanup("ContractShardService.lifecycle", () => { this.#initialized = false; });
        Logger.startup("ContractShards", `Initialized (mailbox shards=${this.enabled() ? this.shardCount() : 0})`);
    }

    static enabled() { return !!CFG.ENABLED; }
    static shardCount() { return ShardUtils.clampCount(CFG.SHARD_COUNT || CONFIG.DATABASE?.SHARDING?.PLAYER_SHARD_COUNT || 8, 8); }
    static base() { return CFG.BASE || "contract_mailbox"; }
    static shardName(playerId) { return ShardUtils.playerShardName(this.base(), playerId, this.shardCount()); }
    static allShardNames() { return ShardUtils.allHashShardNames(this.base(), this.shardCount()); }
    static shardDB(playerId) { return this.shardDBByName(this.shardName(playerId)); }
    static shardDBByName(name) { return Database.collection(name, DEFAULT_CONTRACT_MAILBOX_SHARD_DB, { validate: validateContractMailboxShardData }); }
    static legacyDB() { return Database.collection(COLLECTION, DEFAULT_CONTRACT_DB, { validate: validateContractData }); }

    static migrateMailboxFromLegacy() {
        if (!this.enabled()) return { migrated: 0, skipped: "disabled" };
        const legacy = this.legacyDB();
        if (legacy.mailboxSharded?.moved && legacy.mailboxSharded?.shardCount === this.shardCount()) return { migrated: 0, skipped: "already migrated" };
        let migrated = 0, entries = 0;
        for (const [pid, list] of Object.entries(legacy.itemMailbox || {})) {
            if (!Array.isArray(list) || !list.length) continue;
            const shardName = this.shardName(pid);
            const shard = this.shardDB(pid);
            const existing = Array.isArray(shard.itemMailbox[pid]) ? shard.itemMailbox[pid] : [];
            const byId = new Map();
            for (const e of existing) if (e?.id) byId.set(e.id, e);
            for (const e of list) if (e?.id) byId.set(e.id, e);
            shard.itemMailbox[pid] = [...byId.values()];
            this.#recount(shard);
            Database.markDirty(shardName);
            delete legacy.itemMailbox[pid];
            migrated++;
            entries += list.length;
        }
        legacy.mailboxSharded = { moved: true, shardCount: this.shardCount(), movedAt: now() };
        Database.markDirty(COLLECTION);
        if (migrated) Logger.startup("ContractShards", `Moved ${entries} delivery entrie(s) for ${migrated} player(s) to ${this.shardCount()} shard(s)`);
        return { migrated, entries };
    }

    static moveLegacyMailboxFor(playerId) {
        if (!this.enabled() || !playerId) return { moved: 0, skipped: "disabled" };
        const legacy = this.legacyDB();
        const list = legacy.itemMailbox?.[playerId];
        if (!Array.isArray(list) || !list.length) return { moved: 0 };
        const shardName = this.shardName(playerId);
        const shard = this.shardDB(playerId);
        const existing = Array.isArray(shard.itemMailbox[playerId]) ? shard.itemMailbox[playerId] : [];
        const byId = new Map();
        for (const e of existing) if (e?.id) byId.set(e.id, e);
        for (const e of list) if (e?.id) byId.set(e.id, e);
        shard.itemMailbox[playerId] = [...byId.values()];
        this.#recount(shard);
        Database.markDirty(shardName);
        delete legacy.itemMailbox[playerId];
        Database.markDirty(COLLECTION);
        return { moved: list.length, shardName };
    }

    static mailbox(playerId) {
        if (!this.enabled()) return [];
        return [...(this.shardDB(playerId).itemMailbox[playerId] || [])].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    }

    static stats(playerId) {
        const list = this.mailbox(playerId);
        return { count: list.length, items: list.reduce((s, e) => s + (e.amount || 0), 0) };
    }

    static verify() {
        const legacy = this.legacyDB();
        const report = { enabled: this.enabled(), legacyPlayers: 0, legacyEntries: 0, shardPlayers: 0, shardEntries: 0 };
        for (const list of Object.values(legacy.itemMailbox || {})) if (Array.isArray(list) && list.length) { report.legacyPlayers++; report.legacyEntries += list.length; }
        if (this.enabled()) for (const name of this.allShardNames()) {
            const shard = this.shardDBByName(name);
            report.shardPlayers += Object.keys(shard.itemMailbox || {}).length;
            report.shardEntries += Object.values(shard.itemMailbox || {}).reduce((s, l) => s + (Array.isArray(l) ? l.length : 0), 0);
        }
        report.ok = report.legacyEntries === 0;
        return report;
    }

    static #recount(shard) {
        shard.stats.totalPlayers = Object.keys(shard.itemMailbox || {}).length;
        shard.stats.totalEntries = Object.values(shard.itemMailbox || {}).reduce((s, list) => s + (Array.isArray(list) ? list.length : 0), 0);
        shard.stats.lastUpdated = now();
    }
}

export default ContractShardService;
