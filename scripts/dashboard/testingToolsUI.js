// MCity Dashboard V2 - Testing Tools UI
// Phase 5 Polish: Expanded testing tools for stress testing, event triggers,
// and runtime introspection.
// Phase 7.5 (v0.22.0): Fixed button-index off-by-one (BACK ↔ Reset swap),
//                      added permission re-checks on every action method.
// Phase 7 (v1.5.7): Re-check permissions after every admin form await.

import { ItemStack } from "@minecraft/server";
import { ActionFormData, ModalFormData } from "@minecraft/server-ui";
import { UI } from "../core/uiTheme.js";
import { CONFIG } from "../config.js";
import { Permissions } from "../core/permissions.js";
import { MoneyUtils } from "../core/moneyUtils.js";
import { MoneyService } from "../modules/economy/moneyService.js";
import { LevelService } from "../modules/economy/levelService.js";
import { FinanceService } from "../modules/finance/financeService.js";
import { NotificationService } from "./dashboardNotifications.js";
import { ATMAdminUI } from "../modules/atm/atmAdminUI.js";
import { AuditService } from "../modules/audit/auditService.js";
import { Database } from "../core/database.js";
import { EventBus } from "../core/eventBus.js";
import { RateLimiter } from "../core/rateLimiter.js";
import { HotReload } from "../core/hotReload.js";
import { LandService } from "../modules/land/landService.js";
import { ContractService } from "../modules/contracts/contractService.js";
import { BackupService } from "../modules/backup/backupService.js";
import { Migrations } from "../core/migrations.js";
import { Logger } from "../core/logger.js";

const COMMON_ITEMS = [
    "minecraft:copper_ingot", "minecraft:iron_ingot", "minecraft:emerald", "minecraft:gold_ingot",
    "minecraft:diamond", "minecraft:netherite_ingot", "minecraft:wheat", "minecraft:cobblestone", "minecraft:glass"
];

function backAdmin(player) { return import("./adminDashboard.js").then(m => m.AdminDashboard.open(player)); }
function canTesting(player) { return Permissions.isOwner(player) || Permissions.canAccessAdminCenter(player); }
function denyIfLost(player) { if (canTesting(player)) return false; try { player.sendMessage(CONFIG.PREFIX + "§cPermission changed. Action cancelled."); } catch {} return true; }

export class TestingToolsUI {
    static async open(player) {
        if (!canTesting(player)) return;
        const form = new ActionFormData()
            .title(UI.title(UI.ICON.admin, "Testing Tools"))
            .body(UI.body("§7Owner/admin utilities for fast gameplay testing.", "§7Select a category:"))
            // Self-test utilities
            .button("§aGive Self Test Money")
            .button("§fGive Self Test Score")
            .button("§fCreate Self Test Payout")
            .button("§fCreate Self Test Notification")
            .button("§eGive Common Test Items")
            .button("§fGive ATM Setup Hooks")
            // System introspection
            .button("§fOpen System Summary")
            .button("§fRuntime State (HotReload/Migrations)")
            // Phase 5: stress / triggers
            .button("§cForce Tax Accrual")
            .button("§cForce Contract GC")
            .button("§cForce Backup (Full)")
            .button("§cForce Backup (Incremental)")
            .button("§fEmit Test EventBus Event")
            .button("§fClear All Rate Limits")
            .button("§fFlush HotReload State")
            .button("§fReset HotReload (Cold Boot Next)")
            .button(UI.BACK);

        const r = await form.show(player);
        if (denyIfLost(player)) return;
        if (r.canceled) return;
        // Phase 7.5 (v0.22.0) (DB1) CRITICAL FIX: Button-index mapping.
        // The form has 17 buttons (indices 0-16):
        //   0-5:   self-test utilities (6 buttons)
        //   6-7:   system introspection (2 buttons)
        //   8-14:  stress / triggers (7 buttons)
        //   15:    Reset HotReload (destructive)
        //   16:    BACK
        //
        // Previously the mapping was swapped: selection 15 went to BACK and
        // selection 16 went to resetHotReload. This meant clicking "Reset
        // HotReload (Cold Boot Next)" silently returned to the admin dashboard
        // (the destructive action never ran), and clicking "BACK" popped up
        // the reset confirmation dialog. An admin who reflexively clicked
        // "Confirm Reset" on the misplaced dialog would wipe the HotReload
        // state and cold-boot on the next reload.
        //
        // The fix below correctly maps 15 → resetHotReload, 16 → BACK.
        if (r.selection === 16) return backAdmin(player);
        if (r.selection === 0) return this.giveMoney(player);
        if (r.selection === 1) return this.giveScore(player);
        if (r.selection === 2) return this.testPayout(player);
        if (r.selection === 3) return this.testNotification(player);
        if (r.selection === 4) return this.giveItems(player);
        if (r.selection === 5) return this.giveATMHooks(player);
        if (r.selection === 6) return this.systemSummary(player);
        if (r.selection === 7) return this.runtimeState(player);
        if (r.selection === 8) return this.forceTaxAccrual(player);
        if (r.selection === 9) return this.forceContractGC(player);
        if (r.selection === 10) return this.forceBackup(player, true);
        if (r.selection === 11) return this.forceBackup(player, false);
        if (r.selection === 12) return this.emitTestEvent(player);
        if (r.selection === 13) return this.clearRateLimits(player);
        if (r.selection === 14) return this.flushHotReload(player);
        if (r.selection === 15) return this.resetHotReload(player);
    }

