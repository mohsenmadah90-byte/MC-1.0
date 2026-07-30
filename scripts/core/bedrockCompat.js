// MCity Dashboard V2 - Bedrock Script API Compatibility Matrix
// Phase 1.3 target: @minecraft/server 2.1.0, @minecraft/server-ui 2.0.0.

import { system, world } from "@minecraft/server";
import { Logger } from "./logger.js";
import { SubscriptionRegistry } from "./subscriptionRegistry.js";

const ROOTS = { system, world };

const FEATURES = Object.freeze({
    "system.shutdown": { path: "system.beforeEvents.shutdown", targetSupported: true, required: true },
    "world.load": { path: "world.afterEvents.worldLoad", targetSupported: true, required: false },
    "player.spawn.after": { path: "world.afterEvents.playerSpawn", targetSupported: true, required: true },
    "player.leave.after": { path: "world.afterEvents.playerLeave", targetSupported: true, required: true },
    "player.craft.after": { path: "world.afterEvents.playerCraftItem", targetSupported: true, required: false },
    "item.use.before": { path: "world.beforeEvents.itemUse", targetSupported: true, required: false },
    "item.use.after": { path: "world.afterEvents.itemUse", targetSupported: true, required: false },
    "block.break.before": { path: "world.beforeEvents.playerBreakBlock", targetSupported: true, required: false },
    "block.interact.before": { path: "world.beforeEvents.playerInteractWithBlock", targetSupported: true, required: false },
    "block.interact.after": { path: "world.afterEvents.playerInteractWithBlock", targetSupported: true, required: false },
    "explosion.before": { path: "world.beforeEvents.explosion", targetSupported: true, required: false },
    "block.place.before": { path: "world.beforeEvents.playerPlaceBlock", targetSupported: false, required: false, fallback: "block.place.after", fallbackMode: "compensating" },
    "block.place.after": { path: "world.afterEvents.playerPlaceBlock", targetSupported: true, required: false },
    "entity.hurt.before": { path: "world.beforeEvents.entityHurt", targetSupported: false, required: false, fallback: "entity.hurt.after" },
    "entity.hurt.after": { path: "world.afterEvents.entityHurt", targetSupported: true, required: false },
    "piston.activate.before": { path: "world.beforeEvents.pistonActivate", targetSupported: false, required: false, fallback: "piston.activate.after", fallbackMode: "detective" },
    "piston.activate.after": { path: "world.afterEvents.pistonActivate", targetSupported: true, required: false },
    "item.useOn.before": { path: "world.beforeEvents.itemUseOn", targetSupported: false, required: false, fallback: "item.use.before", fallbackMode: "conservative" },
    "world.unload.after": { path: "world.afterEvents.worldUnload", targetSupported: false, required: false, fallback: "system.shutdown" }
});

export class BedrockCompat {
    static SERVER_API_VERSION = "2.1.0";
    static SERVER_UI_API_VERSION = "2.0.0";
    static #missingWarnings = new Set();

    static featureDefinition(id) {
        const def = FEATURES[id];
        return def ? { id, ...def } : null;
    }

    static featureIds() { return Object.keys(FEATURES); }

    static signal(id) {
        const def = FEATURES[id];
        if (!def) return null;
        const parts = def.path.split(".");
        let value = ROOTS[parts.shift()];
        try {
            for (const part of parts) value = value?.[part];
            return value && typeof value.subscribe === "function" ? value : null;
        } catch {
            return null;
        }
    }

    static subscribe(featureId, subscriptionId, callback, options = {}) {
        const def = FEATURES[featureId];
        if (!def) {
            Logger.error("BedrockCompat", `Unknown feature '${featureId}' requested by ${subscriptionId}`);
            return null;
        }
        const signal = this.signal(featureId);
        if (!signal) {
            const required = options.required ?? def.required;
            const warningKey = `${featureId}:${subscriptionId}`;
            if (!this.#missingWarnings.has(warningKey)) {
                this.#missingWarnings.add(warningKey);
                const fallback = def.fallback ? ` Fallback: ${def.fallback}.` : "";
                const message = `Feature '${featureId}' (${def.path}) unavailable for '${subscriptionId}'.${fallback}`;
                if (required) Logger.error("BedrockCompat", message);
                else Logger.warn("BedrockCompat", message);
            }
            return null;
        }
        return SubscriptionRegistry.subscribe(subscriptionId, signal, callback);
    }

    static report() {
        const features = this.featureIds().map(id => {
            const def = FEATURES[id];
            const runtimeAvailable = !!this.signal(id);
            return {
                id,
                path: def.path,
                targetSupported: !!def.targetSupported,
                runtimeAvailable,
                required: !!def.required,
                fallback: def.fallback || "",
                fallbackMode: def.fallbackMode || "",
                status: runtimeAvailable ? "available" : (def.targetSupported ? "missing_required_api" : "unsupported_on_target")
            };
        });
        const missingRequired = features.filter(f => f.required && !f.runtimeAvailable);
        const unavailableProtection = features.filter(f => [
            "block.place.before", "entity.hurt.before", "piston.activate.before", "item.useOn.before"
        ].includes(f.id) && !f.runtimeAvailable);
        return {
            serverApiVersion: this.SERVER_API_VERSION,
            serverUiApiVersion: this.SERVER_UI_API_VERSION,
            healthy: missingRequired.length === 0,
            missingRequired,
            unavailableProtection,
            features
        };
    }

    static logStartupReport() {
        const report = this.report();
        if (report.healthy) Logger.startup("BedrockCompat", `Required API features available for server ${this.SERVER_API_VERSION}`);
        else Logger.error("BedrockCompat", `Missing ${report.missingRequired.length} required API feature(s)`, report.missingRequired);
        for (const feature of report.unavailableProtection) {
            Logger.warn("BedrockCompat", `Protection capability unavailable on target API: ${feature.id}${feature.fallback ? `; fallback=${feature.fallback}` : ""}`);
        }
        return report;
    }

    static reset() {
        this.#missingWarnings.clear();
    }
}

export default BedrockCompat;
