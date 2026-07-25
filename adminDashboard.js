// MCity Dashboard V2 - Admin Center
// Phase 5: Release Polish
// Phase 4 Scalability: Health Check Dashboard integration

import { ActionFormData } from "@minecraft/server-ui";
import { CONFIG } from "../config.js";
import { UI } from "../uiTheme.js";
import { Database } from "../core/database.js";
import { Permissions } from "../core/permissions.js";
import { PlayerManagementUI } from "./playerManagementUI.js";
import { TestingToolsUI } from "./testingToolsUI.js";
import { HealthCheckUI } from "./healthCheckUI.js";
import { EconomyAdminUI } from "../modules/economy/economyAdminUI.js";
import { FinanceAdminUI } from "../modules/finance/financeAdminUI.js";
import { MarketAdminUI } from "../modules/market/marketAdminUI.js";
import { LandAdminUI } from "../modules/land/landAdminUI.js";
import { ContractAdminUI } from "../modules/contracts/contractAdminUI.js";
import { ATMAdminUI } from "../modules/atm/atmAdminUI.js";
import { AuditAdminUI } from "../modules/audit/auditAdminUI.js";
import { BackupAdminUI } from "../modules/backup/backupAdminUI.js";
import { AuditService } from "../modules/audit/auditService.js";
import { Logger } from "../core/logger.js";
import { FormUtils } from "../core/formUtils.js";
import { ErrorBoundary } from "../core/errorBoundary.js";

function fmtSize(bytes){return bytes>1024*1024?(bytes/1024/1024).toFixed(2)+"MB":bytes>1024?(bytes/1024).toFixed(1)+"KB":bytes+"B";}
function back(player){return import("./dashboardSystem.js").then(m=>m.DashboardSystem.open(player));}

export class AdminDashboard {
    static async open(player){
        if(!Permissions.canAccessAdminCenter(player))return;
        const collections=Database.listCollections();
        
        try {
            const form=new ActionFormData().title(UI.title(UI.ICON.admin,"Admin Center","Commandless control"))
                .body(UI.body(`§7Version: §f${CONFIG.VERSION}`,`§7Collections: §f${collections.length}`,`§7Select an admin module:`))
                .button("§fSystem Overview")
                .button("§aHealth Check")  // Phase 4: new
                .button("§ePlayer Management")
                .button("§fEconomy Admin")
                .button("§fMarket Admin")
                .button("§fLand Admin")
                .button("§fContract Admin")
                .button("§fATM Admin")
                .button("§fFinance Admin")
                .button("§fAudit / Health")
                .button("§fBackup / Restore")
                .button("§fDatabase Tools")
                .button("§aTesting Tools")
                .button(UI.BACK);
                
            const r=await form.show(player); 
            if (r.canceled) return; if (r.selection===13) return back(player);
            
            if(r.selection===0)return this.systemOverview(player);
            if(r.selection===1)return HealthCheckUI.open(player);
            if(r.selection===2)return PlayerManagementUI.open(player);
            if(r.selection===3)return EconomyAdminUI.open(player);
            if(r.selection===4)return MarketAdminUI.open(player);
            if(r.selection===5)return LandAdminUI.open(player);
            if(r.selection===6)return ContractAdminUI.open(player);
            if(r.selection===7)return ATMAdminUI.open(player);
            if(r.selection===8)return FinanceAdminUI.open(player);
            if(r.selection===9)return AuditAdminUI.open(player);
            if(r.selection===10)return BackupAdminUI.open(player);
            if(r.selection===11)return this.databaseTools(player);
            if(r.selection===12)return TestingToolsUI.open(player);
        } catch(e) {
            ErrorBoundary.report("AdminDashboard", e, { player, notify: false, level: "debug", message: "Admin Center form failed" });
        }
    }

