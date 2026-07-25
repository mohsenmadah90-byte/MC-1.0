// MCity Dashboard V2 - Player Management UI
// Phase 7.6 (v0.23.0): Use PlayerRegistry for O(1) lookups (S4).
// Phase 7 (v1.5.7): Re-check permissions after admin forms return.

import { world } from "@minecraft/server";
import { ActionFormData, ModalFormData } from "@minecraft/server-ui";
import { UI } from "../uiTheme.js";
import { CONFIG } from "../config.js";
import { Permissions } from "../core/permissions.js";
import { PlayerRegistry } from "../core/playerRegistry.js";
import { MoneyUtils } from "../core/moneyUtils.js";
import { MoneyService } from "../modules/economy/moneyService.js";
import { LevelService } from "../modules/economy/levelService.js";
import { FinanceService } from "../modules/finance/financeService.js";
import { NotificationService } from "./dashboardNotifications.js";
import { MarketService } from "../modules/market/marketService.js";
import { LandService } from "../modules/land/landService.js";
import { ContractService } from "../modules/contracts/contractService.js";
import { AuditService } from "../modules/audit/auditService.js";
import { RateLimiter } from "../core/rateLimiter.js";

// Phase 7.6 (v0.23.0) (S4): Use PlayerRegistry for O(1) lookups instead
// of world.getAllPlayers().find(...) which is O(N) per call.
function onlinePlayers() { return PlayerRegistry.online(); }
function findOnline(id) { return PlayerRegistry.getOnlineById(id); }
function backAdmin(player) { return import("./adminDashboard.js").then(m => m.AdminDashboard.open(player)); }
function ensureAdmin(admin) { if (Permissions.canAccessAdminCenter(admin)) return true; try { admin.sendMessage(CONFIG.PREFIX + "§cPermission changed. Action cancelled."); } catch {} return false; }

export class PlayerManagementUI {
    static async open(admin, page = 0) {
        if (!Permissions.canAccessAdminCenter(admin)) return;
        const players = onlinePlayers();
        // Phase 7.7 (v1.0.0): Paginate the player list (8 per page) to
        // avoid a 100+ button form on large servers.
        const per = CONFIG.UI.ITEMS_PER_PAGE || 8;
        const totalPages = Math.max(1, Math.ceil(players.length / per));
        page = Math.max(0, Math.min(page, totalPages - 1));
        const slice = players.slice(page * per, page * per + per);
        const form = new ActionFormData()
            .title(UI.title(UI.ICON.admin, "Player Management"))
            .body(UI.body(`§7Online Players: §f${players.length}`, `§7Page: §f${page + 1}/${totalPages}`, "§8Select a player to manage:"));
        const actions = [];
        for (const p of slice) {
            form.button(`§f${p.name}\n§f${p.id.substring(0, 18)}...`);
            actions.push({ type: "player", id: p.id });
        }
        if (page < totalPages - 1) { form.button(UI.NEXT); actions.push({ type: "next" }); }
        if (page > 0) { form.button(UI.PREV); actions.push({ type: "prev" }); }
        form.button(UI.BACK); actions.push({ type: "back" });
        const r = await form.show(admin);
        if (!ensureAdmin(admin)) return;
        if (r.canceled) return;
        const a = actions[r.selection];
        if (!a || a.type === "back") return backAdmin(admin);
        if (a.type === "next") return this.open(admin, page + 1);
        if (a.type === "prev") return this.open(admin, page - 1);
        if (a.type === "player") return this.playerMenu(admin, a.id);
    }

