// MCity Dashboard V2 - Disposable Registry
// Phase 1 Critical Fix: Centralized resource cleanup for player leave / shutdown.
//
// Many services hold per-player state (caches, intervals, weak refs) that must
// be cleared when the player leaves to avoid memory leaks on long-running
// servers with high player churn.
//
// Usage:
//   DisposableRegistry.registerPlayerCleanup("MoneyService", (playerId) => {
//       this.#balanceCache.delete(playerId);
//   });
//
// On playerLeave, DisposableRegistry.firePlayerLeave(playerId) is called,
// which invokes every registered cleanup callback in registration order.
// Failures in one callback do not block subsequent ones.

import { Logger } from "./logger.js";

export class DisposableRegistry {
    /** @type {Array<{id: string, callback: (playerId: string) => void}>} */
    static #playerCleanups = [];
    /** @type {Array<{id: string, callback: () => void}>} */
    static #shutdownCleanups = [];
    static #initialized = false;
    static #knownPlayers = new Set();

    static initialize() {
        if (this.#initialized) return;
        this.#initialized = true;
        Logger.startup("DisposableRegistry", "Initialized");
    }

    /**
     * Register a callback to be invoked when a player leaves the world.
     * The callback receives the player's id (string).
     */
    static registerPlayerCleanup(id, callback) {
        if (typeof callback !== "function") {
            Logger.warn("DisposableRegistry", `Invalid cleanup callback for '${id}'`);
            return false;
        }
        // De-duplicate by id — last registration wins.
        this.#playerCleanups = this.#playerCleanups.filter(c => c.id !== id);
        this.#playerCleanups.push({ id, callback });
        return true;
    }

    /**
     * Register a callback to be invoked on full shutdown.
     */
    static registerShutdownCleanup(id, callback) {
        if (typeof callback !== "function") return false;
        this.#shutdownCleanups = this.#shutdownCleanups.filter(c => c.id !== id);
        this.#shutdownCleanups.push({ id, callback });
        return true;
    }

    /**
     * Called by main.js playerLeave subscription. Invokes every registered
     * cleanup in order. Errors are logged but do not abort the chain.
     */
    static firePlayerLeave(playerId) {
        if (!playerId) return;
        this.#knownPlayers.delete(playerId);
        for (const entry of this.#playerCleanups) {
            try {
                entry.callback(playerId);
            } catch (error) {
                Logger.warn(
                    "DisposableRegistry",
                    `Player cleanup '${entry.id}' failed for ${playerId}`,
                    error
                );
            }
        }
    }

    /**
     * Called by main.js playerSpawn subscription. Tracks online players so
     * shutdown() can fire leave events for any still-tracked players.
     */
    static firePlayerJoin(playerId) {
        if (!playerId) return;
        this.#knownPlayers.add(playerId);
    }

    /**
     * Shutdown hook — fires leave cleanup for every still-tracked player,
     * then runs all shutdown cleanups.
     */
    static shutdown() {
        // Fire leave for any players that didn't get a clean leave event
        // (e.g., world unload without per-player leave events).
        for (const playerId of [...this.#knownPlayers]) {
            this.firePlayerLeave(playerId);
        }
        this.#knownPlayers.clear();

        for (const entry of this.#shutdownCleanups) {
            try {
                entry.callback();
            } catch (error) {
                Logger.warn(
                    "DisposableRegistry",
                    `Shutdown cleanup '${entry.id}' failed`,
                    error
                );
            }
        }
        this.#shutdownCleanups = [];
        this.#playerCleanups = [];
        this.#initialized = false;
        Logger.info("DisposableRegistry", "Shutdown complete");
    }

    static stats() {
        return {
            registeredPlayerCleanups: this.#playerCleanups.length,
            registeredShutdownCleanups: this.#shutdownCleanups.length,
            trackedPlayers: this.#knownPlayers.size
        };
    }
}

export default DisposableRegistry;
