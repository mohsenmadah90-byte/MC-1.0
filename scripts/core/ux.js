// MCity Dashboard V2 - UX Guards / Standard Notices
// Phase 2: UI Stability & Cancelation Reason Hardening

import { ActionFormData } from "@minecraft/server-ui";
import { CONFIG } from "../config.js";
import { UI } from "./uiTheme.js";

export class UX {
    static async notice(player, title, lines = [], back = null, icon = UI.ICON.info || "!") {
        const arr = Array.isArray(lines) ? lines : [String(lines ?? "")];
        try {
            const result = await new ActionFormData()
                .title(UI.title(icon, title))
                .body(UI.body(...arr))
                .button(UI.BACK)
                .show(player);

            if (!result.canceled && typeof back === "function") {
                return back(player);
            }
        } catch (error) {
            // Player disconnected or form was interrupted forcefully
            return;
        }
    }

    static async comingSoon(player, featureName, back = null) {
        return this.notice(player, featureName, [
            "§eThis feature is planned but not fully implemented yet.",
            "§7It will be completed in a future hardening phase.",
            "§8If you expected this to work now, report this menu path to the developer."
        ], back, UI.ICON.system);
    }

    static async noPermission(player, featureName = "This feature", back = null) {
        try { player.sendMessage(CONFIG.PREFIX + `§cYou do not have permission for ${featureName}.`); } catch {}
        return this.notice(player, "No Permission", [
            `§cYou do not have permission for ${featureName}.`,
            "§7Ask an owner/admin to grant the required tag."
        ], back, UI.ICON.admin);
    }

    static async empty(player, title, message, back = null) {
        return this.notice(player, title, [
            `§e${message}`
        ], back, UI.ICON.info || "!");
    }

    static async error(player, title, error, back = null) {
        return this.notice(player, title, [
            "§cAn error occurred while opening this menu.",
            `§7${String(error?.message || error || "Unknown error").substring(0, 180)}`
        ], back, UI.ICON.admin);
    }
}

export default UX;