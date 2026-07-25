// MCity Dashboard V2 - Player Profile UI
// UX Phase 2 (v1.7.1): Informational profile only; navigation shortcuts removed.

import { ActionFormData } from "@minecraft/server-ui";
import { UI } from "../uiTheme.js";
import { MoneyService } from "../modules/economy/moneyService.js";
import { LevelService } from "../modules/economy/levelService.js";
import { FinanceService } from "../modules/finance/financeService.js";
import { MarketService } from "../modules/market/marketService.js";
import { LandService } from "../modules/land/landService.js";
import { ContractService } from "../modules/contracts/contractService.js";
import { NotificationService } from "./dashboardNotifications.js";
import { MoneyUtils } from "../core/moneyUtils.js";

export class ProfileUI {
    static summary(player) {
        const balance = MoneyService.getBalance(player);
        const level = LevelService.getLevelInfo(player);
        return `§7Profile: §a${MoneyService.format(balance)} §8| ${level.color}${level.name}`;
    }

    static badge(player) {
        return "Overview";
    }

    static async open(player) {
        const balance = MoneyService.getBalance(player);
        const moneyRank = MoneyService.rankOf(player);
        const progress = LevelService.getProgress(player);
        const levelRank = LevelService.rankOf(player);
        const payouts = FinanceService.pendingStats(player.id);
        const marketMail = MarketService.mailboxStats(player);
        const land = LandService.stats(player);
        const contracts = ContractService.stats(player);
        const unread = NotificationService.unreadCount(player.id);

        const form = new ActionFormData()
            .title(UI.title(UI.ICON.profile, "Player Profile"))
            .body(UI.body(
                UI.kv("Name", player.name),
                UI.kv("Balance", MoneyUtils.formatCents(balance), "§a"),
                UI.kv("Money Rank", moneyRank ? `#${moneyRank}` : "Unranked", "§e"),
                `§7Level: ${progress.level.color}[${progress.level.name}] §8| §7Score: §b${progress.score}`,
                UI.kv("Level Rank", levelRank ? `#${levelRank}` : "Unranked", "§e"),
                progress.next ? `§7Next Level: ${progress.next.color}[${progress.next.name}] §8Need §e${progress.needed}` : "§aHighest configured level reached.",
                "",
                `§7Land: §f${land.owned} owned §8| §d${land.trusted} trusted §8| §e${MoneyUtils.formatCents(land.taxDebt)} tax`,
                `§7Contracts: §f${contracts.created} created §8| §b${contracts.accepted} accepted §8| §e${contracts.mailbox} deliveries`,
                `§7Market Mailbox: §e${marketMail.count} entries §8| §a${MoneyUtils.formatCents(marketMail.money)} money §8| §f${marketMail.items} items`,
                `§7Pending Payouts: §e${payouts.count} §8= §a${MoneyUtils.formatCents(payouts.amount)}`,
                `§7Notifications: §e${unread} unread`
            ))
            .button(UI.BACK);

        const r = await form.show(player);
        if (r.canceled) return; if (r.selection === 0) return this.#back(player);
    }

    static #back(player) {
        return import("./dashboardSystem.js").then(m => m.DashboardSystem.open(player));
    }
}

export default ProfileUI;
