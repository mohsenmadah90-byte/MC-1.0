// MCity Dashboard V2 - Player Payout UI

import { ActionFormData } from "@minecraft/server-ui";
import { UI } from "../../core/uiTheme.js";
import { CONFIG } from "../../config.js";
import { MoneyUtils } from "../../core/moneyUtils.js";
import { FinanceService } from "./financeService.js";

export class PayoutUI {
    static summary(player) {
        const s = FinanceService.pendingStats(player.id);
        return s.count ? `§7Payouts: §e${s.count} pending §8= §a${MoneyUtils.formatCents(s.amount)}${s.reservedCount ? ` §8(${s.reservedCount} reserved)` : ""}` : null;
    }

    static badge(player) {
        const s = FinanceService.pendingStats(player.id);
        return s.count ? `${s.count} pending | ${MoneyUtils.formatCents(s.amount)}` : "";
    }

    static async open(player, page = 0) {
        const list = FinanceService.pendingFor(player.id);
        const stats = FinanceService.pendingStats(player.id);
        if (!list.length) {
            await new ActionFormData()
                .title(UI.title(UI.ICON.finance, "Payouts"))
                .body(UI.body(
                    "§eNo pending payouts.",
                    "§7Rewards from future Land, Market, Contracts and ATM-related systems will appear here."
                ))
                .button(UI.BACK)
                .show(player);
            return this.#back(player);
        }

        const per = CONFIG.UI.ITEMS_PER_PAGE || 8;
        const totalPages = Math.max(1, Math.ceil(list.length / per));
        page = Math.max(0, Math.min(page, totalPages - 1));
        const slice = list.slice(page * per, page * per + per);
        const form = new ActionFormData()
            .title(UI.title(UI.ICON.finance, "Pending Payouts"))
            .body(UI.body(
                `§7Entries: §f${stats.count}`,
                `§7Total: §a${MoneyUtils.formatCents(stats.amount)}`,
                stats.reservedCount ? `§7Reserved by recovery: §e${stats.reservedCount} §8= §f${MoneyUtils.formatCents(stats.reservedAmount)}` : "",
                `§7Page: §f${page + 1}/${totalPages}`
            ));
        const actions = [];
        form.button("§aClaim All Payouts"); actions.push({ type: "claim" });
        for (const payout of slice) {
            form.button(`§e${MoneyUtils.formatCents(payout.amount)}${payout.status === "reserved" ? " §6[reserved]" : ""}\n§f${payout.source} §e| §f${payout.reason}`);
            actions.push({ type: "view", payout });
        }
        if (page < totalPages - 1) { form.button(UI.NEXT); actions.push({ type: "next" }); }
        if (page > 0) { form.button(UI.PREV); actions.push({ type: "prev" }); }
        form.button(UI.BACK); actions.push({ type: "back" });

        const result = await form.show(player);
        if (result.canceled) return;
        const action = actions[result.selection];
        if (!action || action.type === "back") return this.#back(player);
        if (action.type === "next") return this.open(player, page + 1);
        if (action.type === "prev") return this.open(player, page - 1);
        if (action.type === "claim") {
            const claim = FinanceService.claimPayouts(player);
            const message = claim.success
                ? `§a${claim.message}`
                : claim.pending
                    ? `§eClaim operation ${claim.operationId || ""} is pending safe recovery. ${MoneyUtils.formatCents(claim.remainder || 0)} remains owed.`
                    : `§e${claim.message || "Payouts remain pending."}`;
            player.sendMessage(CONFIG.PREFIX + message);
            return this.open(player, 0);
        }
        if (action.type === "view") return this.details(player, action.payout, page);
    }

    static async details(player, payout, page = 0) {
        await new ActionFormData()
            .title(UI.title(UI.ICON.finance, "Payout Details"))
            .body(UI.body(
                UI.kv("Amount", MoneyUtils.formatCents(payout.amount), "§a"),
                UI.kv("Source", payout.source),
                UI.kv("Reason", payout.reason),
                UI.kv("From", payout.fromName || "-"),
                UI.kv("Status", payout.status || "pending", payout.status === "reserved" ? "§e" : "§a"),
                payout.status === "reserved" ? UI.kv("Reserved", MoneyUtils.formatCents(payout.reservedAmount || 0), "§e") : "",
                UI.kv("Created", new Date(payout.createdAt).toLocaleString())
            ))
            .button(UI.BACK)
            .show(player);
        return this.open(player, page);
    }

    static #back(player) {
        return import("../../dashboard/dashboardSystem.js").then(m => m.DashboardSystem.open(player));
    }
}

export default PayoutUI;
