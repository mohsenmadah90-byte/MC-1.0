// MCity Dashboard V2 - Central Logger
// Phase 5: Release Polish

import { CONFIG } from "../config.js";

const LEVEL_ORDER = { debug: 0, info: 1, warn: 2, error: 3, none: 99 };

export class Logger {
    static #level = CONFIG.DEBUG?.LOG_LEVEL || "info";
    static #history = [];
    static #maxHistory = 300;

    static setLevel(level) {
        if (LEVEL_ORDER[level] === undefined) return false;
        this.#level = level;
        return true;
    }
    
    static getLevel() {
        return this.#level;
    }

    static shouldLog(level) {
        return LEVEL_ORDER[level] >= LEVEL_ORDER[this.#level];
    }

    static #line(scope, level, message) {
        return `§6[MCity ${scope}] ${this.#color(level)}${message}`;
    }

    static #color(level) {
        if (level === "error") return "§c";
        if (level === "warn") return "§e";
        if (level === "debug") return "§8";
        return "§f"; // info
    }

    static #remember(scope, level, message, meta = null) {
        this.#history.push({ time: Date.now(), scope, level, message: String(message), meta: this.#safeMeta(meta) });
        if (this.#history.length > this.#maxHistory) this.#history = this.#history.slice(-this.#maxHistory);
    }

    static #safeMeta(meta) {
        if (meta === null || meta === undefined) return null;
        try {
            const json = JSON.stringify(meta);
            return json.length > 1000 ? { truncated: true, preview: json.slice(0, 1000) } : JSON.parse(json);
        } catch {
            return { unserializable: true };
        }
    }

    static debug(scope, message, meta = null) {
        this.#remember(scope, "debug", message, meta);
        if (this.shouldLog("debug")) console.warn(this.#line(scope, "debug", message), meta ?? ""); // Using warn for bedrock console visibility if debug is forced
    }

    static info(scope, message, meta = null) {
        this.#remember(scope, "info", message, meta);
        if (this.shouldLog("info")) console.warn(this.#line(scope, "info", message), meta ?? "");
    }

    static warn(scope, message, meta = null) {
        this.#remember(scope, "warn", message, meta);
        if (this.shouldLog("warn")) console.warn(this.#line(scope, "warn", message), meta ?? "");
    }

    static error(scope, message, error = null) {
        this.#remember(scope, "error", message, error ? { message: error.message, stack: error.stack } : null);
        if (this.shouldLog("error")) console.error(this.#line(scope, "error", message), error ?? "");
    }

    static history(limit = 50, level = null) {
        let list = [...this.#history];
        if (level) list = list.filter(e => e.level === level);
        return list.slice(-Math.max(1, Math.min(200, limit))).reverse();
    }

    // Startup is always logged regardless of level so server owners know it's working
    static startup(scope, message) {
        this.#remember(scope, "info", message, null);
        console.warn(`§6[MCity ${scope}] §a${message}`);
    }
}

export default Logger;