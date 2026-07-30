// MCity Dashboard V2 - Mine Phone battery/session service (phase 2.1).
import { world } from "@minecraft/server";
import { CONFIG } from "../config.js";
import { CustomItemRegistry } from "./customItemRegistry.js";
import { RuntimeHandleRegistry } from "./runtimeHandleRegistry.js";
import { DisposableRegistry } from "./disposableRegistry.js";

const BATTERY_KEY = "mcity_phone_battery";
const FLASHLIGHT_KEY = "mcity_phone_flashlight";
const LAST_KEY = "mcity_phone_last_active";
const MAX_SECONDS = 20 * 60;
const sessions = new Set();
let intervalId = null;

export class MinePhoneService {
    static initialize() {
        if (intervalId !== null) return;
        intervalId = RuntimeHandleRegistry.interval("MinePhone.battery", () => this.tick(), 20);
        DisposableRegistry.registerShutdownCleanup("MinePhone.battery", () => this.shutdown());
    }
    static shutdown() { if (intervalId !== null) RuntimeHandleRegistry.clear(intervalId); intervalId = null; sessions.clear(); }
    static begin(player) { if (!player) return; this.ensure(player); sessions.add(player.id); }
    static end(player) { if (player) sessions.delete(player.id); }
    static ensure(player) { try { if (player.getDynamicProperty(BATTERY_KEY) === undefined) player.setDynamicProperty(BATTERY_KEY, 100); if (player.getDynamicProperty(LAST_KEY) === undefined) player.setDynamicProperty(LAST_KEY, Date.now()); } catch {} }
    static battery(player) { try { this.ensure(player); return Math.max(0, Math.min(100, Number(player.getDynamicProperty(BATTERY_KEY) ?? 100))); } catch { return 0; } }
    static flashlight(player) { try { return player.getDynamicProperty(FLASHLIGHT_KEY) === true; } catch { return false; } }
    static toggleFlashlight(player) { const next = !this.flashlight(player); try { player.setDynamicProperty(FLASHLIGHT_KEY, next); } catch {} return next; }
    static tick() {
        const now = Date.now();
        for (const id of [...sessions]) {
            const player = world.getAllPlayers().find(p => p.id === id);
            if (!player) { sessions.delete(id); continue; }
            try {
                this.ensure(player); const last = Number(player.getDynamicProperty(LAST_KEY) || now); const elapsed = Math.max(0, now - last);
                if (elapsed < 1000) continue;
                const drain = elapsed / (MAX_SECONDS * 1000) * (this.flashlight(player) ? 2 : 1);
                const next = Math.max(0, this.battery(player) - drain * 100);
                player.setDynamicProperty(BATTERY_KEY, next); player.setDynamicProperty(LAST_KEY, now);
                if (next <= 0) sessions.delete(id);
            } catch { sessions.delete(id); }
        }
    }
}

export default MinePhoneService;
