// MCity Dashboard V2 - Permission Helpers

import { Player } from "@minecraft/server";
import { CONFIG } from "../config.js";

export class Permissions {
    static isPlayer(value) {
        return value instanceof Player;
    }

    static hasTag(player, tag) {
        try { return !!player?.hasTag?.(tag); } catch { return false; }
    }

    static isAdmin(player) {
        return this.hasTag(player, CONFIG.TAGS.ADMIN) || this.isOwner(player);
    }

    static isOwner(player) {
        return this.hasTag(player, CONFIG.TAGS.OWNER);
    }

    static isModerator(player) {
        return this.hasTag(player, CONFIG.TAGS.MODERATOR) || this.isAdmin(player);
    }

    static canUseDashboard(player) {
        return this.isPlayer(player) && CONFIG.DASHBOARD.ENABLED;
    }

    static canAccessAdminCenter(player) {
        return this.isAdmin(player);
    }

    static canAccessBackupRestore(player) {
        return this.isOwner(player) || this.hasTag(player, CONFIG.TAGS.BACKUP_ADMIN);
    }

    static canManageEconomy(player) {
        return this.isOwner(player) || this.hasTag(player, CONFIG.TAGS.ECONOMY_ADMIN) || this.isAdmin(player);
    }

    static canManageLand(player) {
        return this.isOwner(player) || this.hasTag(player, CONFIG.TAGS.LAND_ADMIN) || this.isAdmin(player);
    }

    static canManageMarket(player) {
        return this.isOwner(player) || this.hasTag(player, CONFIG.TAGS.MARKET_ADMIN) || this.isAdmin(player);
    }

    static canManageContracts(player) {
        return this.isOwner(player) || this.hasTag(player, CONFIG.TAGS.CONTRACT_ADMIN) || this.isAdmin(player);
    }

    static canManageATM(player) {
        return this.isOwner(player) || this.hasTag(player, CONFIG.TAGS.ATM_ADMIN) || this.isAdmin(player);
    }
}

export default Permissions;
