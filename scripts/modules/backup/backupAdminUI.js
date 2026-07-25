// MCity Dashboard V2 - Backup / Restore Admin UI
// Phase 7 (v1.5.7): Permission re-checks after every form await.

import { ActionFormData, ModalFormData, MessageFormData } from "@minecraft/server-ui";
import { UI } from "../../uiTheme.js";
import { CONFIG } from "../../config.js";
import { Permissions } from "../../core/permissions.js";
import { UX } from "../../core/ux.js";
import { BackupService } from "./backupService.js";

function bytes(n) { if (n > 1024 * 1024) return (n / 1024 / 1024).toFixed(2) + "MB"; if (n > 1024) return (n / 1024).toFixed(1) + "KB"; return n + "B"; }
function canBackup(player) { return Permissions.canAccessBackupRestore(player); }
function denied(player) { return UX.noPermission(player, "Backup / Restore", p => import("../../dashboard/adminDashboard.js").then(m => m.AdminDashboard.open(p))); }
function ensureBackup(player) { if (canBackup(player)) return true; try { player.sendMessage(CONFIG.PREFIX + "§cPermission changed. Backup action cancelled."); } catch {} return false; }

export class BackupAdminUI {
    static async open(player) {
        if (!canBackup(player)) return denied(player);
        const s = BackupService.stats();
        const form = new ActionFormData()
            .title(UI.title(UI.ICON.backup, "Backup / Restore"))
            .body(UI.body(`§7Backups: §f${s.count}/${s.max}`, `§7Total Size: §f${bytes(s.totalSize)}`, `§7Latest: §f${s.latest ? s.latest.label : "none"}`))
            .button("§aCreate Backup")
            .button("§fList / Restore Backups")
            .button("§eBackup Stats")
            .button("§fImport Backup Chunk")
            .button(UI.BACK);
        const r = await form.show(player);
        if (!ensureBackup(player)) return;
        if (r.canceled) return; if (r.selection === 4) return this.#back(player);
        if (r.selection === 0) return this.create(player);
        if (r.selection === 1) return this.list(player);
        if (r.selection === 2) { player.sendMessage(`§6Backups: §f${s.count}/${s.max} §7Size §f${bytes(s.totalSize)}`); return this.open(player); }
        if (r.selection === 3) return this.importChunk(player);
    }

    static async create(player) {
        if (!canBackup(player)) return denied(player);
        const r = await new ModalFormData()
            .title("§aCreate Backup")
            .textField("Label", "before_update", { defaultValue: `manual_${new Date().toISOString().slice(0, 10)}` })
            .show(player);
        if (!ensureBackup(player)) return;
        if (r.canceled) return;
        const res = BackupService.create(r.formValues[0], player.name);
        player.sendMessage(res.success ? `§aBackup created: §f${res.backup.id} §7(${bytes(res.backup.totalSize)})` : `§cBackup failed: ${res.error}`);
        return this.open(player);
    }

    static async list(player) {
        if (!canBackup(player)) return denied(player);
        const list = BackupService.list();
        const form = new ActionFormData().title(UI.title(UI.ICON.backup, "Backups")).body(UI.body(`§7Count: §f${list.length}`));
        const actions = [];
        for (const b of list) { form.button(`§f${b.label}\n§f${new Date(b.createdAt).toLocaleString()} §e${bytes(b.totalSize)}`); actions.push(b.id); }
        form.button(UI.BACK); actions.push("back");
        const r = await form.show(player);
        if (!ensureBackup(player)) return;
        const action = actions[r.selection];
        if (r.canceled) return; if (action === "back" || !action) return this.open(player);
        return this.details(player, action);
    }

    static async details(player, id) {
        if (!canBackup(player)) return denied(player);
        const b = BackupService.get(id);
        if (!b) { player.sendMessage("§cBackup not found."); return this.list(player); }
        const form = new ActionFormData()
            .title(UI.title(UI.ICON.backup, "Backup Details"))
            .body(UI.body(`§7ID: §f${b.id}`, `§7Label: §f${b.label}`, `§7Created: §f${new Date(b.createdAt).toLocaleString()}`, `§7By: §f${b.createdBy}`, `§7Version: §f${b.projectVersion}`, `§7Size: §f${bytes(b.totalSize)}`, `§7Collections: §f${b.collectionNames.join(", ")}`))
            .button("§aRestore All")
            .button("§fExport Text Chunks")
            .button("§cDelete Backup")
            .button(UI.BACK);
        const r = await form.show(player);
        if (!ensureBackup(player)) return;
        if (r.canceled) return; if (r.selection === 3) return this.list(player);

        if (r.selection === 0) {
            const c = await new MessageFormData()
                .title("§cConfirm Restore")
                .body("Restore will overwrite current collections. An automatic backup will be created first. Continue?")
                .button1("§cCancel")
                .button2("§aRestore")
                .show(player);
            if (!ensureBackup(player)) return;
            if (!c.canceled && c.selection === 1) {
                const res = BackupService.restore(id, player.name);
                player.sendMessage(`§aRestore done. Restored: §f${res.restored.join(", ")} ${res.failed.length ? "§cFailed: " + res.failed.join(", ") : ""}`);
            }
        } else if (r.selection === 1) {
            const ex = BackupService.exportTextChunks(id);
            if (!ex.success) player.sendMessage("§cExport failed: " + ex.message);
            else { player.sendMessage(`§6Backup export ${ex.id}: §e${ex.total} chunks. Copy all chunks.`); for (const line of ex.chunks) player.sendMessage(line); }
        } else if (r.selection === 2) {
            const c = await new MessageFormData()
                .title("§cDelete Backup")
                .body(`Delete backup ${b.label}?`)
                .button1("§cCancel")
                .button2("§aDelete")
                .show(player);
            if (!ensureBackup(player)) return;
            if (!c.canceled && c.selection === 1) {
                const res = BackupService.delete(id, player.name);
                player.sendMessage(res.success ? "§aBackup deleted." : `§cDelete failed: ${res.error}`);
            }
        }
        return this.open(player);
    }

    static async importChunk(player) {
        if (!canBackup(player)) return denied(player);
        const r = await new ModalFormData().title("§dImport Backup Chunk").textField("Paste one backup chunk", "MCITYB:...").show(player);
        if (!ensureBackup(player)) return;
        if (r.canceled) return;
        const res = BackupService.importTextChunk(r.formValues[0], player.name);
        player.sendMessage(res.success ? (res.complete ? `§aImport complete: ${res.backupId}` : `§eChunk accepted: ${res.received}/${res.total}`) : `§cImport failed: ${res.message}`);
        return this.open(player);
    }

    static #back(player) { return import("../../dashboard/dashboardSystem.js").then(m => m.DashboardSystem.open(player)); }
}

export default BackupAdminUI;
