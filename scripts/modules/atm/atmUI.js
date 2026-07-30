// MCity Dashboard V2 - Physical ATM UI

import { ActionFormData, ModalFormData, MessageFormData } from "@minecraft/server-ui";
import { CONFIG } from "../../config.js";
import { UI } from "../../core/uiTheme.js";
import { MoneyUtils } from "../../core/moneyUtils.js";
import { ATMInventory } from "./atmInventory.js";
import { ATMService } from "./atmService.js";

const AIC = CONFIG.ATM_INFO;

export class ATMUI {
    static async open(player, block) {
        const info = ATMService.getATMFromBlock(block);
        const linked = !!info?.atm?.sourceCode;
        const form = new ActionFormData()
            .title(UI.title(UI.ICON.atm, "MCity ATM"))
            .body(UI.body(
                `§7ATM Code: §f${info?.code || "Unknown"}`,
                `§7Status: ${linked ? "§aLinked" : "§cNot linked"}`,
                linked ? `§7Source: §f${info.atm.sourceCode}` : "§eAsk staff to link this ATM to a source.",
                "",
                "§8Physical ATM exchange system."
            ))
            .button("§aQuick Exchange Max")
            .button("§fCustom Exchange")
            .button("§fATM Info")
            .button(UI.CLOSE);
        const r = await form.show(player);
        if (r.canceled || r.selection === 4) return;
        if (r.selection === 0) return this.quickExchange(player, block);
        if (r.selection === 1) return this.exchangeForm(player, block);
        if (r.selection === 2) return this.info(player, block);
    }

    static async info(player, block) {
        const info = ATMService.getATMFromBlock(block);
        await new ActionFormData().title(UI.title(UI.ICON.atm, "ATM Info")).body(UI.body(
            UI.kv("Code", info?.code || "Unknown"),
            UI.kv("Linked", info?.atm?.sourceCode ? "Yes" : "No", info?.atm?.sourceCode ? "§a" : "§c"),
            UI.kv("Transactions", info?.atm?.totalTransactions || 0),
            UI.kv("Minted", MoneyUtils.formatCents(info?.atm?.totalMoneyMinted || 0), "§a")
        )).button(UI.BACK).show(player);
        return this.open(player, block);
    }

    static async quickExchange(player, block) {
        const selections = ATMService.quickSelections(player);
        if (!Object.keys(selections).length) { player.sendMessage(CONFIG.PREFIX + "§eNo available ATM exchanges based on your inventory."); return this.open(player, block); }
        const summary = ATMService.buildExchangeSummary(player, selections);
        const lines = ["§6Quick Exchange Max", "§7The ATM will exchange the maximum available amount allowed by your inventory and current limits.", ""];
        for (const [combo, qty] of Object.entries(selections)) lines.push(`§7${AIC.COMBINATION_NAMES?.[combo] || combo}: §f${qty}`);
        lines.push("", `§7Receive: §a${MoneyUtils.formatCents(summary.totalMoney)} §8| §b${summary.totalScore} score`);
        const conf = await new MessageFormData().title("§6Confirm Quick Exchange").body(lines.join("\n")).button1("§cCancel").button2("§aExchange Max").show(player);
        if (conf.canceled) return; if (conf.selection !== 1) return this.open(player, block);
        const res = ATMService.exchange(player, block, selections);
        player.sendMessage(CONFIG.PREFIX + res.message);
        return this.open(player, block);
    }

    static async exchangeForm(player, block) {
        const info = ATMService.getATMFromBlock(block);
        if (!info?.atm?.sourceCode) { player.sendMessage(CONFIG.PREFIX + "§cThis ATM is not linked."); return this.open(player, block); }
        const counts = ATMInventory.oreCounts(player);
        const combos = Object.keys(CONFIG.ATM.ORE_COMBINATIONS || {});
        const form = new ModalFormData().title("§aATM Exchange");
        for (const combo of combos) {
            const ores = CONFIG.ATM.ORE_COMBINATIONS[combo] || [];
            const available = ores.length ? Math.min(...ores.map(id => counts[id] || 0)) : 0;
            const max = Math.max(0, available);
            form.slider(`${AIC.COMBINATION_NAMES?.[combo] || combo} (max ${max})`, 0, Math.max(1, max), { valueStep: 1, defaultValue: 0 });
        }
        const r = await form.show(player); if (r.canceled) return;
        const selections = {}; let any = false; let totalMoney = 0, totalScore = 0;
        for (let i = 0; i < combos.length; i++) {
            const qty = Math.max(0, Math.floor(r.formValues[i] || 0));
            if (qty > 0) { selections[combos[i]] = qty; any = true; const calc = ATMService.calculate(combos[i], qty, player); totalMoney += calc.money; totalScore += calc.score; }
        }
        if (!any) return this.open(player, block);
        const conf = await new MessageFormData().title("§6Confirm ATM Exchange").body(`Receive §a${MoneyUtils.formatCents(totalMoney)} §rand §b${totalScore} score§r?\n\nOres will be moved to the linked Source chest.`).button1("§cCancel").button2("§aExchange").show(player);
        if (conf.canceled) return; if (conf.selection !== 1) return this.open(player, block);
        const res = ATMService.exchange(player, block, selections); player.sendMessage(CONFIG.PREFIX + res.message); return this.open(player, block);
    }
}

export default ATMUI;