    static async playerMenu(admin, targetId) {
        // Phase 7.5 (v0.22.0) (DB7): Re-check permission.
        if (!Permissions.canAccessAdminCenter(admin)) return;
        const target = findOnline(targetId);
        if (!target) { admin.sendMessage(CONFIG.PREFIX + "§cPlayer is no longer online."); return this.open(admin); }
        const balance = MoneyService.getBalance(target);
        const score = LevelService.getScore(target);
        const level = LevelService.getLevelInfo(target);
        const payouts = FinanceService.pendingStats(target.id);
        const market = MarketService.mailboxStats(target);
        const land = LandService.stats(target);
        const contracts = ContractService.stats(target);
        const unread = NotificationService.unreadCount(target.id);

        const form = new ActionFormData()
            .title(UI.title(UI.ICON.admin, `Manage ${target.name}`))
            .body(UI.body(
                UI.kv("Balance", MoneyUtils.formatCents(balance), "§a"),
                `§7Level: ${level.color}[${level.name}] §8| §7Score: §b${score}`,
                `§7Payouts: §e${payouts.count} §8= §a${MoneyUtils.formatCents(payouts.amount)}`,
                `§7Land: §f${land.owned} owned §8| §e${MoneyUtils.formatCents(land.taxDebt)} tax`,
                `§7Contracts: §f${contracts.created} created §8| §b${contracts.accepted} accepted §8| §e${contracts.mailbox} deliveries`,
                `§7Market Mail: §e${market.count} §8| §7Notifications: §e${unread}`
            ))
            .button("§aSet Money")
            .button("§aAdd Money")
            .button("§cTake Money")
            .button("§eReset Money")
            .button("§fSet Score")
            .button("§fAdd Score")
            .button("§eReset Score")
            .button("§fCreate Test Payout")
            .button("§fCreate Test Notification")
            .button("§fView Detailed Summary")
            .button(UI.BACK);
        const r = await form.show(admin);
        if (!ensureAdmin(admin)) return;
        if (r.canceled) return; if (r.selection === 10) return this.open(admin);
        if (r.selection === 0) return this.setMoney(admin, target.id);
        if (r.selection === 1) return this.addMoney(admin, target.id, true);
        if (r.selection === 2) return this.addMoney(admin, target.id, false);
        if (r.selection === 3) return this.applyMoney(admin, target.id, 0, "set", "admin.money.reset");
        if (r.selection === 4) return this.setScore(admin, target.id);
        if (r.selection === 5) return this.addScore(admin, target.id);
        if (r.selection === 6) return this.applyScore(admin, target.id, 0, "set", "admin.score.reset");
        if (r.selection === 7) return this.createPayout(admin, target.id);
        if (r.selection === 8) return this.createNotification(admin, target.id);
        if (r.selection === 9) return this.details(admin, target.id);
    }

    static async setMoney(admin, targetId) {
        if (!ensureAdmin(admin)) return;
        const target = findOnline(targetId); if (!target) return this.open(admin);
        const r = await new ModalFormData().title("§aSet Money").textField(`New balance for ${target.name}`, "10000.00").show(admin);
        if (!ensureAdmin(admin)) return;
        if (r.canceled) return;
        const parsed = MoneyUtils.parseFloatToCents(r.formValues[0], false);
        if (!parsed.ok) { admin.sendMessage(CONFIG.PREFIX + `§c${parsed.error}`); return this.playerMenu(admin, targetId); }
        return this.applyMoney(admin, targetId, parsed.cents, "set", "admin.money.set");
    }

    static async addMoney(admin, targetId, positive = true) {
        if (!ensureAdmin(admin)) return;
        const target = findOnline(targetId); if (!target) return this.open(admin);
        const r = await new ModalFormData().title(positive ? "§aAdd Money" : "§cTake Money").textField(`Amount for ${target.name}`, "1000.00").show(admin);
        if (!ensureAdmin(admin)) return;
        if (r.canceled) return;
        const parsed = MoneyUtils.parseFloatToCents(r.formValues[0], false);
        if (!parsed.ok) { admin.sendMessage(CONFIG.PREFIX + `§c${parsed.error}`); return this.playerMenu(admin, targetId); }
        return this.applyMoney(admin, targetId, positive ? parsed.cents : -parsed.cents, "add", positive ? "admin.money.add" : "admin.money.take");
    }

