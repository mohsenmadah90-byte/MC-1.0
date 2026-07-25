// MCity Dashboard V2 - Player Registry
// Phase 4: Offline Synchronization & Initialization
// Phase 1 Critical Fix: O(1) online-player lookup + cache invalidation hooks
// Phase 5 Polish: Sanitize player names before storing.
// Phase 8 (v1.5.8): Reduce O(N) registry maintenance costs.

import { world, system } from "@minecraft/server";
import { CONFIG } from "../config.js";
import { Database } from "./database.js";
import { Logger } from "./logger.js";
import { DisposableRegistry } from "./disposableRegistry.js";
import { Sanitizer } from "./sanitizer.js";
import { BedrockCompat } from "./bedrockCompat.js";
import { SubscriptionRegistry } from "./subscriptionRegistry.js";

// Phase 4 Stability: Lazy import NotificationService to break circular dependency.
// PlayerRegistry → NotificationService → PlayerRegistry was causing issues on reload.
let _notificationService = null;
function getNotificationService() {
    if (!_notificationService) {
        _notificationService = import("../dashboard/dashboardNotifications.js").then(m => m.NotificationService).catch(() => null);
    }
    return _notificationService;
}

const COLLECTION = CONFIG.PLAYER_REGISTRY.COLLECTION || "players";
const MAX_PLAYERS = CONFIG.PLAYER_REGISTRY.MAX_PLAYERS || 10000;

const DEFAULT_REGISTRY = {
    schemaVersion: 1,
    version: "1.0.0",
    players: {},
    order: [],
    stats: {
        totalSeen: 0,
        lastUpdated: 0
    }
};

function validateRegistry(data, def) {
    const out = JSON.parse(JSON.stringify(def));
    try {
        out.version = data?.version || "1.0.0";
        out.schemaVersion = Math.max(1, Math.floor(Number(data?.schemaVersion) || Number(out.schemaVersion) || 1));
        out.players = {};
        if (data?.players && typeof data.players === "object") {
            for (const [id, rec] of Object.entries(data.players)) {
                if (!id || !rec || typeof rec !== "object") continue;
                out.players[id] = {
                    id,
                    name: String(rec.name || "Unknown").substring(0, 32),
                    firstSeen: Number(rec.firstSeen) || Date.now(),
                    lastSeen: Number(rec.lastSeen) || 0,
                    lastDimension: String(rec.lastDimension || ""),
                    tags: Array.isArray(rec.tags) ? rec.tags.slice(0, 50).map(String) : []
                };
            }
        }
        out.order = Array.isArray(data?.order) ? data.order.filter(id => out.players[id]).slice(-MAX_PLAYERS) : Object.keys(out.players).slice(-MAX_PLAYERS);
        // Phase 8: use a Set for membership checks instead of O(N)
        // Array.includes for every known player during validation.
        const ordered = new Set(out.order);
        for (const id of Object.keys(out.players)) {
            if (!ordered.has(id)) { out.order.push(id); ordered.add(id); }
        }
        while (out.order.length > MAX_PLAYERS) delete out.players[out.order.shift()];
        out.stats = { ...out.stats, ...(data?.stats || {}) };
        out.stats.totalSeen = Object.keys(out.players).length;
    } catch (error) {
        Logger.error("PlayerRegistry", "Validation failed", error);
        return JSON.parse(JSON.stringify(def));
    }
    return out;
}

export class PlayerRegistry {
    static #initialized = false;
    /** Phase 1 Fix: O(1) lookup map for online players (id -> Player). */
    static #onlineIndex = new Map();

    static db() {
        return Database.collection(COLLECTION, DEFAULT_REGISTRY, { validate: validateRegistry });
    }

