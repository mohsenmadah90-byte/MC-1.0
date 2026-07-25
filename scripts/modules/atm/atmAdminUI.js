// MCity Dashboard V2 - ATM Admin UI
// Phase 15: lists, details, integrity and repair tools.

import { ItemStack } from "@minecraft/server";
import { ActionFormData, ModalFormData, MessageFormData } from "@minecraft/server-ui";
import { CONFIG } from "../../config.js";
import { UI } from "../../core/uiTheme.js";
import { Permissions } from "../../core/permissions.js";
import { MoneyUtils } from "../../core/moneyUtils.js";
import { ATMLimits } from "./atmLimits.js";
import { ATMService } from "./atmService.js";

const AC = CONFIG.ATM;
function fmtTime(t){return t ? new Date(t).toLocaleString() : "Never";}

function __mcityCan(player) { return Permissions.canManageATM(player); }
function __mcityLost(player) { if (__mcityCan(player)) return false; try { player.sendMessage("§cPermission changed. Action cancelled."); } catch {} return true; }

export class ATMAdminUI {
    static createHook(name, display) { const item = new ItemStack(AC.SETUP_HOOK, 1); try { item.nameTag = display || name; item.setLore(["§7MCity ATM setup hook", `§8Use on chest: ${name}`]); } catch {} return item; }
    static giveHook(player, name) { const inv = player.getComponent("minecraft:inventory")?.container; if (!inv) return false; const item = this.createHook(name, `§6§l${name}`); return !inv.addItem(item); }

    static async open(player) {
        if (!Permissions.canManageATM(player)) return;
        const atm = ATMService.atmDB(), src = ATMService.sourceDB();
        const form = new ActionFormData().title(UI.title(UI.ICON.atm, "ATM Admin"))
            .body(UI.body(
                `§7Waiting ATMs: §f${Object.keys(atm.waiting).length}`,
                `§7Active ATMs: §a${Object.keys(atm.active).length}`,
                `§7Sources: §e${Object.keys(src.sources).length}`,
                `§7Exchanges: §f${atm.stats.totalExchanges || 0}`
            ))
            .button("§aGive ATM Hook")
            .button("§fGive Source Hook")
            .button("§eGive Setting Hook")
            .button("§aATM List")
            .button("§fSource List")
            .button("§fIntegrity Check")
            .button("§aRepair Integrity")
            .button("§cReset Online Limits")
            .button("§fATM Help")
            .button(UI.BACK);
        const r = await form.show(player); if (r.canceled) return; if (r.selection === 9) return this.#back(player);
        if (__mcityLost(player)) return;
        if (r.selection === 0) { this.giveHook(player, AC.HOOK_ATM_NAME); player.sendMessage(CONFIG.PREFIX + "§aATM hook given."); return this.open(player); }
        if (r.selection === 1) { this.giveHook(player, AC.HOOK_SOURCE_NAME); player.sendMessage(CONFIG.PREFIX + "§aSource hook given."); return this.open(player); }
        if (r.selection === 2) { this.giveHook(player, AC.HOOK_SETTING_NAME); player.sendMessage(CONFIG.PREFIX + "§aSetting hook given."); return this.open(player); }
        if (r.selection === 3) return this.atmList(player, "all", 0);
        if (r.selection === 4) return this.sourceList(player, 0);
        if (r.selection === 5) return this.integrity(player, false);
        if (r.selection === 6) return this.integrity(player, true);
        if (r.selection === 7) { ATMLimits.resetAllOnline(); player.sendMessage(CONFIG.PREFIX + "§aATM limits reset for online players."); return this.open(player); }
        if (r.selection === 8) return this.help(player);
    }

    static async atmList(player, filter = "all", page = 0) {
        const list = ATMService.listATMs(filter);
        const per = 8, total = Math.max(1, Math.ceil(list.length / per));
        page = Math.max(0, Math.min(page, total - 1));
        const slice = list.slice(page * per, page * per + per);
        const form = new ActionFormData().title(UI.title(UI.ICON.atm, "ATM List"))
            .body(UI.body(`§7Filter: §f${filter}`, `§7Count: §f${list.length}`, `§7Page: §f${page+1}/${total}`));
        const actions = [];
        form.button("§aAll"); actions.push({type:"filter",filter:"all"});
        form.button("§aActive"); actions.push({type:"filter",filter:"active"});
        form.button("§eWaiting"); actions.push({type:"filter",filter:"waiting"});
        for (const entry of slice) { form.button(`${entry.status === "active" ? "§a" : "§e"}${entry.code}\n§f${entry.atm.location} ${entry.atm.sourceCode ? "src "+entry.atm.sourceCode : "waiting"}`); actions.push({type:"atm",code:entry.code}); }
        if (page < total - 1) { form.button(UI.NEXT); actions.push({type:"next"}); }
        if (page > 0) { form.button(UI.PREV); actions.push({type:"prev"}); }
        form.button(UI.BACK); actions.push({type:"back"});
        const r = await form.show(player); const a = actions[r.selection];
        if (__mcityLost(player)) return;
        if (r.canceled) return; if (!a || a.type === "back") return this.open(player);
        if (a.type === "filter") return this.atmList(player, a.filter, 0);
        if (a.type === "next") return this.atmList(player, filter, page + 1);
        if (a.type === "prev") return this.atmList(player, filter, page - 1);
        if (a.type === "atm") return this.atmDetails(player, a.code, filter, page);
    }

