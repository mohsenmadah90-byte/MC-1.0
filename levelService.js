// MCity Dashboard V2 - Level Service
// Score, level, bonuses and leaderboard for Dashboard-driven progression.
// Phase 1 Critical Fix: Register cache cleanup with DisposableRegistry.
// Phase 7.6 (v0.23.0) (S1): Sharding support to avoid 1MB DP cap on large servers.
// Phase 8 (v1.5.8): Registry refresh + O(1) rank index.
// Hotfix 1 (v1.6.1): DB-authoritative score core; scoreboard is a mirror.
// Patch 3 (v1.6.7): database.restored cache/scoreboard refresh hook.

import { world, Player } from "@minecraft/server";
import { CONFIG } from "../../config.js";
import { Database } from "../../core/database.js";
import { Logger } from "../../core/logger.js";
import { DisposableRegistry } from "../../core/disposableRegistry.js";
import { PlayerRegistry } from "../../core/playerRegistry.js";
import { EventBus } from "../../core/eventBus.js";
import { AppliedOperationStore } from "../../core/appliedOperationStore.js";
import { DEFAULT_LEVEL_DB, validateLevelData } from "../../schemas/levelSchema.js";

const LC = CONFIG.LEVEL;
const COLLECTION = LC.COLLECTION;
const MAX_SCORE = LC.MAX_SCORE;

export function getLevelByScore(score) {
    const safe = Math.max(0, Math.floor(Number(score) || 0));
    for (const level of LC.LEVELS) if (safe >= level.min && safe <= level.max) return level;
    return LC.LEVELS[LC.LEVELS.length - 1] || { name: "Unknown", color: "§7", bonuses: {} };
}

export class LevelService {
    static #scoreObj = null;
    static #levelObj = null;
    static #scoreCache = new Map();
    static #levelCache = new Map();
    static #leaderboardCache = { data: null, time: 0 };
    static #rankIndex = null;
    static #initialized = false;

