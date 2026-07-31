// MCity Dashboard V2 - Hot Reload Support
// Phase 5 Polish: Persist runtime state across script reloads so that
// developers can iterate without losing player session data.
//
// In Bedrock, when a behavior pack is reloaded (e.g., via /reload), the
// script runtime is torn down and rebuilt. Dynamic Properties persist
// across reloads (they're stored in the world save), but in-memory state
// like caches, interval IDs, and transient flags are lost.
//
// This module provides a small key-value store backed by a single
// Dynamic Property. Services can save and restore arbitrary JSON-able
// state. On startup, HotReload.detectReload() returns true if a previous
// instance saved state, allowing services to take a "warm start" path
// instead of a cold boot.
//
// Usage:
//   // On startup
//   if (HotReload.detectReload()) {
//       const saved = HotReload.restore("MoneyService");
//       if (saved) this.#balanceCache = new Map(saved.balanceCacheEntries);
//   }
//
//   // On shutdown (or periodically)
//   HotReload.save("MoneyService", {
//       balanceCacheEntries: [...this.#balanceCache.entries()]
//   });

import { world } from "@minecraft/server";
import { Logger } from "./logger.js";
import { DisposableRegistry } from "./disposableRegistry.js";

const HOT_RELOAD_KEY = "mcity2:__hot_reload_state";
const HOT_RELOAD_MARKER_KEY = "mcity2:__hot_reload_marker";

export class HotReload {
    static #initialized = false;
    /** Cached snapshot of saved state, populated on initialize(). */
    static #state = {};
    /** True if a previous instance saved state before this one started. */
    static #wasReload = false;
    /** Set to true once save() has been called at least once. */
    static #dirty = false;

