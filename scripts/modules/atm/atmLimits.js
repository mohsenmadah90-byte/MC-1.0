// MCity Dashboard V2 - ATM Player Limits

import { world } from "@minecraft/server";
import { CONFIG } from "../../config.js";
import { PlayerRegistry } from "../../core/playerRegistry.js";
import { RuntimeHandleRegistry } from "../../core/runtimeHandleRegistry.js";

const AIC = CONFIG.ATM_INFO;
const AC = CONFIG.ATM;

export class ATMLimits {
    static #intervalId = null;
    static #resetJobId = null;

    static resetKey(combo) { return `mcity2_atm_limit_${combo}`; }
    static lastResetKey() { return "mcity2_atm_last_reset"; }

    static initPlayer(player) {
        try {
            const last = Number(player.getDynamicProperty(this.lastResetKey()) || 0);
            if (!last || Date.now() - last >= AC.RESET_INTERVAL_TICKS * 50) this.resetPlayer(player);
        } catch {}
    }

    static resetPlayer(player) {
        try {
            for (const combo of Object.keys(AIC.EXCHANGE_LIMITS || {})) player.setDynamicProperty(this.resetKey(combo), 0);
            player.setDynamicProperty(this.lastResetKey(), Date.now());
            return true;
        } catch { return false; }
    }

    static lastReset(player) { try { this.initPlayer(player); return Number(player.getDynamicProperty(this.lastResetKey()) || 0); } catch { return 0; } }
    static nextReset(player) { const last = this.lastReset(player); return last ? last + AC.RESET_INTERVAL_TICKS * 50 : 0; }
    static secondsToReset(player) { const next = this.nextReset(player); return next ? Math.max(0, Math.ceil((next - Date.now()) / 1000)) : 0; }
    static used(player, combo) { try { this.initPlayer(player); return Number(player.getDynamicProperty(this.resetKey(combo)) || 0); } catch { return 0; } }
    static limit(combo) { return AIC.EXCHANGE_LIMITS?.[combo] ?? 0; }
    static remaining(player, combo) { return Math.max(0, this.limit(combo) - this.used(player, combo)); }
    static canExchange(player, combo, qty) { return this.remaining(player, combo) >= qty; }
    static addUsed(player, combo, qty) { try { this.initPlayer(player); const expected=this.used(player,combo)+qty; player.setDynamicProperty(this.resetKey(combo),expected); return Number(player.getDynamicProperty(this.resetKey(combo))||0)===expected; } catch { return false; } }

    static resetAllOnline() {
        if (this.#resetJobId !== null) return { queued: false, reason: "already_running" };
        const players = [...PlayerRegistry.online()]; const self = this;
        function* resetJob() {
            try { for (const player of players) { self.resetPlayer(player); yield; }
                if (AC.BROADCAST_RESET) try { world.sendMessage?.(CONFIG.PREFIX + "§eATM exchange limits have been reset."); } catch {}
            } finally { self.#resetJobId = null; }
        }
        this.#resetJobId = RuntimeHandleRegistry.job("ATMLimits.resetBatch", resetJob());
        return { queued: true, players: players.length };
    }

    static startLoop(systemRef = null) {
        void systemRef;
        if (this.#intervalId) return this.#intervalId;
        this.#intervalId = RuntimeHandleRegistry.interval("ATMLimits.reset", () => this.resetAllOnline(), AC.RESET_INTERVAL_TICKS);
        return this.#intervalId;
    }

    static stopLoop(systemRef = null) {
        void systemRef;
        if (this.#intervalId) { RuntimeHandleRegistry.clear(this.#intervalId); this.#intervalId = null; }
        if (this.#resetJobId !== null) { RuntimeHandleRegistry.clear(this.#resetJobId); this.#resetJobId = null; }
    }
}

export default ATMLimits;
