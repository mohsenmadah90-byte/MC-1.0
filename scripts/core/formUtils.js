// MCity Dashboard V2 - Form Utility Helpers
// Phase 2: UI Stability & Cancelation Reason Hardening

import { ActionFormData, MessageFormData } from "@minecraft/server-ui";
import { UI } from "./uiTheme.js";
import { Logger } from "./logger.js";

export class FormUtils {
    static async showMissing(player, moduleName, back = null) {
        try {
            const result = await new ActionFormData()
                .title(UI.title(UI.ICON.system, moduleName))
                .body(UI.missingModule(moduleName))
                .button(UI.BACK)
                .show(player);
                
            if (!result.canceled && typeof back === "function") return back(player);
        } catch (e) {
            Logger.debug("UI", `Form canceled forcefully for ${player.name} (${e.message})`);
        }
    }

    static async confirm(player, title, body, yes = "§aConfirm", no = "§cCancel") {
        try {
            const result = await new MessageFormData()
                .title(title)
                .body(body)
                .button1(no)
                .button2(yes)
                .show(player);

            // Handle cancellation gracefully
            if (result.canceled) {
                // If user moved, got hit, or closed the menu intentionally
                return false;
            }
            
            return result.selection === 1; // 1 corresponds to button2 (yes)
        } catch (e) {
            Logger.debug("UI", `Confirmation form exception for ${player.name} (${e.message})`);
            return false;
        }
    }

    // Helper for large inputs (e.g. money amounts)
    // Ensures input isn't evaluated if form is canceled unexpectedly
    static handleModalResult(result) {
        if (!result) return { canceled: true };
        
        return {
            canceled: result.canceled,
            reason: result.cancelationReason || (result.canceled ? "Unknown" : null),
            values: result.formValues || []
        };
    }

    static clampPage(page, totalPages) {
        const total = Math.max(1, Math.floor(totalPages || 1));
        return Math.max(0, Math.min(Math.floor(page || 0), total - 1));
    }
}

export default FormUtils;