    static async giveMoney(player) {
        // Phase 7.5 (v0.22.0) (DB7): Re-check permission on every action.
        if (!canTesting(player)) return;
        const r = await new ModalFormData().title("§aGive Self Test Money").textField("Amount ($)", "10000.00", { defaultValue: "10000.00" }).show(player);
        if (denyIfLost(player)) return;
        if (r.canceled) return;
        const parsed = MoneyUtils.parseFloatToCents(r.formValues[0], false);
        if (!parsed.ok) { player.sendMessage(CONFIG.PREFIX + `§c${parsed.error}`); return this.open(player); }
        MoneyService.addMoney(player, parsed.cents, "admin.test.money");
        AuditService.record("admin.test.money", "admin", player.id, player.name, "Self test money", { amount: parsed.cents }, "warn");
        player.sendMessage(CONFIG.PREFIX + `§aAdded test money: §e${MoneyUtils.formatCents(parsed.cents)}`);
        return this.open(player);
    }

    static async giveScore(player) {
        const r = await new ModalFormData().title("§bGive Self Test Score").textField("Score", "100", { defaultValue: "100" }).show(player);
        if (denyIfLost(player)) return;
        if (r.canceled) return;
        const amount = Math.max(0, Math.floor(Number(r.formValues[0]) || 0));
        LevelService.addScore(player, amount, "admin.test.score");
        AuditService.record("admin.test.score", "admin", player.id, player.name, "Self test score", { amount }, "warn");
        player.sendMessage(CONFIG.PREFIX + `§aAdded test score: §b${amount}`);
        return this.open(player);
    }

    static async testPayout(player) {
        const r = await new ModalFormData().title("§6Create Self Test Payout").textField("Amount ($)", "1000.00", { defaultValue: "1000.00" }).textField("Reason", "Testing payout", { defaultValue: "Testing payout" }).show(player);
        if (denyIfLost(player)) return;
        if (r.canceled) return;
        const parsed = MoneyUtils.parseFloatToCents(r.formValues[0], false);
        if (!parsed.ok) { player.sendMessage(CONFIG.PREFIX + `§c${parsed.error}`); return this.open(player); }
        FinanceService.addPayout(player.id, parsed.cents, r.formValues[1] || "Testing payout", "admin_test", { fromId: player.id, fromName: player.name, toName: player.name });
        AuditService.record("admin.test.payout", "admin", player.id, player.name, "Self test payout", { amount: parsed.cents }, "warn");
        player.sendMessage(CONFIG.PREFIX + "§aTest payout created.");
        return this.open(player);
    }

    static async testNotification(player) {
        const r = await new ModalFormData().title("§dCreate Self Test Notification").textField("Title", "Test Notification", { defaultValue: "Test Notification" }).textField("Message", "This is a test notification.", { defaultValue: "This is a test notification." }).show(player);
        if (denyIfLost(player)) return;
        if (r.canceled) return;
        NotificationService.create(player.id, { type: "admin_test", source: "admin", title: r.formValues[0] || "Test Notification", message: r.formValues[1] || "Test notification", action: "notifications" });
        AuditService.record("admin.test.notification", "admin", player.id, player.name, "Self test notification", {}, "info");
        player.sendMessage(CONFIG.PREFIX + "§aTest notification created.");
        return this.open(player);
    }

