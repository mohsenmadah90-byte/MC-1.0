// MCity Dashboard V2 - Dashboard Entry System
// Phase 1: menu paper delivery, item-use opening, cooldown and recovery helpers.
// Phase 1 Critical Fix: Register cooldown map cleanup with DisposableRegistry.

import { world, system, Player, ItemStack } from "@minecraft/server";
import { CONFIG } from "../config.js";
import { Logger } from "../core/logger.js";
import { ItemUtils } from "../core/itemUtils.js";
import { DisposableRegistry } from "../core/disposableRegistry.js";
import { BedrockCompat } from "../core/bedrockCompat.js";
import { SubscriptionRegistry } from "../core/subscriptionRegistry.js";
import { RateLimiter } from "../core/rateLimiter.js";
import { ErrorBoundary } from "../core/errorBoundary.js";

const DC = CONFIG.DASHBOARD;

export class DashboardEntry {
    static #initialized = false;
    static #openHandler = null;
    static #lastOpen = new Map(); // playerId -> ms

    static initialize(openHandler) {
        if (this.#initialized) return;
        this.#initialized = true;
        this.#openHandler = typeof openHandler === "function" ? openHandler : null;

        this.#registerSpawnDelivery();
        this.#registerItemUseOpening();

        // Phase 1 Fix: Clean up cooldown map entry when player leaves.
        DisposableRegistry.registerPlayerCleanup("DashboardEntry.lastOpen", (playerId) => {
            this.#lastOpen.delete(playerId);
        });

        // If the script is reloaded while players are online, recover their menu item state.
        system.runTimeout(() => {
            try {
                for (const player of world.getAllPlayers()) this.ensureMenuItem(player, false);
            } catch (error) {
                Logger.warn("DashboardEntry", "Online player menu recovery failed", error);
            }
        }, 40);

        Logger.startup("DashboardEntry", "Menu item entry initialized");
    }

    static shutdown() {
        SubscriptionRegistry.disposePrefix("DashboardEntry.");
        this.#lastOpen.clear();
        this.#openHandler = null;
        this.#initialized = false;
    }

    static createMenuItem() {
        const item = new ItemStack(DC.ITEM_ID, 1);
        try { item.nameTag = DC.ITEM_DISPLAY_NAME; } catch {}
        try {
            item.setLore([
                "§7Use to open MCity Dashboard",
                "§8Commandless control center",
                "§8If lost, rename any paper to 'menu'"
            ]);
        } catch {}
        return item;
    }

    static isDashboardItem(item) {
        return ItemUtils.isNamedItem(item, DC.ITEM_ID, DC.ITEM_NAME) || ItemUtils.isNamedItem(item, DC.ITEM_ID, DC.ITEM_DISPLAY_NAME);
    }

    static getInventory(player) {
        try { return player.getComponent("minecraft:inventory")?.container || null; }
        catch { return null; }
    }

    static hasMenuItem(player) {
        const inv = this.getInventory(player);
        if (!inv) return false;
        for (let i = 0; i < inv.size; i++) {
            if (this.isDashboardItem(inv.getItem(i))) return true;
        }
        return false;
    }

    static ensureMenuItem(player, force = false) {
        if (!(player instanceof Player)) return false;
        if (!DC.ENABLED) return false;
        if (!DC.GIVE_ON_FIRST_JOIN && !force) return false;

        try {
            // Dashboard V2 is commandless, so access recovery is important:
            // if the player has no menu paper, give one when possible. The given
            // flag is informational and does not block recovery.
            if (this.hasMenuItem(player)) {
                player.setDynamicProperty(DC.GIVEN_PROPERTY, true);
                return true;
            }

            const inv = this.getInventory(player);
            if (!inv) return false;

            const leftover = inv.addItem(this.createMenuItem());
            if (leftover) {
                player.sendMessage(CONFIG.PREFIX + "§eYour inventory is full. Rename any paper to §fmenu §eto open MCity Dashboard.");
                return false;
            }

            player.setDynamicProperty(DC.GIVEN_PROPERTY, true);
            player.sendMessage(CONFIG.PREFIX + "§aYou received a §6MCity Menu§a paper. Use it to open Dashboard.");
            return true;
        } catch (error) {
            Logger.warn("DashboardEntry", `Failed to give menu item to ${player.name}`, error);
            return false;
        }
    }

    static resetGivenFlag(player) {
        try {
            player.setDynamicProperty(DC.GIVEN_PROPERTY, false);
            return true;
        } catch { return false; }
    }

    static openFromItem(player) {
        if (!(player instanceof Player)) return false;
        const now = Date.now();
        const last = this.#lastOpen.get(player.id) || 0;
        if (now - last < (DC.OPEN_COOLDOWN_MS || 700)) return false;
        this.#lastOpen.set(player.id, now);

        if (!this.#openHandler) {
            player.sendMessage(CONFIG.PREFIX + "§cDashboard is not ready yet.");
            return false;
        }

        const limit = CONFIG.RATE_LIMITS?.DASHBOARD_OPEN;
        const limitKey = `dashboard_open:${player.id}`;
        if (limit && !RateLimiter.check(limitKey, limit[0], limit[1])) {
            const retryMs = RateLimiter.retryIn(limitKey, limit[0], limit[1]);
            player.sendMessage(CONFIG.PREFIX + `§cDashboard open limit reached. Try again in ${Math.ceil(retryMs / 1000)}s.`);
            return false;
        }

        system.run(async () => {
            await ErrorBoundary.guard("DashboardEntry", () => this.#openHandler(player), {
                player,
                message: `Open handler failed for ${player.name}`
            });
        });
        return true;
    }

    static #registerSpawnDelivery() {
        BedrockCompat.subscribe("player.spawn.after", "DashboardEntry.playerSpawn", event => {
            if (!event.initialSpawn) return;
            system.runTimeout(() => this.ensureMenuItem(event.player, false), 50);
        }, { required: true });
    }

    static #registerItemUseOpening() {
        if (BedrockCompat.signal("item.use.before")) {
            BedrockCompat.subscribe("item.use.before", "DashboardEntry.itemUseBefore", event => {
                const player = event.source;
                if (!(player instanceof Player)) return;
                if (!this.isDashboardItem(event.itemStack)) return;
                event.cancel = true;
                this.openFromItem(player);
            });
            Logger.info("DashboardEntry", "Using compatible item.use.before for menu opening");
            return;
        }

        const id = BedrockCompat.subscribe("item.use.after", "DashboardEntry.itemUseAfter", event => {
            const player = event.source;
            if (!(player instanceof Player)) return;
            if (!this.isDashboardItem(event.itemStack)) return;
            this.openFromItem(player);
        });
        if (id) Logger.warn("DashboardEntry", "Using item.use.after fallback for menu opening");
        else Logger.error("DashboardEntry", "No compatible item-use event available for menu opening");
    }
}

export default DashboardEntry;