    static applyMoney(admin, targetId, amount, mode, auditType) {
        // Phase 7.5 (v0.22.0) (DB7): Re-check permission.
        if (!Permissions.canAccessAdminCenter(admin)) return;
        const target = findOnline(targetId); if (!target) { admin.sendMessage(CONFIG.PREFIX + "§cPlayer is offline."); return this.open(admin); }
        const limit = CONFIG.RATE_LIMITS?.MONEY_SET;
        const limitKey = `admin_money_set:${admin.id}`;
        if (limit && !RateLimiter.check(limitKey, limit[0], limit[1])) {
            const retryMs = RateLimiter.retryIn(limitKey, limit[0], limit[1]);
            admin.sendMessage(CONFIG.PREFIX + `§cEconomy admin rate limit reached. Try again in ${Math.ceil(retryMs / 1000)}s.`);
            return this.playerMenu(admin, targetId);
        }
        const before = MoneyService.getBalance(target);
        const result = mode === "set" ? MoneyService.setBalance(target, amount, auditType) : MoneyService.addMoney(target, amount, auditType);
        if (!result || !result.success) {
            AuditService.record(auditType + ".failed", "admin", admin.id, admin.name, `${auditType} failed for ${target.name}`, { targetId, targetName: target.name, amount, before, error: result?.message }, "error");
            admin.sendMessage(CONFIG.PREFIX + `§cMoney update failed: ${result?.message || "unknown error"}`);
            return this.playerMenu(admin, targetId);
        }
        const after = MoneyService.getBalance(target);
        AuditService.record(auditType, "admin", admin.id, admin.name, `${auditType} ${target.name}`, { targetId, targetName: target.name, amount, before, after }, "warn");
        admin.sendMessage(CONFIG.PREFIX + `§aMoney updated for ${target.name}: §e${MoneyUtils.formatCents(after)}`);
        target.sendMessage(CONFIG.PREFIX + `§eYour balance was updated by staff: §a${MoneyUtils.formatCents(after)}`);
        return this.playerMenu(admin, targetId);
    }

    static async setScore(admin, targetId) {
        if (!ensureAdmin(admin)) return;
        const target = findOnline(targetId); if (!target) return this.open(admin);
        const r = await new ModalFormData().title("§bSet Score").textField(`New score for ${target.name}`, "100").show(admin);
        if (!ensureAdmin(admin)) return;
        if (r.canceled) return;
        const score = Math.max(0, Math.floor(Number(r.formValues[0]) || 0));
        return this.applyScore(admin, targetId, score, "set", "admin.score.set");
    }

    static async addScore(admin, targetId) {
        if (!ensureAdmin(admin)) return;
        const target = findOnline(targetId); if (!target) return this.open(admin);
        const r = await new ModalFormData().title("§bAdd Score").textField(`Score to add for ${target.name}`, "50").show(admin);
        if (!ensureAdmin(admin)) return;
        if (r.canceled) return;
        const score = Math.floor(Number(r.formValues[0]) || 0);
        return this.applyScore(admin, targetId, score, "add", "admin.score.add");
    }

    static applyScore(admin, targetId, amount, mode, auditType) {
        // Phase 7.5 (v0.22.0) (DB7): Re-check permission.
        if (!Permissions.canAccessAdminCenter(admin)) return;
        const target = findOnline(targetId); if (!target) { admin.sendMessage(CONFIG.PREFIX + "§cPlayer is offline."); return this.open(admin); }
        const before = LevelService.getScore(target);
        mode === "set" ? LevelService.setScore(target, amount, auditType) : LevelService.addScore(target, amount, auditType);
        const after = LevelService.getScore(target);
        AuditService.record(auditType, "admin", admin.id, admin.name, `${auditType} ${target.name}`, { targetId, targetName: target.name, amount, before, after }, "warn");
        admin.sendMessage(CONFIG.PREFIX + `§aScore updated for ${target.name}: §b${after}`);
        target.sendMessage(CONFIG.PREFIX + `§eYour score was updated by staff: §b${after}`);
        return this.playerMenu(admin, targetId);
    }