    static async giveItems(player) {
        const form = new ActionFormData().title(UI.title("§e", "Give Common Test Items")).body(UI.body("§7Select an item to receive a stack of 64, or give the full test pack."));
        const actions = [];
        form.button("§aGive Full Test Pack"); actions.push({ type: "pack" });
        for (const item of COMMON_ITEMS) { form.button(`§f${item}\n§f64x`); actions.push({ type: "item", item }); }
        form.button(UI.BACK); actions.push({ type: "back" });
        const r = await form.show(player);
        if (denyIfLost(player)) return;
        const a = actions[r.selection];
        if (r.canceled) return; if (!a || a.type === "back") return this.open(player);
        if (a.type === "pack") { for (const item of COMMON_ITEMS) this.#giveItem(player, item, 64); AuditService.record("admin.test.items", "admin", player.id, player.name, "Gave self full test item pack", { items: COMMON_ITEMS }, "warn"); }
        if (a.type === "item") { this.#giveItem(player, a.item, 64); AuditService.record("admin.test.items", "admin", player.id, player.name, `Gave self ${a.item}`, { item: a.item, amount: 64 }, "warn"); }
        player.sendMessage(CONFIG.PREFIX + "§aTest items given. Check inventory space for leftovers.");
        return this.open(player);
    }

    static giveATMHooks(player) {
        if (!canTesting(player)) return;
        ATMAdminUI.giveHook(player, CONFIG.ATM.HOOK_ATM_NAME);
        ATMAdminUI.giveHook(player, CONFIG.ATM.HOOK_SOURCE_NAME);
        ATMAdminUI.giveHook(player, CONFIG.ATM.HOOK_SETTING_NAME);
        AuditService.record("admin.test.atm_hooks", "admin", player.id, player.name, "Gave ATM setup hooks", {}, "warn");
        player.sendMessage(CONFIG.PREFIX + "§aATM setup hooks given.");
        return this.open(player);
    }

    static async systemSummary(player) {
        if (!canTesting(player)) return;
        const lines = [`§7Version: §f${CONFIG.VERSION}`, `§7Collections: §f${Database.listCollections().length}`, ""];
        for (const name of Database.listCollections()) {
            const st = Database.stats(name);
            if (st) lines.push(`§7${name}: §f${(st.size / 1024).toFixed(1)}KB §8items §f${st.itemCount} §8dirty ${st.dirty ? "§eY" : "§aN"}`);
        }
        await new ActionFormData().title(UI.title(UI.ICON.system, "System Summary")).body(UI.body(...lines)).button(UI.BACK).show(player);
        return this.open(player);
    }

    /**
     * Phase 5: Show runtime state for HotReload and Migrations.
     */
    static async runtimeState(player) {
        if (!canTesting(player)) return;
        const hrStats = HotReload.stats();
        const migStats = Migrations.stats();
        const lines = [
            `§6§lHotReload`,
            `§7Initialized: §f${hrStats.initialized}`,
            `§7Was reload: §f${hrStats.wasReload}`,
            `§7Saved keys: §f${hrStats.keyCount}`,
            `§7Dirty: §f${hrStats.dirty}`,
            `§7Est. size: §f${hrStats.estimatedSizeBytes}B`,
            ``,
            `§6§lMigrations`,
            `§7Tracked collections: §f${Object.keys(migStats).length}`
        ];
        for (const [name, info] of Object.entries(migStats)) {
            lines.push(`§7${name}: §fv${info.latestVersion} §8(${info.registeredSteps} steps)`);
        }
        try {
            await new ActionFormData()
                .title(UI.title(UI.ICON.system, "Runtime State"))
                .body(UI.body(...lines))
                .button(UI.BACK)
                .show(player);
        } catch {}
        return this.open(player);
    }

    /**
     * Phase 5: Force the land tax accrual to run immediately. Useful for
     * testing the tax system without waiting for the 1-minute interval.
     */
    static async forceTaxAccrual(player) {
        // Phase 7.5 (v0.22.0) (DB7): Re-check permission.
        if (!canTesting(player)) return;
        try {
            const result = LandService.accrueTaxes(true);
            player.sendMessage(CONFIG.PREFIX + `§aTax accrual triggered: §f${JSON.stringify(result)}`);
            AuditService.record("admin.test.force_tax", "admin", player.id, player.name, "Forced tax accrual", { result }, "warn");
        } catch (error) {
            player.sendMessage(CONFIG.PREFIX + `§cTax accrual failed: ${error.message}`);
        }
        return this.open(player);
    }

    /**
     * Phase 5: Force the contract garbage collector to run immediately.
     */
    static async forceContractGC(player) {
        // Phase 7.5 (v0.22.0) (DB7): Re-check permission.
        if (!canTesting(player)) return;
        try {
            const count = ContractService.finalizeExpired();
            player.sendMessage(CONFIG.PREFIX + `§aContract GC: §f${count} contract(s) finalized.`);
            AuditService.record("admin.test.force_contract_gc", "admin", player.id, player.name, "Forced contract GC", { count }, "warn");
        } catch (error) {
            player.sendMessage(CONFIG.PREFIX + `§cContract GC failed: ${error.message}`);
        }
        return this.open(player);
    }

    /**
     * Phase 5: Force a backup, either full or incremental.
     */
    static async forceBackup(player, forceFull) {
        // Phase 7.5 (v0.22.0) (DB7): Re-check permission.
        if (!canTesting(player)) return;
        try {
            const result = BackupService.create(
                forceFull ? "admin_test_full" : "admin_test_incremental",
                player.name,
                null,
                { forceFull }
            );
            if (result.success) {
                player.sendMessage(CONFIG.PREFIX + `§aBackup created: §f${result.backup.id} §7(${result.backup.type}, ${result.backup.totalSize}B)`);
                AuditService.record("admin.test.force_backup", "admin", player.id, player.name, `Forced ${result.backup.type} backup`, { id: result.backup.id }, "warn");
            } else {
                player.sendMessage(CONFIG.PREFIX + `§cBackup failed: ${result.error}`);
            }
        } catch (error) {
            player.sendMessage(CONFIG.PREFIX + `§cBackup failed: ${error.message}`);
        }
        return this.open(player);
    }

    /**
     * Phase 5: Emit a test event on the EventBus. Useful for verifying
     * that subscribers are wired up correctly.
     */
    static async emitTestEvent(player) {
        if (!canTesting(player)) return;
        const r = await new ModalFormData()
            .title("§5Emit Test EventBus Event")
            .textField("Topic", "test.event", { defaultValue: "test.event" })
            .textField("Payload (JSON)", "{\"foo\":\"bar\"}", { defaultValue: "{\"foo\":\"bar\"}" })
            .show(player);
        if (r.canceled) return;
        const topic = r.formValues[0] || "test.event";
        let payload;
        try { payload = JSON.parse(r.formValues[1] || "{}"); }
        catch { payload = { raw: r.formValues[1] }; }
        EventBus.emit(topic, { ...payload, emittedBy: player.name, emittedAt: Date.now() });
        player.sendMessage(CONFIG.PREFIX + `§aEmitted event: §f${topic}`);
        AuditService.record("admin.test.emit_event", "admin", player.id, player.name, `Emitted ${topic}`, { topic }, "info");
        return this.open(player);
    }

    /**
     * Phase 5: Clear all rate-limit buckets. Useful for testing rate-limited
     * actions without waiting for the window to expire.
     */
    static async clearRateLimits(player) {
        // Phase 7.5 (v0.22.0) (DB7): Re-check permission.
        if (!canTesting(player)) return;
        RateLimiter.reset();
        player.sendMessage(CONFIG.PREFIX + "§aAll rate-limit buckets cleared.");
        AuditService.record("admin.test.clear_rate_limits", "admin", player.id, player.name, "Cleared all rate limits", {}, "warn");
        return this.open(player);
    }

    /**
     * Phase 5: Force-flush the HotReload state to disk.
     */
    static async flushHotReload(player) {
        // Phase 7.5 (v0.22.0) (DB7): Re-check permission.
        if (!canTesting(player)) return;
        HotReload.flush();
        player.sendMessage(CONFIG.PREFIX + "§aHotReload state flushed to disk.");
        AuditService.record("admin.test.flush_hot_reload", "admin", player.id, player.name, "Flushed HotReload state", {}, "info");
        return this.open(player);
    }

    /**
     * Phase 5: Reset HotReload state. The next reload will be a cold boot.
     */
    static async resetHotReload(player) {
        // Phase 7.5 (v0.22.0) (DB7): Re-check permission.
        if (!canTesting(player)) return;
        const confirm = await new ActionFormData()
            .title("§4Reset HotReload")
            .body(UI.body(
                "§cAre you sure?",
                "§7This will erase all saved hot-reload state.",
                "§7The next reload will be a cold boot."
            ))
            .button("§cConfirm Reset")
            .button("§aCancel")
            .show(player);
        if (denyIfLost(player)) return;
        if (confirm.canceled) return; if (confirm.selection === 1) return this.open(player);
        HotReload.reset();
        player.sendMessage(CONFIG.PREFIX + "§aHotReload state reset. Next reload will be cold boot.");
        AuditService.record("admin.test.reset_hot_reload", "admin", player.id, player.name, "Reset HotReload state", {}, "warn");
        return this.open(player);
    }

    static #giveItem(player, itemId, amount) {
        try { player.getComponent("minecraft:inventory")?.container?.addItem(new ItemStack(itemId, amount)); } catch {}
    }
}

export default TestingToolsUI;
