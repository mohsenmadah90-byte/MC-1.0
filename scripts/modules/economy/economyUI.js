// MCity Dashboard V2 - Economy Hub UI

import { ActionFormData } from "@minecraft/server-ui";
import { UI } from "../../core/uiTheme.js";
import { CONFIG } from "../../config.js";
import { MoneyService } from "./moneyService.js";
import { LevelService } from "./levelService.js";
import { MoneyUI } from "./moneyUI.js";
import { LevelUI } from "./levelUI.js";

export class EconomyUI {
    static initialize() {
        MoneyService.initialize();
        LevelService.initialize();
    }

    static summary(player) {
        const balance = MoneyService.getBalance(player);
        const progress = LevelService.getProgress(player);
        return `§7Economy: §a${MoneyService.format(balance)} §8| ${progress.level.color}[${progress.level.name}] §b${progress.score}`;
    }

    static badge(player) {
        const balance = MoneyService.getBalance(player);
        const level = LevelService.getLevelInfo(player);
        return `${MoneyService.format(balance)} | ${level.color}${level.name}`;
    }

    static async open(player) {
        const balance = MoneyService.getBalance(player);
        const progress = LevelService.getProgress(player);
        const form = new ActionFormData()
            .title(UI.title(UI.ICON.money, "Economy", "Money & Level"))
            .body(UI.body(
                UI.kv("Balance", MoneyService.format(balance), "§a"),
                `§7Level: ${progress.level.color}[${progress.level.name}] §8| §7Score: §b${progress.score}`,
                progress.next ? `§7Next: ${progress.next.color}[${progress.next.name}] §8Need §e${progress.needed}` : "§aHighest configured level reached.",
                "",
                "§8Select an economy tool:"
            ))
            .button(UI.action(UI.ICON.money, "§a", "Balance"))
            .button(UI.action("➤", "§a", "Send Money", "Online players"))
            .button(UI.action("★", "§6", "Top Money"))
            .button(UI.action(UI.ICON.level, "§b", "Level Progress"))
            .button(UI.action("♛", "§b", "Level Leaderboard"))
            .button(UI.action(UI.ICON.atm, "§3", "ATM Limits Info"))
            .button(UI.BACK);
        const result = await form.show(player);
        if (result.canceled) return; if (result.selection === 6) return this.#backToDashboard(player);
        if (result.selection === 0) return MoneyUI.balance(player, p => this.open(p));
        if (result.selection === 1) return MoneyUI.sendMoney(player, p => this.open(p));
        if (result.selection === 2) return MoneyUI.topMoney(player, p => this.open(p));
        if (result.selection === 3) return LevelUI.progress(player, p => this.open(p));
        if (result.selection === 4) return LevelUI.leaderboard(player, p => this.open(p));
        if (result.selection === 5) return this.atmInfo(player);
    }

    static async atmInfo(player) {
        const level = LevelService.getLevelInfo(player);
        const lines = [
            "§6ATM is a physical world system.",
            "§7Exchange raw ores at a real ATM block/chest.",
            "§7There is no daily exchange limit; the server rate limiter protects runtime health.",
            `§7Your Level Bonus Source: ${level.color}[${level.name}]`,
            "",
            "§6Configured Exchange Tiers",
            ...Object.values(CONFIG.ATM_INFO.COMBINATION_NAMES || {}).map(name => `§7${name}: available from inventory`),
            "",
            "§8ATM exchange itself is physical: interact with an ATM chest in the world."
        ];
        await new ActionFormData().title(UI.title(UI.ICON.atm, "ATM Info")).body(UI.body(...lines)).button(UI.BACK).show(player);
        return this.open(player);
    }

    static #backToDashboard(player) {
        // Lazy import avoided to keep module graph simple; DashboardSystem is attached by router callbacks.
        return import("../../dashboard/dashboardSystem.js").then(m => m.DashboardSystem.open(player));
    }
}

export default EconomyUI;