    static async systemOverview(player){
        // Phase 7.5 (v0.22.0) (DB7): Re-check permission.
        if(!Permissions.canAccessAdminCenter(player))return;
        const collections=Database.listCollections();
        const lines=[`§7Version: §f${CONFIG.VERSION}`,`§7Collections: §f${collections.length}`,`§7Audit events: §f${AuditService.stats().storedEvents}`,`§7Log Level: §f${Logger.getLevel()}`,"", "§6Collections"];
        for(const name of collections){const st=Database.stats(name); if(st)lines.push(`§7${name}: §f${fmtSize(st.size)} §8items §f${st.itemCount} §8dirty ${st.dirty?"§eY":"§aN"}`);}
        
        try {
            await new ActionFormData().title(UI.title(UI.ICON.admin,"System Overview")).body(UI.body(...lines)).button(UI.BACK).show(player);
            return this.open(player);
        } catch(e) {
            ErrorBoundary.report("AdminDashboard", e, { player, notify: false, level: "debug", message: "System overview failed" });
        }
    }

    static async databaseTools(player){
        // Phase 7.5 (v0.22.0) (DB7): Re-check permission.
        if(!Permissions.canAccessAdminCenter(player))return;
        const collections=Database.listCollections();
        try {
            const form=new ActionFormData().title(UI.title(UI.ICON.system,"Database Tools")).body(UI.body(`§7Collections: §f${collections.length}`)).button("§aSave All (Force)").button("§fCollection Stats").button("§eCreate Health Snapshot").button(UI.BACK);
            const r=await form.show(player); 
            if (r.canceled) return; if (r.selection===3) return this.open(player);
            
            if(r.selection===0){
                const confirm = await FormUtils.confirm(player, "Force Save All?", "Are you sure you want to force a synchronous save of all collections? This may cause a slight server lag spike.");
                if (confirm) {
                    const res=Database.saveAll(true); 
                    AuditService.record("database.save_all","database",player.id,player.name,"Admin forced save all",res); 
                    player.sendMessage(`§aSaved ${res.success.length} collections. Failed ${res.failed.length}.`); 
                }
                return this.databaseTools(player);
            }
            if(r.selection===1)return this.collectionStats(player);
            if(r.selection===2){
                AuditService.createHealthSnapshot("admin_database_tools"); 
                player.sendMessage("§aHealth snapshot created."); 
                return this.databaseTools(player);
            }
        } catch(e) {
            ErrorBoundary.report("AdminDashboard", e, { player, notify: false, level: "debug", message: "Database tools failed" });
        }
    }

    static async collectionStats(player){
        // Phase 7.5 (v0.22.0) (DB7): Re-check permission.
        if(!Permissions.canAccessAdminCenter(player))return;
        const collections=Database.listCollections(); 
        try {
            const form=new ActionFormData().title(UI.title(UI.ICON.system,"Collection Stats")); 
            const actions=[];
            
            for(const name of collections){
                const st=Database.stats(name);
                form.button(`§f${name}\n§f${st?fmtSize(st.size):"?"} §e| §fdirty ${st?.dirty?"Y":"N"}`);
                actions.push(name);
            } 
            form.button(UI.BACK);
            actions.push("back");
            
            const r=await form.show(player); 
            if (r.canceled) return; if (actions[r.selection]==="back") return this.databaseTools(player); 
            
            const st=Database.stats(actions[r.selection]); 
            await new ActionFormData()
                .title(`§b${actions[r.selection]}`)
                .body(UI.body(`§7Live Size: §f${fmtSize(st.size)}`,`§7Persisted Size: §f${fmtSize(st.persistedSize||0)}`,`§7Schema: §fv${st.schemaVersion}`,`§7Migration: §f${st.migration?`${st.migration.fromVersion}->${st.migration.toVersion} (${st.migration.success?"OK":"FAILED"})`:"none"}`,`§7Revision: §f${st.revision} §8/ persisted ${st.persistedRevision}`,`§7Items: §f${st.itemCount}`,`§7Dirty: ${st.dirty?"§eYes":"§aNo"}`,`§7Status: §f${st.status}`,`§7Last Save: §f${st.lastSave?new Date(st.lastSave).toLocaleString():"never"}`))
                .button(UI.BACK)
                .show(player); 
            
            return this.collectionStats(player);
        } catch(e) {
            ErrorBoundary.report("AdminDashboard", e, { player, notify: false, level: "debug", message: "Collection stats failed" });
        }
    }
}

export default AdminDashboard;