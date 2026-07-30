// MCity Dashboard V2 - Shared card access policy for ATM and dimensional gates.
import { CustomCardService } from "./customCardService.js";

export class AccessCardService {
    static findValidCard(player) {
        const inventory = player?.getComponent("minecraft:inventory")?.container;
        if (!inventory) return { valid: false, reason: "no_inventory" };
        for (let slot = 0; slot < inventory.size; slot++) {
            const result = CustomCardService.validate(player, inventory.getItem(slot));
            if (result.valid) return result;
        }
        return { valid: false, reason: "missing_card" };
    }

    static authorize(player, context = "access") {
        const result = this.findValidCard(player);
        if (result.valid) return { ...result, context };
        const messages = {
            missing_card: "§cA valid Personal Card is required.",
            owner_mismatch: "§cThis Personal Card belongs to another player.",
            bad_signature: "§cThis Personal Card is invalid.",
            revoked_or_unknown: "§cThis Personal Card has been revoked or is unknown."
        };
        return { ...result, context, message: messages[result.reason] || "§cAccess denied: valid Personal Card required." };
    }
}

export default AccessCardService;
