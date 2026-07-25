// MCity Dashboard V2 - Economy Admin UI
// Phase 7.5 (v0.22.0): Added player detail view from leaderboard (EC7).

import { ActionFormData } from "@minecraft/server-ui";
import { UI } from "../../core/uiTheme.js";
import { Permissions } from "../../core/permissions.js";
import { MoneyUtils } from "../../core/moneyUtils.js";
import { MoneyService } from "./moneyService.js";
import { LevelService } from "./levelService.js";
import { PlayerRegistry } from "../../core/playerRegistry.js";
import { PlayerManagementUI } from "../../dashboard/playerManagementUI.js";

function __mcityCan(player) { return Permissions.canManageEconomy(player); }
function __mcityLost(player) { if (__mcityCan(player)) return false; try { player.sendMessage("§cPermission changed. Action cancelled."); } catch {} return true; }

export class EconomyAdminUI {
    static async open(player) {
        if (!Permissions.canManageEconomy(player)) return;
        const form = new ActionFormData()
            .title(UI.title(UI.ICON.money, "Economy Admin"))
            .body(UI.body("§7Manage money and score through Dashboard tools."))
            .button("§aTop Money")
            .button("§fTop Levels")
            .button("§eSelect Player")
            .button(UI.BACK);
        const r = await form.show(player);
        if (__mcityLost(player)) return;
        if (r.canceled) return; if (r.selection === 3) return this.#back(player);
        if (r.selection === 0) return this.topMoney(player, 0);
        if (r.selection === 1) return this.topLevels(player, 0);
        if (r.selection === 2) return PlayerManagementUI.open(player);
    }

    static async topMoney(player, page = 0) {
        const list = MoneyService.top(100);
        const per = 10, total = Math.max(1, Math.ceil(list.length / per));
        page = Math.max(0, Math.min(page, total - 1));
        const slice = list.slice(page * per, page * per + per);
        const form = new ActionFormData().title(UI.title(UI.ICON.money, "Top Money Admin")).body(UI.body(`§7Page: §f${page + 1}/${total}`));
        const actions = [];
        for (let i = 0; i < slice.length; i++) {
            const rec = slice[i];
            form.button(`§e#${page * per + i + 1} §f${rec.name}\n§a${MoneyUtils.formatCents(rec.balance)}`);
            // Phase 7.5 (v0.22.0) (EC7): Store the record so we can show a
            // detail view when the admin clicks it (was a dead-end before).
            actions.push({ type: "view", rec, rank: page * per + i + 1 });
        }
        if (page < total - 1) { form.button(UI.NEXT); actions.push({ type: "next" }); }
        if (page > 0) { form.button(UI.PREV); actions.push({ type: "prev" }); }
        form.button(UI.BACK); actions.push({ type: "back" });
        const r = await form.show(player);
        if (__mcityLost(player)) return;
        const a = actions[r.selection];
        if (r.canceled) return; if (!a || a.type === "back") return this.open(player);
        if (a.type === "next") return this.topMoney(player, page + 1);
        if (a.type === "prev") return this.topMoney(player, page - 1);
        // Phase 7.5 (v0.22.0) (EC7): Show a detail view for the clicked player.
        if (a.type === "view") return this.playerDetail(player, a.rec, a.rank, "money");
        return this.topMoney(player, page);
    }

    static async topLevels(player, page = 0) {
        const list = LevelService.leaderboard(100);
        const per = 10, total = Math.max(1, Math.ceil(list.length / per));
        page = Math.max(0, Math.min(page, total - 1));
        const slice = list.slice(page * per, page * per + per);
        const form = new ActionFormData().title(UI.title(UI.ICON.level, "Top Levels Admin")).body(UI.body(`§7Page: §f${page + 1}/${total}`));
        const actions = [];
        for (let i = 0; i < slice.length; i++) {
            const rec = slice[i];
            form.button(`§e#${page * per + i + 1} §f${rec.name}\n${rec.level.color}[${rec.level.name}] §b${rec.score}`);
            // Phase 7.5 (v0.22.0) (EC7): Store the record for a detail view.
            actions.push({ type: "view", rec, rank: page * per + i + 1 });
        }
        if (page < total - 1) { form.button(UI.NEXT); actions.push({ type: "next" }); }
        if (page > 0) { form.button(UI.PREV); actions.push({ type: "prev" }); }
        form.button(UI.BACK); actions.push({ type: "back" });
        const r = await form.show(player);
        if (__mcityLost(player)) return;
        const a = actions[r.selection];
        if (r.canceled) return; if (!a || a.type === "back") return this.open(player);
        if (a.type === "next") return this.topLevels(player, page + 1);
        if (a.type === "prev") return this.topLevels(player, page - 1);
        // Phase 7.5 (v0.22.0) (EC7): Show a detail view for the clicked player.
        if (a.type === "view") return this.playerDetail(player, a.rec, a.rank, "level");
        return this.topLevels(player, page);
    }

    /**
     * Phase 7.5 (v0.22.0) (EC7): Player detail view from the leaderboard.
     *
     * Previously, clicking a player in topMoney/topLevels was a dead-end —
     * the page just reloaded with no action. Now we show a detail view with
     * the player's record and offer actions:
     *   - If the player is online, route to PlayerManagementUI for editing.
     *   - If offline, show read-only details (balance, last seen, rank).
     *
     * @param {Player} admin - the admin viewing the detail
     * @param {object} rec - the leaderboard record {id, name, balance, lastSeen} or {id, name, score, level}
     * @param {number} rank - the player's rank in the leaderboard
     * @param {"money"|"level"} kind - which leaderboard this came from
     */
    static async playerDetail(admin, rec, rank, kind = "money") {
        if (!Permissions.canManageEconomy(admin)) return;
        if (!rec || !rec.id) return this.open(admin);
        // Check if the player is online — if so, offer to manage them.
        const online = PlayerRegistry.getOnlineById(rec.id);
        const lines = [
            `§7Rank: §e#${rank}`,
            `§7Name: §f${rec.name || "Unknown"}`,
            `§7ID: §8${rec.id}`,
        ];
        if (kind === "money") {
            lines.push(`§7Balance: §a${MoneyUtils.formatCents(rec.balance || 0)}`);
            if (rec.lastSeen) lines.push(`§7Last seen: §f${new Date(rec.lastSeen).toLocaleString()}`);
        } else {
            if (rec.level) lines.push(`§7Level: ${rec.level.color}[${rec.level.name}]`);
            lines.push(`§7Score: §b${rec.score || 0}`);
        }
        lines.push(`§7Status: ${online ? "§aOnline" : "§7Offline"}`);

        const form = new ActionFormData()
            .title(UI.title(UI.ICON.profile, `Player #${rank}`))
            .body(UI.body(...lines));
        const actions = [];
        if (online) {
            form.button("§aManage Player");
            actions.push("manage");
        }
        form.button(UI.BACK);
        actions.push("back");
        const r = await form.show(admin);
        if (r.canceled || actions[r.selection] === "back") {
            // Go back to the right leaderboard.
            return kind === "money" ? this.topMoney(admin, Math.floor((rank - 1) / 10)) : this.topLevels(admin, Math.floor((rank - 1) / 10));
        }
        if (actions[r.selection] === "manage" && online) {
            return PlayerManagementUI.playerMenu(admin, rec.id);
        }
        return this.open(admin);
    }

    static #back(player) { return import("../../dashboard/adminDashboard.js").then(m => m.AdminDashboard.open(player)); }
}

export default EconomyAdminUI;
