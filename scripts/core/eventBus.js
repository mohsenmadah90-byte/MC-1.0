// MCity Dashboard V2 - Event Bus
// Phase 4 Scalability: Decouple modules via a lightweight publish/subscribe
// event system. This reduces direct imports between services and makes it
// easier to add new behavior (e.g., analytics, webhooks) without touching
// the originating module.
//
// Events are dispatched synchronously, but each handler is wrapped in
// try/catch so a failure in one handler cannot prevent other handlers
// from running.
//
// Naming convention: `<module>.<action>` (e.g., `land.bought`,
// `market.sold`, `contract.completed`, `atm.exchange`).
//
// Usage:
//   // Subscribe (typically in initialize())
//   EventBus.on("land.bought", (event) => {
//       NotificationService.create(event.playerId, { ... });
//   });
//
//   // Emit (in the originating service)
//   EventBus.emit("land.bought", { playerId, claimId, price });
//
//   // Unsubscribe (typically in shutdown)
//   EventBus.off("land.bought", handler);

import { Logger } from "./logger.js";
import { DisposableRegistry } from "./disposableRegistry.js";
import { RuntimeHandleRegistry } from "./runtimeHandleRegistry.js";

export class EventBus {
    /** @type {Map<string, Set<Function>>} */
    static #handlers = new Map();
    /** @type {Map<Function, string>} reverse index for fast off() */
    static #handlerToTopics = new Map();
    static #initialized = false;
    /** Recent event history for debugging (limited). */
    static #history = [];
    static #maxHistory = 200;
    /** Per-topic counters for stats. */
    static #topicCounters = new Map();
    /** Phase 2 Performance: batch processing queue. */
    static #queue = [];
    static #processing = false;
    static #batchSize = 25;
    static #batchIntervalId = null;

    /**
     * Phase 4 Fix: Backpressure for the event queue.
     *
     * PROBLEM (pre-Phase 4):
     *   `#queue` was unbounded. With 20 TPS and batch size 25, max
     *   throughput is 500 events/sec. A sustained emit rate above this
     *   (e.g., a tight loop emitting thousands of events, or a misbehaving
     *   module) would grow the queue without bound, consuming memory
     *   until the server crashed or GC stalled.
     *
     * SOLUTION (Phase 4):
     *   1. `#maxQueueSize` caps the queue (default 10,000 — ~20 seconds
     *      of backlog at max throughput).
     *   2. When the queue is full, new events are DROPPED with a warning
     *      log. This is the "load shedding" pattern: it's better to drop
     *      events than to OOM the server.
     *   3. `#droppedCount` tracks total dropped events for stats/monitoring.
     *   4. `#droppedPerTopic` tracks drops per topic so admins can identify
     *      the misbehaving emitter.
     *   5. A warning is logged at most once per 60 seconds to avoid log
     *      spam during sustained overload.
     *
     *   Events dropped are NON-CRITICAL by design — EventBus is a
     *   decoupling layer for notifications, analytics, etc. The
     *   originating service has already committed its transaction; the
     *   event is just a "heads up" to subscribers. Dropping it is
     *   preferable to crashing the server.
     */
    static #maxQueueSize = 10000;
    static #droppedCount = 0;
    static #droppedPerTopic = new Map();
    static #lastDropWarning = 0;
    static #dropWarningIntervalMs = 60_000;  // warn at most once per 60s