    static async atmDetails(player, code, filter = "all", page = 0) {
        const entry = ATMService.getATMByCode(code);
        if (!entry) { player.sendMessage(CONFIG.PREFIX + "§cATM not found."); return this.atmList(player, filter, page); }
        const a = entry.atm;
        const form = new ActionFormData().title(UI.title(UI.ICON.atm, `ATM ${code}`))
            .body(UI.body(
                `§7Status: ${entry.status === "active" ? "§aActive" : "§eWaiting"}`,
                `§7Location: §f${a.location}`,
                `§7Dimension: §f${a.dimension}`,
                `§7Owner: §f${a.owner}`,
                `§7Source: §f${a.sourceCode || "None"}`,
                `§7Transactions: §f${a.totalTransactions || 0}`,
                `§7Minted: §a${MoneyUtils.formatCents(a.totalMoneyMinted || 0)}`,
                `§7Score Given: §b${a.totalScoreGiven || 0}`,
                `§7Last Used: §f${fmtTime(a.lastUsedAt)}`
            ));
        if (entry.status === "active") form.button("§eForce Move To Waiting");
        form.button("§cDelete ATM From DB");
        form.button(UI.BACK);
        const r = await form.show(player);
        if (__mcityLost(player)) return;
        const forceIndex = entry.status === "active" ? 0 : -1;
        const deleteIndex = entry.status === "active" ? 1 : 0;
        const backIndex = entry.status === "active" ? 2 : 1;
        if (r.canceled) return; if (r.selection === backIndex) return this.atmList(player, filter, page);
        if (r.selection === forceIndex) { const res = ATMService.forceWaiting(code); player.sendMessage(CONFIG.PREFIX + res.message); return this.atmDetails(player, code, filter, page); }
        if (r.selection === deleteIndex) return this.confirmDeleteATM(player, code, filter, page);
    }

    static async confirmDeleteATM(player, code, filter, page) {
        const conf = await new MessageFormData().title("§cDelete ATM").body(`Delete ATM §f${code}§r from database?\nThis does not remove the physical chest if it still exists.`).button1("§cCancel").button2("§aDelete").show(player);
        if (__mcityLost(player)) return;
        if (conf.canceled) return; if (conf.selection !== 1) return this.atmDetails(player, code, filter, page);
        const res = ATMService.deleteATM(code); player.sendMessage(CONFIG.PREFIX + res.message); return this.atmList(player, filter, page);
    }

    static async sourceList(player, page = 0) {
        const list = ATMService.listSources(); const per = 8, total = Math.max(1, Math.ceil(list.length / per));
        page = Math.max(0, Math.min(page, total - 1)); const slice = list.slice(page * per, page * per + per);
        const form = new ActionFormData().title(UI.title(UI.ICON.atm, "Source List")).body(UI.body(`§7Sources: §f${list.length}`, `§7Page: §f${page+1}/${total}`)); const actions=[];
        for (const e of slice) { form.button(`§f${e.code}\n§fATMs ${e.source.atmCodes.length} §e${e.source.location}`); actions.push({type:"source",code:e.code}); }
        if (page < total - 1) { form.button(UI.NEXT); actions.push({type:"next"}); }
        if (page > 0) { form.button(UI.PREV); actions.push({type:"prev"}); }
        form.button(UI.BACK); actions.push({type:"back"});
        const r = await form.show(player); const a=actions[r.selection];
        if (__mcityLost(player)) return;
        if (r.canceled) return; if (!a || a.type === "back") return this.open(player);
        if (a.type === "next") return this.sourceList(player, page + 1);
        if (a.type === "prev") return this.sourceList(player, page - 1);
        return this.sourceDetails(player, a.code, page);
    }

