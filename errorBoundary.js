// MCity Dashboard V2 - Async/UI Error Boundary
// Phase 1.4: gives every surfaced runtime failure a short traceable error id.

import { CONFIG } from "../config.js";
import { Logger } from "./logger.js";

export class ErrorBoundary {
    static #counter = 0;

    static nextId(scope = "runtime") {
        this.#counter = (this.#counter + 1) % 1_000_000;
        const clean = String(scope || "runtime").replace(/[^a-z0-9]/gi, "").substring(0, 10).toUpperCase() || "RUNTIME";
        return `${clean}-${Date.now().toString(36).toUpperCase()}-${this.#counter.toString(36).toUpperCase()}`;
    }

    static report(scope, error, options = {}) {
        const id = this.nextId(scope);
        const message = String(options.message || error?.message || error || "Unknown runtime error").substring(0, 240);
        const context = { errorId: id, ...(options.context || {}) };
        if (options.level === "debug") Logger.debug(scope, `[${id}] ${message}`, context);
        else if (options.level === "warn") Logger.warn(scope, `[${id}] ${message}`, { ...context, error: error?.stack || String(error || "") });
        else Logger.error(scope, `[${id}] ${message}`, error instanceof Error ? error : new Error(message));

        if (options.player && options.notify !== false) {
            try {
                options.player.sendMessage(CONFIG.PREFIX + `§cAn error occurred. Reference: §f${id}`);
            } catch {}
        }
        return id;
    }

    static async guard(scope, callback, options = {}) {
        try {
            return await callback();
        } catch (error) {
            this.report(scope, error, options);
            return options.fallback;
        }
    }
}

export default ErrorBoundary;