    static initialize() {
        if (this.#initialized) return;
        this.#initialized = true;
        this.db();
        DisposableRegistry.initialize();

        // Single playerSpawn subscriber handling both touch and online index.
        BedrockCompat.subscribe("player.spawn.after", "PlayerRegistry.playerSpawn", event => {
            if (!event.initialSpawn) return;
            const player = event.player;
            if (player?.id) {
                this.#onlineIndex.set(player.id, player);
                DisposableRegistry.firePlayerJoin(player.id);
            }
            system.runTimeout(async () => {
                if (player) {
                    this.touch(player);
                    try {
                        await this.checkOfflineQueues(player);
                    } catch (error) {
                        Logger.debug("PlayerRegistry", `checkOfflineQueues failed in spawn timeout for ${player?.name || "unknown"}`, error);
                    }
                }
            }, 40);
        }, { required: true });

        BedrockCompat.subscribe("player.leave.after", "PlayerRegistry.playerLeave", event => {
            const playerId = event.playerId;
            if (!playerId) return;
            this.#onlineIndex.delete(playerId);
            DisposableRegistry.firePlayerLeave(playerId);
            Logger.debug("PlayerRegistry", `Player left: ${playerId}`);
        }, { required: true });

        for (const player of world.getAllPlayers()) {
            this.touch(player);
            if (player.id) {
                this.#onlineIndex.set(player.id, player);
                DisposableRegistry.firePlayerJoin(player.id);
            }
        }

        Logger.startup("PlayerRegistry", `Initialized with ${this.#onlineIndex.size} online players`);
    }
    
    // Process anything queued for the player while they were offline
    static async checkOfflineQueues(player) {
        if (!player || !player.id) return;
        
        // Phase 4 Stability: Lazy-load NotificationService to break circular dependency.
        try {
            const NotificationService = await getNotificationService();
            if (!NotificationService) return;
            
            // Check notifications
            const unreadCount = NotificationService.unreadCount(player.id);
            if (unreadCount > 0) {
                try {
                    player.sendMessage(`${CONFIG.PREFIX}§aWelcome back! You have §e${unreadCount}§a unread notifications.`);
                    player.playSound("random.orb");
                } catch (error) {
                    Logger.debug("PlayerRegistry", `Notification display failed for ${player.name}`, error);
                }
            }
        } catch (error) {
            Logger.debug("PlayerRegistry", `checkOfflineQueues failed for ${player?.name || "unknown"}`, error);
        }
        
        // Payouts and mailboxes are handled when the player opens the UI,
        // no need to force them to process here, just notifying is enough.
    }

    static touch(player) {
        if (!player?.id) return false;
        const db = this.db();
        const now = Date.now();
        const existing = db.players[player.id];
        
        const tags = this.#safeTags(player);
        // Phase 5: Sanitize player name to prevent §-injection in stored data.
        const safeName = Sanitizer.sanitizeName(player.name, 32);
        
        db.players[player.id] = {
            id: player.id,
            name: safeName,
            firstSeen: existing?.firstSeen || now,
            lastSeen: now,
            lastDimension: player.dimension?.id || existing?.lastDimension || "",
            tags: tags
        };

        // Phase 5 Fix: O(1) fast path for the common case.
        //
        // PROBLEM (pre-Phase 5):
        //   `db.order = (db.order || []).filter(id => id !== player.id)`
        //   was O(N) on EVERY touch — it allocated a new array and
        //   scanned all entries. With 10,000 players and frequent
        //   touches (every 5 minutes for all online players), this was
        //   a significant allocation + scan cost.
        //
        // SOLUTION (Phase 5):
        //   Fast path: if the player is already at the END of `order`
        //   (the common case — a player who touches repeatedly), skip
        //   the filter entirely. This is O(1) and handles the vast
        //   majority of touches.
        //
        //   Slow path: only if the player is NOT at the end, we need to
        //   remove them from their current position. We use `indexOf`
        //   + `splice` which is still O(N) worst case but:
        //     1. Only runs when the player's position changed (rare)
        //     2. `indexOf` breaks early when found (average < N/2)
        //     3. `splice` is O(N) but only shifts elements after the
        //        found index
        //     4. No new array allocation (splice mutates in place)
        if (!Array.isArray(db.order)) db.order = [];
        const orderLen = db.order.length;
        if (orderLen === 0 || db.order[orderLen - 1] !== player.id) {
            // Player is not at the end — need to move them.
            const idx = db.order.indexOf(player.id);
            if (idx >= 0) {
                // Player exists somewhere in the middle — remove from
                // current position. splice is O(N-idx) for the shift,
                // but avoids allocating a new array.
                db.order.splice(idx, 1);
            }
            // Append to end (most recently seen).
            db.order.push(player.id);
        }
        // else: player is already at the end — no work needed.

        while (db.order.length > MAX_PLAYERS) {
            const old = db.order.shift();
            delete db.players[old];
        }
        
        // Phase 8: order is maintained as the authoritative bounded list, so
        // avoid Object.keys(db.players).length on every touch.
        db.stats.totalSeen = db.order.length;
        db.stats.lastUpdated = now;
        return true;
    }

    static get(playerId) {
        return this.db().players[playerId] || null;
    }

    static all() {
        const db = this.db();
        return (db.order || []).map(id => db.players[id]).filter(Boolean);
    }

    /**
     * Phase 1 Fix: O(1) lookup of an online player by id.
     * Returns the Player object or null.
     */
    static getOnlineById(playerId) {
        if (!playerId) return null;
        const player = this.#onlineIndex.get(playerId);
        if (!player) return null;
        // Defensive: ensure the player is still valid (not in disconnect state)
        try {
            if (!this.#isPlayerValid(player)) {
                this.#onlineIndex.delete(playerId);
                return null;
            }
        } catch (error) {
            Logger.debug("PlayerRegistry", `isValid check failed for ${playerId}`, error);
        }
        return player;
    }

    /**
     * Phase 1 Fix: Returns the live online player index (Map).
     * Use this instead of `world.getAllPlayers()` when you only need to iterate
     * online players, since this Map is maintained incrementally and avoids
     * allocating a new array on every call.
     */
    static onlineMap() {
        return this.#onlineIndex;
    }

    static online() {
        // Prefer the maintained index; fall back to world API if needed.
        if (this.#onlineIndex.size > 0) {
            const out = [];
            for (const p of this.#onlineIndex.values()) {
                try {
                    if (!this.#isPlayerValid(p)) continue;
                } catch (error) {
                    Logger.debug("PlayerRegistry", `isValid check failed during online() iteration`, error);
                    continue;
                }
                out.push(p);
            }
            if (out.length) return out;
        }
        try { return world.getAllPlayers(); } catch { return []; }
    }

    static findOnlineByName(name) {
        const n = String(name || "").toLowerCase();
        for (const p of this.#onlineIndex.values()) {
            try {
                if (p.name?.toLowerCase() === n) return p;
            } catch (error) {
                Logger.debug("PlayerRegistry", `Name check failed during findOnlineByName`, error);
            }
        }
        // Fallback: in case index is out of sync (e.g., just-after-reload)
        try {
            return world.getAllPlayers().find(p => p.name.toLowerCase() === n) || null;
        } catch { return null; }
    }

    /**
     * Phase 1 Fix: O(1) helper used by Finance/Contracts/Notifications
     * instead of `world.getAllPlayers().find(p => p.id === id)`.
     */
    static findOnlineById(playerId) {
        return this.getOnlineById(playerId);
    }

    static shutdown() {
        SubscriptionRegistry.disposePrefix("PlayerRegistry.");
        this.#onlineIndex.clear();
        Database.save(COLLECTION);
        this.#initialized = false;
    }

    static #isPlayerValid(player) {
        try {
            if (!player) return false;
            if (typeof player.isValid === "boolean") return player.isValid;
            if (typeof player.isValid === "function") return !!player.isValid();
            return true;
        } catch {
            return false;
        }
    }

    static #safeTags(player) {
        try {
            if (typeof player.getTags === "function") return player.getTags().slice(0, 50);
        } catch (error) {
            Logger.debug("PlayerRegistry", `getTags failed for ${player?.name || "unknown"}`, error);
        }
        return [];
    }
}

export default PlayerRegistry;