    static async sourceDetails(player, code, page = 0, ctx = {}) {
        const entry = ATMService.getSourceByCode(code); if (!entry) { player.sendMessage(CONFIG.PREFIX + "§cSource not found."); return ctx.fromWorld ? undefined : this.sourceList(player, page); }
        const s = entry.source;
        const form = new ActionFormData().title(UI.title(UI.ICON.atm, `Source ${code}`)).body(UI.body(
            `§7Location: §f${s.location}`,
            `§7Dimension: §f${s.dimension}`,
            `§7Owner: §f${s.owner}`,
            `§7Linked ATMs: §f${s.atmCodes.length}`,
            `§7Transactions: §f${s.totalTransactions || 0}`,
            `§7Total Earned: §a${MoneyUtils.formatCents(s.totalEarned || 0)}`,
            `§7Last Used: §f${fmtTime(s.lastUsedAt)}`
        )).button("§aLink ATM").button("§cUnlink ATM").button("§eClean Invalid Links").button("§cDelete Source From DB").button(UI.BACK);
        const r = await form.show(player); if (r.canceled) return; if (r.selection === 4) return ctx.fromWorld ? undefined : this.sourceList(player, page);
        if (__mcityLost(player)) return;
        if (r.selection === 0) return this.linkATM(player, code, ctx);
        if (r.selection === 1) return this.unlinkATM(player, code, s.atmCodes, ctx);
        if (r.selection === 2) { const rep = ATMService.integrityCheck(true); player.sendMessage(CONFIG.PREFIX + `§aRepair complete. Removed invalid links: ${rep.removedInvalidLinks || 0}`); return this.sourceDetails(player, code, page, ctx); }
        if (r.selection === 3) return this.confirmDeleteSource(player, code, page, ctx);
    }

    static async confirmDeleteSource(player, code, page, ctx = {}) {
        const conf = await new MessageFormData().title("§cDelete Source").body(`Delete Source §f${code}§r from database?\nLinked ATMs will be moved to waiting.`).button1("§cCancel").button2("§aDelete").show(player);
        if (__mcityLost(player)) return;
        if (conf.canceled) return; if (conf.selection !== 1) return this.sourceDetails(player, code, page, ctx);
        const res = ATMService.deleteSource(code); player.sendMessage(CONFIG.PREFIX + res.message); return ctx.fromWorld ? undefined : this.sourceList(player, page);
    }

    static async integrity(player, repair = false) {
        const report = ATMService.integrityCheck(repair);
        await new ActionFormData().title(UI.title(UI.ICON.atm, repair ? "ATM Repair Integrity" : "ATM Integrity Check")).body(UI.body(
            `§7Orphan Active ATMs: §f${report.orphanActive || 0}`,
            `§7Invalid Source ATM Codes: §f${report.invalidSourceAtmCodes || 0}`,
            `§7Duplicate Source Links: §f${report.duplicateSourceLinks || 0}`,
            `§7Waiting Missing Location: §f${report.waitingWithoutLocation || 0}`,
            `§7Active Missing Location: §f${report.activeWithoutLocation || 0}`,
            `§7Duplicate Code History: §f${report.duplicateCodes || 0}`,
            repair ? `§7Moved To Waiting: §a${report.movedToWaiting || 0}` : "§8No changes made.",
            repair ? `§7Removed Invalid Links: §a${report.removedInvalidLinks || 0}` : "",
            repair ? `§7Removed Bad ATMs: §a${report.removedBadAtms || 0}` : ""
        )).button(UI.BACK).show(player);
        return this.open(player);
    }

    static async summary(player) { return this.atmList(player, "all", 0); }

    static async sourceManagement(player, block, ctx = {}) {
        if (!Permissions.canManageATM(player)) return;
        const info = ATMService.getSourceFromBlock(block); if (!info) { player.sendMessage(CONFIG.PREFIX + "§cSource not found."); return; }
        return this.sourceDetails(player, info.code, 0, ctx);
    }

    static async linkATM(player, sourceCode, ctx = {}) {
        if (!__mcityCan(player)) return;
        const r = await new ModalFormData().title("§aLink ATM").textField("ATM Code", "1234").show(player);
        if (__mcityLost(player)) return;
        if (r.canceled) return;
        const res = ATMService.linkATM(sourceCode, String(r.formValues[0] || ""));
        player.sendMessage(CONFIG.PREFIX + res.message);
        return this.sourceDetails(player, sourceCode, 0, ctx);
    }

    static async unlinkATM(player, sourceCode, codes, ctx = {}) {
        if (!__mcityCan(player)) return;
        if (!codes.length) { player.sendMessage(CONFIG.PREFIX + "§eNo linked ATMs."); return this.sourceDetails(player, sourceCode, 0, ctx); }
        const r = await new ModalFormData().title("§cUnlink ATM").dropdown("ATM", codes).show(player);
        if (__mcityLost(player)) return;
        if (r.canceled) return;
        const res = ATMService.unlinkATM(sourceCode, codes[r.formValues[0]]);
        player.sendMessage(CONFIG.PREFIX + res.message);
        return this.sourceDetails(player, sourceCode, 0, ctx);
    }

    static async help(player) {
        await new ActionFormData().title(UI.title(UI.ICON.atm, "ATM Admin Help")).body(UI.body(
            "§6Setup",
            "§7ATM: chest on emerald block, use hook named atm.",
            "§7Source: chest on netherite block, use hook named source.",
            "§7Manage Source: use hook named setting on Source chest.",
            "",
            "§6Repair",
            "§7Use Integrity Check/Repair if ATMs or Sources are deleted manually."
        )).button(UI.BACK).show(player);
        return this.open(player);
    }

    static #back(player) { return import("../../dashboard/dashboardSystem.js").then(m => m.DashboardSystem.open(player)); }
}

export default ATMAdminUI;