    static initialize() {
        if (this.#initialized) return;
        this.#initialized = true;
        this.#detectAndLoad();
        // Register a shutdown cleanup so state is saved on world unload.
        DisposableRegistry.registerShutdownCleanup("HotReload.save", () => {
            this.flush();
            this.#initialized = false;
        });
        Logger.startup("HotReload", `Initialized (wasReload=${this.#wasReload}, ${Object.keys(this.#state).length} keys restored)`);
    }

    /**
     * Returns true if a previous script instance saved hot-reload state.
     * Services can use this to skip expensive re-computation on warm start.
     */
    static wasReload() {
        return this.#wasReload;
    }

    /**
     * Save a value under `key`. The value must be JSON-serializable.
     * The state is NOT immediately flushed to disk — call `flush()` to
     * persist, or rely on the shutdown cleanup to flush.
     */
    static save(key, value) {
        if (!key) return false;
        try {
            // Test serializability before storing.
            JSON.stringify(value);
            this.#state[key] = value;
            this.#dirty = true;
            return true;
        } catch (error) {
            Logger.warn("HotReload", `Cannot serialize value for key '${key}'`, error);
            return false;
        }
    }

    /**
     * Restore a previously-saved value. Returns undefined if not found.
     * Does NOT remove the value — call clear(key) to do that.
     *
     * Phase 5 Fix: Returns a deep copy, not a live reference.
     *
     * PROBLEM (pre-Phase 5):
     *   `restore` returned `this.#state[key]` — the LIVE reference to
     *   the internal state object. Callers that mutated the returned
     *   value were silently mutating `#state` itself. This was a
     *   footgun: a caller that did `const cfg = HotReload.restore("X");
     *   cfg.foo = "bar";` would change the persisted state without
     *   calling `save()`, and the change would be flushed on next
     *   `flush()` — potentially overwriting a newer value saved by
     *   another caller.
     *
     * SOLUTION (Phase 5):
     *   `restore` now returns a deep copy via `JSON.parse(JSON.stringify())`.
     *   Callers can freely mutate the returned value without affecting
     *   internal state. To persist changes, they must call `save()` as
     *   intended.
     *
     *   The deep copy is O(N) in the size of the value, but this is
     *   acceptable because:
     *     1. `restore` is typically called once at startup (warm start).
     *     2. Hot-reload state values are small (caches, flags).
     *     3. The safety benefit outweighs the copy cost.
     */
    static restore(key) {
        const value = this.#state[key];
        if (value === undefined) return undefined;
        try {
            return JSON.parse(JSON.stringify(value));
        } catch (error) {
            Logger.warn("HotReload", `Failed to deep-copy restored value for key '${key}' — returning undefined to prevent aliasing`, error);
            return undefined;
        }
    }

    /**
     * Remove a key from the saved state.
     */
    static clear(key) {
        if (key in this.#state) {
            delete this.#state[key];
            this.#dirty = true;
        }
    }

    /**
     * Flush the current state to a Dynamic Property. Called automatically
     * on shutdown, but services can call it manually after a batch of
     * updates if they want to be extra safe.
     */
    static flush() {
        if (!this.#dirty && Object.keys(this.#state).length === 0) return;
        try {
            // Set the marker first — this is what detectReload() checks on
            // the next startup. If we crash between setting the marker and
            // writing the state, the next startup will see the marker but
            // no state, and treat it as a cold boot (safe).
            world.setDynamicProperty(HOT_RELOAD_MARKER_KEY, Date.now());
            const json = JSON.stringify({
                version: 1,
                savedAt: Date.now(),
                state: this.#state
            });
            world.setDynamicProperty(HOT_RELOAD_KEY, json);
            this.#dirty = false;
        } catch (error) {
            Logger.warn("HotReload", "Failed to flush state", error);
        }
    }

    /**
     * Clear all saved hot-reload state. Useful for admins who want to
     * force a cold boot on the next reload.
     */
    static reset() {
        this.#state = {};
        this.#dirty = true;
        try {
            world.setDynamicProperty(HOT_RELOAD_KEY, undefined);
            world.setDynamicProperty(HOT_RELOAD_MARKER_KEY, undefined);
        } catch {}
    }

    /**
     * Return a list of all saved keys (for debugging in the Health Check UI).
     */
    static listKeys() {
        return Object.keys(this.#state);
    }

    static stats() {
        let totalSize = 0;
        try { totalSize = JSON.stringify(this.#state).length; } catch {}
        return {
            initialized: this.#initialized,
            wasReload: this.#wasReload,
            keyCount: Object.keys(this.#state).length,
            dirty: this.#dirty,
            estimatedSizeBytes: totalSize
        };
    }

    /**
     * Internal: detect whether a previous instance saved state, and load
     * it if so. Called by initialize().
     */
    static #detectAndLoad() {
        try {
            const marker = world.getDynamicProperty(HOT_RELOAD_MARKER_KEY);
            if (typeof marker !== "number") {
                // No marker — this is a cold boot.
                this.#wasReload = false;
                this.#state = {};
                return;
            }
            // Marker exists — try to load the state.
            const raw = world.getDynamicProperty(HOT_RELOAD_KEY);
            if (typeof raw !== "string") {
                // Marker but no state — treat as cold boot but preserve marker.
                Logger.warn("HotReload", "Marker found but state missing — cold boot");
                this.#wasReload = false;
                this.#state = {};
                return;
            }
            const parsed = JSON.parse(raw);
            if (parsed && parsed.version === 1 && parsed.state) {
                this.#state = parsed.state;
                this.#wasReload = true;
                // Note: we do NOT clear the marker here. The marker is
                // cleared by reset() (admin action) or overwritten by the
                // next flush(). This way, if our initialize() crashes before
                // we get to flush(), the next reload still sees the previous
                // state (which may be slightly stale but is better than nothing).
            } else {
                Logger.warn("HotReload", `Unknown state version: ${parsed?.version}`);
                this.#wasReload = false;
                this.#state = {};
            }
        } catch (error) {
            Logger.warn("HotReload", "Failed to load saved state", error);
            this.#wasReload = false;
            this.#state = {};
        }
    }
}

export default HotReload;