    static initialize() {
        if (this.#initialized) return;
        this.#initialized = true;
        // Phase 2 Performance: process queued events every tick to spread
        // handler execution across multiple ticks and prevent lag spikes.
        this.#batchIntervalId = RuntimeHandleRegistry.interval("EventBus.batch", () => this.#processBatch(), 1);
        DisposableRegistry.registerShutdownCleanup("EventBus", () => {
            if (this.#batchIntervalId !== null) {
                RuntimeHandleRegistry.clear(this.#batchIntervalId);
                this.#batchIntervalId = null;
            }
            this.#handlers.clear();
            this.#handlerToTopics.clear();
            this.#history.length = 0;
            this.#topicCounters.clear();
            this.#queue = [];
            this.#processing = false;
            // Phase 4 Fix: Clear backpressure state.
            this.#droppedCount = 0;
            this.#droppedPerTopic.clear();
            this.#lastDropWarning = 0;
            this.#initialized = false;
        });
        Logger.startup("EventBus", "Initialized with batch processing");
    }

    /**
     * Phase 2 Performance: Process queued events in batches.
     * Each tick processes up to #batchSize events to prevent tick lag.
     */
    static #processBatch() {
        if (this.#processing || this.#queue.length === 0) return;
        this.#processing = true;
        const batch = this.#queue.splice(0, this.#batchSize);
        for (const { topic, event } of batch) {
            this.#dispatchSync(topic, event);
        }
        this.#processing = false;
    }

    static #dispatchSync(topic, event) {
        const set = this.#handlers.get(topic);
        if (!set || set.size === 0) return;
        const handlers = [...set];
        for (const handler of handlers) {
            try {
                handler(event);
            } catch (error) {
                Logger.warn("EventBus", `Handler for '${topic}' failed`, error);
            }
        }
    }

    /**
     * Subscribe to a topic. Returns the handler (for chaining).
     */
    static on(topic, handler) {
        if (!topic || typeof handler !== "function") return handler;
        if (!this.#handlers.has(topic)) this.#handlers.set(topic, new Set());
        this.#handlers.get(topic).add(handler);
        // Reverse index
        if (!this.#handlerToTopics.has(handler)) this.#handlerToTopics.set(handler, new Set());
        this.#handlerToTopics.get(handler).add(topic);
        return handler;
    }

    /**
     * Subscribe to a topic, but only fire once. Returns the wrapper handler.
     */
    static once(topic, handler) {
        if (!topic || typeof handler !== "function") return handler;
        const wrapper = (event) => {
            this.off(topic, wrapper);
            try { handler(event); } catch (error) {
                Logger.warn("EventBus", `once() handler for '${topic}' failed`, error);
            }
        };
        return this.on(topic, wrapper);
    }

    /**
     * Unsubscribe a specific handler from a topic (or from all topics if
     * topic is null/undefined).
     */
    static off(topic, handler) {
        if (!handler) return;
        if (topic) {
            const set = this.#handlers.get(topic);
            if (set) {
                set.delete(handler);
                if (set.size === 0) this.#handlers.delete(topic);
            }
            const topics = this.#handlerToTopics.get(handler);
            if (topics) {
                topics.delete(topic);
                if (topics.size === 0) this.#handlerToTopics.delete(handler);
            }
        } else {
            // Remove from all topics
            const topics = this.#handlerToTopics.get(handler);
            if (topics) {
                for (const t of topics) {
                    const set = this.#handlers.get(t);
                    if (set) {
                        set.delete(handler);
                        if (set.size === 0) this.#handlers.delete(t);
                    }
                }
                this.#handlerToTopics.delete(handler);
            }
        }
    }

    /**
     * Emit an event to all subscribers. Each handler is invoked
     * synchronously in registration order. Failures are logged but do not
     * prevent subsequent handlers from running.
     *
     * @param {string} topic
     * @param {any} event - payload, typically a plain object
     */
    static emit(topic, event = {}) {
        // Track counters and history for debugging.
        this.#topicCounters.set(topic, (this.#topicCounters.get(topic) || 0) + 1);
        this.#history.push({ time: Date.now(), topic, eventPreview: this.#preview(event) });
        if (this.#history.length > this.#maxHistory) this.#history.shift();

        // Phase 2 Performance: queue event for batch processing instead of
        // synchronous dispatch. This prevents handler cascades from blocking
        // the current tick when many events are emitted in rapid succession.
        const set = this.#handlers.get(topic);
        if (!set || set.size === 0) return;

        // Phase 4 Fix: Backpressure — drop event if queue is full.
        if (this.#queue.length >= this.#maxQueueSize) {
            this.#droppedCount++;
            this.#droppedPerTopic.set(topic, (this.#droppedPerTopic.get(topic) || 0) + 1);
            // Log at most once per #dropWarningIntervalMs to avoid spam.
            const now = Date.now();
            if (now - this.#lastDropWarning > this.#dropWarningIntervalMs) {
                this.#lastDropWarning = now;
                const topDropped = [...this.#droppedPerTopic.entries()]
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, 5)
                    .map(([t, c]) => `${t}(${c})`)
                    .join(", ");
                Logger.warn("EventBus", `Queue full (${this.#queue.length}/${this.#maxQueueSize}). Dropped ${this.#droppedCount} total events. Top dropped topics: ${topDropped}. Consider increasing batch size or reducing emit frequency.`);
            }
            return;
        }

        this.#queue.push({ topic, event });
    }

    /**
     * Remove all subscribers for a topic (or all topics if topic is null).
     */
    static clear(topic) {
        if (topic) {
            const set = this.#handlers.get(topic);
            if (set) {
                for (const h of set) {
                    const topics = this.#handlerToTopics.get(h);
                    if (topics) {
                        topics.delete(topic);
                        if (topics.size === 0) this.#handlerToTopics.delete(h);
                    }
                }
                this.#handlers.delete(topic);
            }
        } else {
            this.#handlers.clear();
            this.#handlerToTopics.clear();
        }
    }

    static stats() {
        let totalHandlers = 0;
        const topicStats = {};
        for (const [topic, set] of this.#handlers.entries()) {
            topicStats[topic] = set.size;
            totalHandlers += set.size;
        }
        return {
            topics: this.#handlers.size,
            totalHandlers,
            topicStats,
            historySize: this.#history.length,
            emitCounters: Object.fromEntries(this.#topicCounters.entries()),
            // Phase 4 Fix: Backpressure stats.
            queueLength: this.#queue.length,
            maxQueueSize: this.#maxQueueSize,
            queueUtilization: this.#queue.length / this.#maxQueueSize,
            droppedCount: this.#droppedCount,
            droppedPerTopic: Object.fromEntries(this.#droppedPerTopic.entries())
        };
    }

    static history(limit = 50) {
        return this.#history.slice(-Math.max(1, Math.min(this.#maxHistory, limit))).reverse();
    }

    static clearHistory() {
        this.#history.length = 0;
        this.#topicCounters.clear();
        this.#droppedCount = 0;
        this.#droppedPerTopic.clear();
    }

    static #preview(event) {
        try {
            const json = JSON.stringify(event);
            return json.length > 200 ? json.slice(0, 200) + "..." : json;
        } catch {
            return "[unserializable]";
        }
    }
}

export default EventBus;
