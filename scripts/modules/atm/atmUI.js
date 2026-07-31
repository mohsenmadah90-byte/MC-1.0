// MCity Dashboard V2 - Physical ATM UI

import { ActionFormData, ModalFormData, MessageFormData } from "@minecraft/server-ui";
import { CONFIG } from "../../config.js";
import { UI } from "../../core/uiTheme.js";
import { MoneyUtils } from "../../core/moneyUtils.js";
import { ATMInventory } from "./atmInventory.js";
import { ATMService } from "./atmService.js";
import { ItemCatalog } from "../../core/itemCatalog.js";

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
        return this.exchangeComboPicker(player, block, {});
    }

    static async exchangeComboPicker(player, block, selections = {}) {
        const combos = Object.keys(CONFIG.ATM.ORE_COMBINATIONS || {});
        const counts = ATMInventory.oreCounts(player);
        const form = new ActionFormData()
            .title(UI.title(UI.ICON.atm, "Select Exchange Tier"))
            .body(UI.body("§7Select a tier to choose its quantity.", "§7Each slider is capped at 64.", "§7Selected quantities are kept until confirmation."));
        const actions = [];
        for (const combo of combos) {
            const ores = CONFIG.ATM.ORE_COMBINATIONS[combo] || [];
            const available = ores.length ? Math.min(...ores.map(id => counts[id] || 0)) : 0;
            const max = Math.max(0, Math.min(CONFIG.ATM.MAX_EXCHANGE_PER_COMBO || 64, available));
            const primary = ItemCatalog.get(ores[0]);
            const selected = selections[combo] || 0;
            const label = `${AIC.COMBINATION_NAMES?.[combo] || combo}\\n§7${primary?.name || ores[0]} | ${selected}/${max}`;
            try { form.button(label, primary?.icon || undefined); } catch { form.button(label); }
            actions.push({ type: "combo", combo, max });
        }
        const selectedTotal = Object.values(selections).reduce((sum, value) => sum + (Number(value) || 0), 0);
        form.button(`§aReview & Confirm${selectedTotal ? ` (${selectedTotal} units)` : ""}`); actions.push({ type: "review" });
        form.button(UI.BACK); actions.push({ type: "back" });
        const result = await form.show(player);
        if (result.canceled) return;
        const action = actions[result.selection];
        if (!action || action.type === "back") return this.open(player, block);
        if (action.type === "review") return this.confirmExchange(player, block, selections);
        return this.exchangeComboSlider(player, block, selections, action.combo, action.max);
    }

    static async exchangeComboSlider(player, block, selections, combo, max) {
        const ores = CONFIG.ATM.ORE_COMBINATIONS[combo] || [];
        const counts = ATMInventory.oreCounts(player);
        const available = ores.length ? Math.min(...ores.map(id => counts[id] || 0)) : 0;
        const safeMax = Math.max(0, Math.min(CONFIG.ATM.MAX_EXCHANGE_PER_COMBO || 64, available, max));
        const names = ores.map(id => ItemCatalog.get(id)?.name || id.split(":").pop()).join(" + ");
        const form = new ModalFormData()
            .title(`§a${AIC.COMBINATION_NAMES?.[combo] || combo}`)
            .slider(`${names} (maximum ${safeMax})`, 0, Math.max(1, safeMax), { valueStep: 1, defaultValue: Math.min(selections[combo] || 0, safeMax) });
        const result = await form.show(player);
        if (result.canceled) return this.exchangeComboPicker(player, block, selections);
        const quantity = Math.max(0, Math.min(safeMax, Math.floor(Number(result.formValues?.[0]) || 0)));
        const next = { ...selections };
        if (quantity) next[combo] = quantity; else delete next[combo];
        return this.exchangeComboPicker(player, block, next);
    }

    static async confirmExchange(player, block, selections) {
        const clean = {};
        for (const [combo, value] of Object.entries(selections)) {
            const quantity = Math.max(0, Math.min(CONFIG.ATM.MAX_EXCHANGE_PER_COMBO || 64, Math.floor(Number(value) || 0)));
            if (quantity) clean[combo] = quantity;
        }
        if (!Object.keys(clean).length) return this.exchangeComboPicker(player, block, selections);
        const summary = ATMService.buildExchangeSummary(player, clean);
        const lines = ["§6Confirm ATM Exchange", ""];
        for (const [combo, quantity] of Object.entries(clean)) lines.push(`§7${AIC.COMBINATION_NAMES?.[combo] || combo}: §f${quantity}`);
        lines.push("", `§7Receive: §a${MoneyUtils.formatCents(summary.totalMoney)} §8| §b${summary.totalScore} score`, "", "§8Ores will be moved to the linked Source chest.");
        const result = await new MessageFormData().title("§6Confirm ATM Exchange").body(lines.join("\\n")).button1("§cBack").button2("§aExchange").show(player);
        if (result.canceled || result.selection !== 1) return this.exchangeComboPicker(player, block, clean);
        const response = ATMService.exchange(player, block, clean);
        player.sendMessage(CONFIG.PREFIX + response.message);
        return this.open(player, block);
    }
}

export default ATMUI;