    static async createPayout(admin, targetId) {
        if (!ensureAdmin(admin)) return;
        const target = findOnline(targetId); if (!target) return this.open(admin);
        const r = await new ModalFormData().title("§6Create Test Payout").textField("Amount ($)", "1000.00").textField("Reason", "Admin test payout", { defaultValue: "Admin test payout" }).show(admin);
        if (!ensureAdmin(admin)) return;
        if (r.canceled) return;
        const parsed = MoneyUtils.parseFloatToCents(r.formValues[0], false);
        if (!parsed.ok) { admin.sendMessage(CONFIG.PREFIX + `§c${parsed.error}`); return this.playerMenu(admin, targetId); }
        const res = FinanceService.addPayout(target.id, parsed.cents, r.formValues[1] || "Admin test payout", "admin_test", { fromId: admin.id, fromName: admin.name, toName: target.name });
        AuditService.record("admin.test.payout", "admin", admin.id, admin.name, `Created test payout for ${target.name}`, { targetId, amount: parsed.cents }, "warn");
        admin.sendMessage(CONFIG.PREFIX + (res.success ? "§aTest payout created." : `§cFailed: ${res.message}`));
        return this.playerMenu(admin, targetId);
    }

    static async createNotification(admin, targetId) {
        if (!ensureAdmin(admin)) return;
        const target = findOnline(targetId); if (!target) return this.open(admin);
        const r = await new ModalFormData().title("§dCreate Test Notification").textField("Title", "Test Notification", { defaultValue: "Test Notification" }).textField("Message", "This is a test notification.", { defaultValue: "This is a test notification." }).show(admin);
        if (!ensureAdmin(admin)) return;
        if (r.canceled) return;
        NotificationService.create(target.id, { type: "admin_test", source: "admin", title: r.formValues[0] || "Test Notification", message: r.formValues[1] || "Test notification", action: "notifications", meta: { fromId: admin.id, fromName: admin.name } });
        AuditService.record("admin.test.notification", "admin", admin.id, admin.name, `Created test notification for ${target.name}`, { targetId }, "info");
        admin.sendMessage(CONFIG.PREFIX + "§aNotification created.");
        return this.playerMenu(admin, targetId);
    }

    static async details(admin, targetId) {
        if (!ensureAdmin(admin)) return;
        const target = findOnline(targetId); if (!target) return this.open(admin);
        const balance = MoneyService.getBalance(target);
        const progress = LevelService.getProgress(target);
        const payouts = FinanceService.pendingStats(target.id);
        const market = MarketService.mailboxStats(target);
        const land = LandService.stats(target);
        const contracts = ContractService.stats(target);
        const unread = NotificationService.unreadCount(target.id);
        await new ActionFormData()
            .title(UI.title(UI.ICON.profile, `${target.name} Summary`))
            .body(UI.body(
                UI.kv("ID", target.id),
                UI.kv("Balance", MoneyUtils.formatCents(balance), "§a"),
                `§7Level: ${progress.level.color}[${progress.level.name}] §8| §7Score: §b${progress.score}`,
                `§7Payouts: §e${payouts.count} §8= §a${MoneyUtils.formatCents(payouts.amount)}`,
                `§7Market Mail: §e${market.count} entries`,
                `§7Land: §f${land.owned} owned §8| §e${MoneyUtils.formatCents(land.taxDebt)} tax`,
                `§7Contracts: §f${contracts.created} created §8| §b${contracts.accepted} accepted §8| §e${contracts.mailbox} deliveries`,
                `§7Notifications: §e${unread} unread`
            ))
            .button(UI.BACK)
            .show(admin);
        return this.playerMenu(admin, targetId);
    }
}

export default PlayerManagementUI;
