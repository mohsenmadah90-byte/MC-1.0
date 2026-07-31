// MCity Dashboard V2 - Dashboard Router
// Central module registry for menu-based navigation.
// UX Phase 1 (v1.7.0): Minimal home screen without intro summaries.

import { ActionFormData } from "@minecraft/server-ui";
import { UI } from "../core/uiTheme.js";
import { Logger } from "../core/logger.js";
import { Permissions } from "../core/permissions.js";
import { FormUtils } from "../core/formUtils.js";
import { ErrorBoundary } from "../core/errorBoundary.js";
import { MinePhoneService } from "../core/minePhoneService.js";

export class DashboardRouter {
    static #modules = [];

    static clear() {
        this.#modules = [];
    }

    static register(moduleDef) {
        if (!moduleDef?.id || typeof moduleDef.open !== "function") {
            Logger.warn("Dashboard", "Invalid module registration skipped", moduleDef);
            return false;
        }
        this.#modules = this.#modules.filter(m => m.id !== moduleDef.id);
        this.#modules.push({
            id: moduleDef.id,
            title: moduleDef.title || moduleDef.id,
            icon: moduleDef.icon || UI.ICON.system,
            color: moduleDef.color || "§f",
            order: Number(moduleDef.order) || 100,
            visible: typeof moduleDef.visible === "function" ? moduleDef.visible : () => true,
            badge: typeof moduleDef.badge === "function" ? moduleDef.badge : () => "",
            summary: typeof moduleDef.summary === "function" ? moduleDef.summary : () => null,
            open: moduleDef.open
        });
        this.#modules.sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
        return true;
    }

    static modulesFor(player) {
        return this.#modules.filter(m => {
            try { return m.visible(player); } catch { return false; }
        });
    }

    static summariesFor(player) {
        return this.modulesFor(player).map(m => {
            try { return m.summary(player); } catch { return null; }
        }).filter(Boolean);
    }

    static async openHome(player, options = {}) {
        if (!Permissions.canUseDashboard(player)) return;
        const modules = this.modulesFor(player);
        const form = new ActionFormData()
            .title(UI.title(UI.ICON.dashboard, "Mine Phone"))
            .body(this.#homeBody(player, options));

        const actions = [];
        for (const mod of modules) {
            let badge = "";
            try { badge = mod.badge(player) || ""; } catch {}
            form.button(UI.badge(UI.action(mod.icon, mod.color, mod.title), badge));
            actions.push(mod);
        }
        form.button(UI.CLOSE);
        actions.push({ id: "close" });

        const result = await form.show(player);
        if (result.canceled) { MinePhoneService.end(player); return; }
        const action = actions[result.selection];
        if (!action || action.id === "close") { MinePhoneService.end(player); return; }
        try {
            return await action.open(player);
        } catch (error) {
            ErrorBoundary.report("Dashboard", error, {
                player,
                message: `Failed to open module '${action.id}'`,
                context: { moduleId: action.id }
            });
            return FormUtils.showMissing(player, action.title, p => this.openHome(p));
        }
    }

    static #homeBody(player, options = {}) {
        // UX Phase 1: the home screen is now navigation-only.
        // Detailed player/module summaries live inside their own modules
        // (Profile, Economy, Land, Contracts, etc.) instead of cluttering
        // the main dashboard.
        const lines = [];
        if (options.notice) {
            lines.push(`§e${options.notice}`);
            lines.push("");
        }
        lines.push(`§7Battery: ${MinePhoneService.battery(player).toFixed(0)}%${MinePhoneService.flashlight(player) ? " §e(Flashlight ON)" : ""}`);
        lines.push("§8Select a city service:");
        return UI.body(...lines);
    }
}

export default DashboardRouter;
