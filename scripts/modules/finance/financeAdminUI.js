// MCity Dashboard V2 - Finance Admin UI Foundation
// Phase 3: minimal dashboard-ready admin finance reports. Full Admin Center arrives later.

import { ActionFormData } from "@minecraft/server-ui";
import { UI } from "../../core/uiTheme.js";
import { MoneyUtils } from "../../core/moneyUtils.js";
import { Permissions } from "../../core/permissions.js";
import { FinanceService } from "./financeService.js";
import { FinancialRecoveryService } from "../../core/financialRecoveryService.js";

function bucketLines(name, bucket) {
    if (!bucket) return [`§7${name}: §8missing`];
    return Object.entries(bucket).map(([k, v]) => `§7${k}: §e${MoneyUtils.formatCents(v || 0)}`);
}

function __mcityCan(player) { return Permissions.canAccessAdminCenter(player); }
function __mcityLost(player) { if (__mcityCan(player)) return false; try { player.sendMessage("§cPermission changed. Action cancelled."); } catch {} return true; }

export class FinanceAdminUI {
    static async open(player) {
        if (!Permissions.canAccessAdminCenter(player)) return;
        const stats = FinanceService.getStats();
        const recovery = FinancialRecoveryService.stats();
        const form = new ActionFormData()
            .title(UI.title(UI.ICON.finance, "Finance Admin"))
            .body(UI.body(
                `§7Pending: §f${stats.pendingCount} payouts / ${stats.pendingPlayers} players §8= §e${MoneyUtils.formatCents(stats.pendingAmount)}`,
                `§7Reserved: §f${stats.reservedCount} payout(s) / ${stats.activeClaims} active claim(s) §8= §e${MoneyUtils.formatCents(stats.reservedAmount)}`,
                `§7Canonical transactions: §f${stats.txCount}`,
                `§7Payout routing: ${stats.payoutRouting.healthy ? "§a" : "§c"}${stats.payoutRouting.base}/${stats.payoutRouting.shardCount}`,
                `§7Ledger migration: ${stats.ledgerMeta.legacyMigrationComplete ? "§aComplete" : "§eIn progress"}`,
                `§7Latest reconcile: §f${recovery.latest?.status || "never"} §8(${recovery.latest?.findingCount || 0} finding(s))`,
                `§7Treasury In/Out: §a${MoneyUtils.formatCents(stats.stats.totalTreasuryIn || 0)} §8/ §c${MoneyUtils.formatCents(stats.stats.totalTreasuryOut || 0)}`
            ))
            .button("§fTreasury Overview")
            .button("§fRecent Transactions")
            .button("§aFinance Repair")
            .button("§eRun Financial Audit")
            .button("§6Run Safe Recovery")
            .button("§fLatest Reconcile Report")
            .button(UI.BACK);
        const result = await form.show(player);
        if (__mcityLost(player)) return;
        if (result.canceled) return; if (result.selection === 6) return this.#back(player);
        if (result.selection === 0) return this.treasury(player);
        if (result.selection === 1) return this.transactions(player);
        if (result.selection === 2) {
            const r = FinanceService.repair();
            player.sendMessage(`§aFinance repair complete. Summaries ${r.summariesRebuilt || 0}, malformed-zero ${r.malformedZeroRemoved || 0}, orphan reservations ${r.orphanReservations || 0}, payout trims ${r.trimmed || 0}.`);
            return this.open(player);
        }
        if (result.selection === 3 || result.selection === 4) {
            const started = FinancialRecoveryService.start(result.selection === 4 ? "RECOVER_SAFE" : "AUDIT_ONLY", player.id);
            player.sendMessage(started.success ? `§aReconcile queued: §f${started.reportId}` : `§cReconcile failed: ${started.error || started.message}`);
            return this.open(player);
        }
        if (result.selection === 5) return this.reconcileReport(player);
    }

    static async reconcileReport(player) {
        const report = FinancialRecoveryService.latest();
        const lines = report ? [
            `§7ID: §f${report.id}`, `§7Status: §f${report.status}`, `§7Mode: §f${report.mode}`,
            `§7Stage: §f${report.stage}`, `§7Findings: §e${report.findingCount || 0}`,
            ...Object.entries(report.components || {}).map(([name, value]) => `§7${name}: §f${value?.status || "unknown"}`),
            ...((report.findings || []).slice(0, 12).map(f => `§c${f.code}: §7${f.operationId || f.playerId || f.collection || f.detail}`))
        ] : ["§eNo financial reconcile report exists."];
        await new ActionFormData().title(UI.title(UI.ICON.finance, "Financial Reconcile")).body(UI.body(...lines)).button(UI.BACK).show(player);
        return this.open(player);
    }

    static async treasury(player) {
        const t = FinanceService.getStats().treasury;
        const lines = [
            "§6Server", ...bucketLines("server", t.server), "",
            "§2Land", ...bucketLines("land", t.land), "",
            "§dMarket", ...bucketLines("market", t.market), "",
            "§5Contracts", ...bucketLines("contracts", t.contracts), "",
            "§3ATM / Burn", `§7ATM Minted: §a${MoneyUtils.formatCents(t.atm?.minted || 0)}`, `§7Burned: §c${MoneyUtils.formatCents(t.burned?.total || 0)}`
        ];
        await new ActionFormData().title(UI.title(UI.ICON.finance, "Treasury Overview")).body(UI.body(...lines)).button(UI.BACK).show(player);
        return this.open(player);
    }

    static async transactions(player, page = 0) {
        const all = FinanceService.recentTransactions(100);
        const per = 8;
        const totalPages = Math.max(1, Math.ceil(all.length / per));
        page = Math.max(0, Math.min(page, totalPages - 1));
        const slice = all.slice(page * per, page * per + per);
        const form = new ActionFormData().title(UI.title(UI.ICON.finance, "Finance Transactions")).body(UI.body(`§7Page: §f${page + 1}/${totalPages}`, `§7Stored: §f${all.length}`));
        const actions = [];
        for (const tx of slice) {
            form.button(`§e${tx.type || "tx"}\n§f${MoneyUtils.formatCents(tx.amount || 0)} §e| §f${String(tx.reason || "").substring(0, 35)}`);
            actions.push({ type: "view", tx });
        }
        if (page < totalPages - 1) { form.button(UI.NEXT); actions.push({ type: "next" }); }
        if (page > 0) { form.button(UI.PREV); actions.push({ type: "prev" }); }
        form.button(UI.BACK); actions.push({ type: "back" });
        const result = await form.show(player);
        if (__mcityLost(player)) return;
        if (result.canceled) return;
        const action = actions[result.selection];
        if (!action || action.type === "back") return this.open(player);
        if (action.type === "next") return this.transactions(player, page + 1);
        if (action.type === "prev") return this.transactions(player, page - 1);
        await new ActionFormData()
            .title(UI.title(UI.ICON.finance, "Transaction Details"))
            .body(UI.body(
                UI.kv("Type", action.tx.type || "tx"),
                UI.kv("Amount", MoneyUtils.formatCents(action.tx.amount || 0), "§e"),
                UI.kv("Source", action.tx.source || "-"),
                UI.kv("Bucket", action.tx.bucket || "-"),
                UI.kv("Reason", action.tx.reason || "-"),
                UI.kv("Time", new Date(action.tx.createdAt).toLocaleString())
            ))
            .button(UI.BACK)
            .show(player);
        return this.transactions(player, page);
    }

    static #back(player) {
        return import("../../dashboard/dashboardSystem.js").then(m => m.DashboardSystem.open(player));
    }
}

export default FinanceAdminUI;
