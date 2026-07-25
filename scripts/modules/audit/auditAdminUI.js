// MCity Dashboard V2 - Audit Admin UI
// Phase 7 (v1.5.7): Permission re-checks after audit admin forms.

import { ActionFormData, ModalFormData } from "@minecraft/server-ui";
import { UI } from "../../uiTheme.js";
import { Permissions } from "../../core/permissions.js";
import { AuditService } from "./auditService.js";

function canAudit(player) { return Permissions.canAccessAdminCenter(player); }
function lost(player) { if (canAudit(player)) return false; try { player.sendMessage("§cPermission changed. Action cancelled."); } catch {} return true; }
function eTitle(e) { return String(e.type || "Audit Event").substring(0, 40); }

export class AuditAdminUI {
    static async open(player) {
        if (!canAudit(player)) return;
        const s = AuditService.stats();
        const form = new ActionFormData()
            .title(UI.title(UI.ICON.audit, "Audit / Health"))
            .body(UI.body(`§7Events: §f${s.storedEvents}/${s.totalEvents}`, `§7Health Snapshots: §f${s.healthSnapshots}`, `§7Last Event: §f${s.lastEventAt ? new Date(s.lastEventAt).toLocaleString() : "none"}`))
            .button("§fCreate Health Snapshot")
            .button("§fRecent Events")
            .button("§eAudit Stats")
            .button("§fSearch Events")
            .button(UI.BACK);
        const r = await form.show(player);
        if (lost(player)) return;
        if (r.canceled) return; if (r.selection === 4) return this.#back(player);
        if (r.selection === 0) { AuditService.createHealthSnapshot("admin_ui"); return this.open(player); }
        if (r.selection === 1) return this.recent(player);
        if (r.selection === 2) { player.sendMessage(AuditService.formatStats()); return this.open(player); }
        if (r.selection === 3) return this.search(player);
    }

    static async recent(player, filter = null, page = 0) {
        if (!canAudit(player)) return;
        const arr = AuditService.recent(100, filter);
        const per = 8, total = Math.max(1, Math.ceil(arr.length / per));
        page = Math.max(0, Math.min(page, total - 1));
        const slice = arr.slice(page * per, page * per + per);
        const form = new ActionFormData().title(UI.title(UI.ICON.audit, "Recent Audit Events")).body(UI.body(`§7Filter: §f${filter || "all"}`, `§7Page: §f${page + 1}/${total}`));
        const actions = [];
        for (const e of slice) { form.button(`§e${e.type}\n§f${e.source} §e| §f${e.actorName || "system"}`); actions.push({ type: "view", e }); }
        if (page < total - 1) { form.button(UI.NEXT); actions.push({ type: "next" }); }
        if (page > 0) { form.button(UI.PREV); actions.push({ type: "prev" }); }
        form.button(UI.BACK); actions.push({ type: "back" });
        const r = await form.show(player);
        if (lost(player)) return;
        if (r.canceled) return;
        const a = actions[r.selection];
        if (!a || a.type === "back") return this.open(player);
        if (a.type === "next") return this.recent(player, filter, page + 1);
        if (a.type === "prev") return this.recent(player, filter, page - 1);
        await new ActionFormData()
            .title(UI.title(UI.ICON.audit, eTitle(a.e)))
            .body(UI.body(`§7Type: §f${a.e.type}`, `§7Source: §f${a.e.source}`, `§7Severity: §f${a.e.severity}`, `§7Actor: §f${a.e.actorName || "-"}`, `§7Time: §f${new Date(a.e.time).toLocaleString()}`, "", `§f${a.e.message || "-"}`))
            .button(UI.BACK)
            .show(player);
        if (lost(player)) return;
        return this.recent(player, filter, page);
    }

    static async search(player) {
        if (!canAudit(player)) return;
        const r = await new ModalFormData().title("§dSearch Audit").textField("Filter text", "market / land / player").show(player);
        if (lost(player)) return;
        if (r.canceled) return;
        return this.recent(player, String(r.formValues[0] || "").trim() || null, 0);
    }

    static #back(player) { return import("../../dashboard/dashboardSystem.js").then(m => m.DashboardSystem.open(player)); }
}

export default AuditAdminUI;
