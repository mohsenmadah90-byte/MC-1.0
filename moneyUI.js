// MCity Dashboard V2 - Money UI
// Phase 7.6 (v0.23.0): Use PlayerRegistry instead of world.getAllPlayers() (S3).

import { world, Player } from "@minecraft/server";
import { ActionFormData, ModalFormData, MessageFormData } from "@minecraft/server-ui";
import { UI } from "../../uiTheme.js";
import { CONFIG } from "../../config.js";
import { MoneyUtils } from "../../core/moneyUtils.js";
import { MoneyService } from "./moneyService.js";
import { PlayerRegistry } from "../../core/playerRegistry.js";

export class MoneyUI {
    static async balance(player, back) {
        const balance = MoneyService.getBalance(player);
        const rank = MoneyService.rankOf(player);
        await new ActionFormData()
            .title(UI.title(UI.ICON.money, "Balance"))
            .body(UI.body(
                UI.kv("Balance", MoneyService.format(balance), "§a"),
                UI.kv("Money Rank", rank ? `#${rank}` : "Unranked", "§e"),
                "§7Money is stored with cents precision."
            ))
            .button(UI.BACK)
            .show(player);
        return back(player);
    }

    static async sendMoney(player, back) {
        // Phase 7.6 (v0.23.0) (S3): Use PlayerRegistry.onlineMap() instead
        // of world.getAllPlayers(). The registry Map is maintained
        // incrementally and avoids allocating a new array on every call.
        const online = [];
        for (const p of PlayerRegistry.onlineMap().values()) {
            if (p.id !== player.id) online.push(p);
        }
        if (!online.length) {
            await new ActionFormData().title(UI.title(UI.ICON.money, "Send Money")).body(UI.body("§eNo other online players found.")).button(UI.BACK).show(player);
            return back(player);
        }

        const select = new ActionFormData().title(UI.title(UI.ICON.money, "Send Money", "Select target player"))
            .body(UI.body(UI.kv("Your Balance", MoneyService.format(MoneyService.getBalance(player)), "§a")));
        for (const target of online) select.button(`§f${target.name}\n§fSend money`);
        select.button(UI.BACK);
        const selected = await select.show(player);
        if (selected.canceled) return; if (selected.selection >= online.length) return back(player);
        const target = online[selected.selection];

        const amountForm = new ModalFormData()
            .title("§aSend Money")
            .textField(`Amount to send to ${target.name}`, "100.00");
        const amountRes = await amountForm.show(player);
        if (amountRes.canceled) return;
        const parsed = MoneyUtils.parseFloatToCents(amountRes.formValues[0], false);
        if (!parsed.ok || parsed.cents <= 0) {
            player.sendMessage(CONFIG.PREFIX + `§c${parsed.error || "Invalid amount."}`);
            return this.sendMoney(player, back);
        }

        const confirm = await new MessageFormData()
            .title("§6Confirm Payment")
            .body(`§7Send §e${MoneyService.format(parsed.cents)} §7to §f${target.name}§7?\n\n§bYour balance: §a${MoneyService.format(MoneyService.getBalance(player))}`)
            .button1("§cCancel")
            .button2("§aSend")
            .show(player);
        if (confirm.canceled) return; if (confirm.selection !== 1) return back(player);

        const result = MoneyService.transfer(player, target, parsed.cents);
        player.sendMessage(CONFIG.PREFIX + result.message);
        if (result.success) target.sendMessage(CONFIG.PREFIX + `§aReceived §e${MoneyService.format(parsed.cents)} §afrom §f${player.name}§a.`);
        return back(player);
    }

    static async topMoney(player, back, page = 0) {
        const list = MoneyService.top(100);
        const per = CONFIG.UI.LONG_LIST_PAGE_SIZE || 10;
        const totalPages = Math.max(1, Math.ceil(list.length / per));
        page = Math.max(0, Math.min(page, totalPages - 1));
        const slice = list.slice(page * per, page * per + per);
        const form = new ActionFormData()
            .title(UI.title(UI.ICON.money, "Top Money"))
            .body(UI.body(`§7Players: §f${list.length}`, `§7Page: §f${page + 1}/${totalPages}`));
        const actions = [];
        for (let i = 0; i < slice.length; i++) {
            const rank = page * per + i + 1;
            const rec = slice[i];
            form.button(`§e#${rank} §f${rec.name}\n§a${MoneyService.format(rec.balance)}`);
            actions.push({ type: "view", rec, rank });
        }
        if (page < totalPages - 1) { form.button(UI.NEXT); actions.push({ type: "next" }); }
        if (page > 0) { form.button(UI.PREV); actions.push({ type: "prev" }); }
        form.button(UI.BACK); actions.push({ type: "back" });

        const result = await form.show(player);
        if (result.canceled) return;
        const action = actions[result.selection];
        if (!action || action.type === "back") return back(player);
        if (action.type === "next") return this.topMoney(player, back, page + 1);
        if (action.type === "prev") return this.topMoney(player, back, page - 1);
        await new ActionFormData()
            .title(`§e#${action.rank} ${action.rec.name}`)
            .body(UI.body(UI.kv("Balance", MoneyService.format(action.rec.balance), "§a"), UI.kv("Last Seen", action.rec.lastSeen ? new Date(action.rec.lastSeen).toLocaleString() : "Unknown")))
            .button(UI.BACK)
            .show(player);
        return this.topMoney(player, back, page);
    }
}

export default MoneyUI;