    static initialize() {
        if (this.#initialized) return;
        this.#initialized = true;
        this.#configureSharding();
        this.db();
        if (this.#shardCount > 1) this.#migrateBaseToShards();
        this.ensureObjectives();
        // Phase 1 Fix: Register per-player cache cleanup to prevent memory leak.
        DisposableRegistry.registerPlayerCleanup("LevelService.scoreCache", (playerId) => {
            this.#scoreCache.delete(playerId);
        });
        DisposableRegistry.registerPlayerCleanup("LevelService.levelCache", (playerId) => {
            this.#levelCache.delete(playerId);
        });
        DisposableRegistry.registerPlayerCleanup("LevelService.shardCache", (playerId) => {
            this.#shardCache.delete(playerId);
        });
        DisposableRegistry.registerShutdownCleanup("LevelService.lifecycle", () => {
            this.#scoreCache.clear();
            this.#levelCache.clear();
            this.#leaderboardCache = { data: null, time: 0 };
            this.#rankIndex = null;
            this.#shardCache.clear();
            this.#scoreObj = null;
            this.#levelObj = null;
            this.#initialized = false;
        });
        EventBus.on("database.restored", event => this.onDatabaseRestored(event));
        Database.registerRefreshHandler("LevelService", event => this.onDatabaseRestored(event));
        Logger.startup("Level", `Level service initialized (shards=${this.#shardCount})`);
    }

    static db() {
        return Database.collection(COLLECTION, DEFAULT_LEVEL_DB, { validate: validateLevelData });
    }

    /**
     * Phase 7.6 (v0.23.0) (S1): Returns the appropriate shard collection for
     * a given player. On large servers (8000+ players), a single `levels`
     * collection can exceed the 1MB Bedrock Dynamic Property cap. Sharding
     * splits the player records across N collections based on a hash of the
     * player ID, keeping each shard under the cap.
     *
     * Sharding is DISABLED by default for backward compat. Enable by setting
     * `CONFIG.LEVEL.SHARD_COUNT` to a value > 1 (e.g., 8 or 16) before
     * LevelService.initialize() runs.
     */
    static #shardCount = 1;  // 1 = no sharding (legacy)
    static #shardCache = new Map();  // playerId -> shardName

    static #configureSharding() {
        const configured = Math.floor(Number(LC.SHARD_COUNT) || 1);
        this.#shardCount = Math.max(1, Math.min(64, configured));
    }

    static #allShardNames() {
        const out = [];
        for (let i = 0; i < this.#shardCount; i++) out.push(`${COLLECTION}_shard_${i}`);
        return out;
    }

    static #migrateBaseToShards() {
        const base = this.db();
        const players = base.players || {};
        const ids = Object.keys(players);
        if (!ids.length) return { migrated: 0, shards: this.#shardCount };
        if (base.shardEnabled && base.shardCount === this.#shardCount) return { migrated: 0, skipped: "already migrated" };

        let migrated = 0;
        for (const pid of ids) {
            const rec = players[pid];
            const shardName = Database.shardName(COLLECTION, pid, this.#shardCount);
            const shard = Database.collection(shardName, DEFAULT_LEVEL_DB, { validate: validateLevelData });
            if (!shard.players) shard.players = {};
            shard.players[pid] = rec;
            shard.stats = shard.stats || { totalKnownPlayers: 0, lastUpdated: 0 };
            shard.stats.totalKnownPlayers = Object.keys(shard.players || {}).length;
            shard.stats.lastUpdated = Date.now();
            Database.save(shardName, true);
            migrated++;
        }
        base.players = {};
        base.shardEnabled = true;
        base.shardCount = this.#shardCount;
        base.stats.totalKnownPlayers = 0;
        base.stats.lastUpdated = Date.now();
        Database.save(COLLECTION, true);
        Logger.startup("Level", `Migrated ${migrated} level record(s) into ${this.#shardCount} shard(s)`);
        return { migrated, shards: this.#shardCount };
    }

    static collectionFor(playerId) { return this.#collectionFor(playerId); }

    static dbFor(playerId) {
        if (!playerId || this.#shardCount <= 1) return this.db();
        let shardName = this.#shardCache.get(playerId);
        if (!shardName) {
            shardName = Database.shardName(COLLECTION, playerId, this.#shardCount);
            this.#shardCache.set(playerId, shardName);
        }
        return Database.collection(shardName, DEFAULT_LEVEL_DB, { validate: validateLevelData });
    }

    static ensureObjectives() {
        try {
            if (!this.#scoreObj) this.#scoreObj = world.scoreboard.getObjective(LC.SCORE_OBJECTIVE) || world.scoreboard.addObjective(LC.SCORE_OBJECTIVE, "§6Player Score");
            if (!this.#levelObj) this.#levelObj = world.scoreboard.getObjective(LC.LEVEL_OBJECTIVE) || world.scoreboard.addObjective(LC.LEVEL_OBJECTIVE, "§6Player Level");
        } catch (error) {
            Logger.warn("Level", "Failed to ensure scoreboard objectives", error);
        }
        return { scoreObj: this.#scoreObj, levelObj: this.#levelObj };
    }

    static getScore(player) {
        if (!(player instanceof Player)) return 0;
        const cached = this.#scoreCache.get(player.id);
        if (cached && Date.now() - cached.time < LC.SCORE_CACHE_TTL_MS) return cached.score;

        // Hotfix 1: Level DB is authoritative; scoreboard objectives are only
        // a display/legacy mirror. Existing scoreboard values seed first-time
        // records, but once a DB record exists it wins and repairs scoreboard.
        const db = this.dbFor(player.id);
        const rec = db.players[player.id];
        let score;
        if (rec) {
            score = this.#clamp(rec.score);
            if (this.#readScoreMirror(player) !== score) this.#writeScore(player, score);
            this.#touchLastSeen(player, score, rec);
        } else {
            score = this.#initialScoreFor(player);
            this.#touchLastSeen(player, score, null);
            if (this.#readScoreMirror(player) !== score) this.#writeScore(player, score);
        }
        this.#scoreCache.set(player.id, { score, time: Date.now() });
        return score;
    }

    static setScore(player, score, reason = "set") {
        if (!(player instanceof Player)) return { success: false, message: "Invalid player." };
        const safe = this.#clamp(score);
        const shardName = this.#collectionFor(player.id);
        this.dbFor(player.id); // ensure loaded
        const tx = Database.transaction(shardName, data => {
            this.#writeScoreRecord(data, player, safe);
            return { score: safe, level: getLevelByScore(safe) };
        });
        if (!tx.success) {
            Logger.error("Level", `setScore DB commit failed for ${player.id} (${player.name})`, { reason, error: tx.error });
            return { success: false, message: tx.error || "Score update failed." };
        }
        this.#afterScoreWrite(player, safe);
        Logger.info("Level", `Score set for ${player.name}: ${safe} (${reason})`);
        return { success: true, score: safe, level: getLevelByScore(safe) };
    }

    static addScore(player, amount, reason = "add") {
        if (!(player instanceof Player)) return { success: false, message: "Invalid player." };
        const delta = Math.floor(Number(amount) || 0);
        if (delta === 0) return { success: true, score: this.getScore(player), level: this.getLevelInfo(player) };
        const shardName = this.#collectionFor(player.id);
        this.dbFor(player.id); // ensure loaded
        let nextScore = 0;
        const tx = Database.transaction(shardName, data => {
            const rec = data.players[player.id];
            const current = rec ? this.#clamp(rec.score) : this.#initialScoreFor(player);
            nextScore = this.#clamp(current + delta);
            this.#writeScoreRecord(data, player, nextScore, rec);
            return { score: nextScore, previous: current, delta, level: getLevelByScore(nextScore) };
        });
        if (!tx.success) {
            Logger.error("Level", `addScore DB commit failed for ${player.id} (${player.name})`, { reason, delta, error: tx.error });
            return { success: false, message: tx.error || "Score update failed." };
        }
        this.#afterScoreWrite(player, nextScore);
        return { success: true, score: nextScore, previous: tx.result.previous, delta, level: getLevelByScore(nextScore) };
    }

    static addScoreOffline(playerId, playerName = "Unknown", amount, reason = "offline_add", meta = {}) {
        const delta = Math.floor(Number(amount) || 0);
        if (!playerId || delta === 0) return { success: false, message: "Invalid offline score update." };
        const shardName = this.#collectionFor(playerId);
        const operationId = String(meta.operationId || meta.journalId || "").substring(0, 120);
        const operationEffect = String(meta.operationEffect || "score").substring(0, 64) || "score";
        Database.collection(shardName, DEFAULT_LEVEL_DB, { validate: validateLevelData });
        let nextScore = 0;
        const tx = Database.transaction(shardName, data => {
            if (operationId) {
                const marker = AppliedOperationStore.get(data, operationId, operationEffect);
                if (marker) {
                    nextScore = this.#clamp(marker.value?.score ?? data.players[playerId]?.score ?? 0);
                    return { score: nextScore, previous: nextScore, delta: 0, level: getLevelByScore(nextScore), alreadyApplied: true };
                }
            }
            let rec = data.players[playerId];
            const current = rec ? this.#clamp(rec.score) : 0;
            nextScore = this.#clamp(current + delta);
            const pseudo = { id: playerId, name: playerName || rec?.name || "Unknown" };
            this.#writeScoreRecord(data, pseudo, nextScore, rec);
            if (operationId) AppliedOperationStore.mark(data, operationId, operationEffect, { amount: Math.abs(delta), value: { score: nextScore, previous: current, delta } });
            return { score: nextScore, previous: current, delta, level: getLevelByScore(nextScore), alreadyApplied: false };
        });
        if (!tx.success) return { success: false, message: tx.error || "Offline score update failed." };
        const online = PlayerRegistry.findOnlineById(playerId);
        if (online) {
            this.#writeScore(online, nextScore);
            this.#invalidate(playerId);
        } else {
            this.#invalidate(playerId);
        }
        if (!tx.result.alreadyApplied) Logger.info("Level", `Offline score updated for ${playerName || playerId}: ${nextScore} (${reason})`);
        return { success: true, score: nextScore, previous: tx.result.previous, delta: tx.result.delta, alreadyApplied: !!tx.result.alreadyApplied, operationId, level: getLevelByScore(nextScore) };
    }

    static getLevelInfo(player) {
        if (!(player instanceof Player)) return getLevelByScore(0);
        const cached = this.#levelCache.get(player.id);
        if (cached && Date.now() - cached.time < LC.SCORE_CACHE_TTL_MS) return cached.level;
        const level = getLevelByScore(this.getScore(player));
        this.#levelCache.set(player.id, { level, time: Date.now() });
        return level;
    }

    static getProgress(player) {
        const score = this.getScore(player);
        const level = getLevelByScore(score);
        const next = LC.LEVELS.find(l => l.min > score) || null;
        if (!next) return { score, level, next: null, needed: 0, progress: 1 };
        const previousMin = level.min || 0;
        const span = Math.max(1, next.min - previousMin);
        const done = Math.max(0, score - previousMin);
        return { score, level, next, needed: Math.max(0, next.min - score), progress: Math.max(0, Math.min(1, done / span)) };
    }

    static refreshOnlinePlayers() {
        // Phase 8: use PlayerRegistry's maintained map instead of allocating
        // world.getAllPlayers() during leaderboard refreshes.
        for (const player of PlayerRegistry.online()) {
            try { this.getScore(player); } catch {}
        }
    }

    static getAllScores() {
        this.refreshOnlinePlayers();
        // Phase 7.6 (v0.23.0) (S1): Aggregate across all shards if enabled.
        if (this.#shardCount <= 1) {
            const db = this.db();
            return Object.values(db.players || {}).map(rec => {
                const score = this.#clamp(rec.score);
                return {
                    id: rec.id,
                    name: rec.name || "Unknown",
                    score,
                    level: getLevelByScore(score),
                    lastSeen: rec.lastSeen || 0
                };
            });
        }
        // Sharded: aggregate from all shard collections.
        const out = [];
        for (const shardName of this.#allShardNames()) {
            const shard = Database.collection(shardName, DEFAULT_LEVEL_DB, { validate: validateLevelData });
            for (const rec of Object.values(shard.players || {})) {
                const score = this.#clamp(rec.score);
                out.push({
                    id: rec.id,
                    name: rec.name || "Unknown",
                    score,
                    level: getLevelByScore(score),
                    lastSeen: rec.lastSeen || 0
                });
            }
        }
        return out;
    }

    static leaderboard(limit = 100) {
        const now = Date.now();
        if (this.#leaderboardCache.data && now - this.#leaderboardCache.time < LC.LEADERBOARD_CACHE_TTL_MS) return this.#leaderboardCache.data.slice(0, limit);
        const list = this.getAllScores().sort((a, b) => b.score - a.score);
        this.#leaderboardCache = { data: list, time: now };
        // Phase 8: build O(1) rank index together with the cached list.
        this.#rankIndex = new Map();
        for (let i = 0; i < list.length; i++) this.#rankIndex.set(list[i].id, i + 1);
        return list.slice(0, limit);
    }

    static rankOf(player) {
        if (!player?.id) return null;
        if (!this.#rankIndex) this.leaderboard(1);
        return this.#rankIndex?.get(player.id) ?? null;
    }

    /**
     * Phase 5 Deep Fix: Expose cache statistics for HealthCheckUI.
     * Private fields cannot be read from outside the class; this public
     * method provides a safe, read-only snapshot of cache state.
     */
    static onDatabaseRestored(event = {}) {
        const restored = event.restored || [];
        if (restored.length && !restored.some(n => n === COLLECTION || String(n).startsWith(`${COLLECTION}_shard_`))) return;
        this.#invalidate();
        this.#shardCache.clear();
        this.refreshOnlinePlayers();
        Logger.info("Level", "Database restore detected — caches cleared and online scoreboards refreshed", { restored });
    }

    static getCacheStats() {
        return {
            scoreCacheSize: this.#scoreCache.size,
            levelCacheSize: this.#levelCache.size,
            leaderboardCacheValid: this.#leaderboardCache.data !== null,
            leaderboardCacheAgeMs: this.#leaderboardCache.data ? Date.now() - this.#leaderboardCache.time : 0,
            rankIndexValid: this.#rankIndex !== null
        };
    }

    static #writeScore(player, score) {
        const { scoreObj, levelObj } = this.ensureObjectives();
        this.#setScore(scoreObj, player, score);
        const level = getLevelByScore(score);
        const index = Math.max(1, LC.LEVELS.findIndex(l => l.name === level.name) + 1);
        this.#setScore(levelObj, player, index);
    }

    static #collectionFor(playerId) {
        if (!playerId || this.#shardCount <= 1) return COLLECTION;
        return Database.shardName(COLLECTION, playerId, this.#shardCount);
    }

    static #readScoreMirror(player) {
        const { scoreObj } = this.ensureObjectives();
        return this.#clamp(this.#getScore(scoreObj, player));
    }

    static #initialScoreFor(player) {
        return this.#readScoreMirror(player);
    }

    /**
     * Lightweight read-path touch. Does not change score; only creates a
     * first-time DB record or refreshes lastSeen/name when stale.
     */
    static #touchLastSeen(player, score, existing = null) {
        const db = this.dbFor(player.id);
        const now = Date.now();
        const rec = existing || db.players[player.id];
        if (!rec) {
            this.#writeScoreRecord(db, player, score);
            return;
        }
        if (now - (rec.lastSeen || 0) > 60_000) {
            rec.lastSeen = now;
            rec.name = player.name;
            db.stats.lastUpdated = now;
        }
    }

    static #writeScoreRecord(data, player, score, existing = null) {
        const now = Date.now();
        const rec = existing || data.players[player.id] || {};
        const alreadyKnown = !!(existing || data.players[player.id]);
        const safe = this.#clamp(score);
        const level = getLevelByScore(safe);
        const out = {
            id: player.id,
            name: player.name,
            score: safe,
            levelName: level.name,
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

    static #afterScoreWrite(player, score) {
        const safe = this.#clamp(score);
        this.#writeScore(player, safe);
        this.#invalidate(player.id);
    }

    static #invalidate(playerId = null) {
        if (playerId) {
            this.#scoreCache.delete(playerId);
            this.#levelCache.delete(playerId);
        } else {
            this.#scoreCache.clear();
            this.#levelCache.clear();
        }
        this.#leaderboardCache = { data: null, time: 0 };
        this.#rankIndex = null;
    }

    static #clamp(v) { return Math.max(0, Math.min(MAX_SCORE, Math.floor(Number(v) || 0))); }
    static #getScore(obj, player) { try { return obj && player.scoreboardIdentity ? (obj.getScore(player.scoreboardIdentity) ?? 0) : 0; } catch { return 0; } }
    static #setScore(obj, player, value) { try { if (obj && player.scoreboardIdentity) obj.setScore(player.scoreboardIdentity, Math.max(0, Math.floor(value))); return true; } catch { return false; } }
}

export function getPlayerScore(player) { return LevelService.getScore(player); }
export function getPlayerLevelInfo(player) { return LevelService.getLevelInfo(player); }
export function addScoreAndUpdate(player, score, reason = "add") { return LevelService.addScore(player, score, reason).score ?? LevelService.getScore(player); }

export default LevelService;
