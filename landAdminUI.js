// MCity Dashboard V2 - Land Admin UI
// Phase 12: integrity tools and zone foundation.
// New Changes Phase 5 (v1.8.6): Tax diagnostics and simulated tax accrual.

import { ActionFormData, ModalFormData, MessageFormData } from "@minecraft/server-ui";
import { UI } from "../../uiTheme.js";
import { CONFIG } from "../../config.js";
import { MoneyUtils } from "../../core/moneyUtils.js";
import { Permissions } from "../../core/permissions.js";
import { Database } from "../../core/database.js";
import { rebuildLandIndexes } from "../../schemas/landSchema.js";
import { LandService } from "./landService.js";

function __mcityCan(player) { return Permissions.canManageLand(player); }
function __mcityLost(player) { if (__mcityCan(player)) return false; try { player.sendMessage("§cPermission changed. Action cancelled."); } catch {} return true; }

export class LandAdminUI {
    static async open(player) {
        if (!Permissions.canManageLand(player)) return;
        const stats = LandService.stats();
        const form = new ActionFormData()
            .title(UI.title(UI.ICON.land, "Land Admin"))
            .body(UI.body(
                `§7Claims: §f${stats.claims}`,
                `§7Listings: §f${stats.listings}`,
                `§7Zones: §b${stats.zones || 0}`,
                `§7Tax Debt: §e${MoneyUtils.formatCents(stats.taxDebt)}`,
                `§7Treasury: §6${MoneyUtils.formatCents(stats.treasury)}`
            ))
            .button("§eAccrue Taxes Now")
            .button("§fTax Diagnostics")
            .button("§eSimulate Tax Periods")
            .button("§fRebuild Indexes")
            .button("§fIntegrity Check")
            .button("§aRepair Integrity")
            .button("§fZone Admin")
            .button("§cForce Unclaim Current Chunk")
            .button(UI.BACK);
        const r = await form.show(player);
        if (__mcityLost(player)) return;
        if (r.canceled) return; if (r.selection === 8) return this.#back(player);
        if (r.selection === 0) { const res = LandService.accrueTaxes(true); player.sendMessage(CONFIG.PREFIX + `§aTax accrual started. ${res.message || ""}`); return this.open(player); }
        if (r.selection === 1) return this.taxDiagnostics(player);
        if (r.selection === 2) return this.simulateTax(player);
        if (r.selection === 3) { Database.transaction(CONFIG.LAND.COLLECTION, data => rebuildLandIndexes(data)); Database.save(CONFIG.LAND.COLLECTION, true); player.sendMessage(CONFIG.PREFIX + "§aLand indexes rebuilt."); return this.open(player); }
        if (r.selection === 4) return this.integrity(player, false);
        if (r.selection === 5) return this.integrity(player, true);
        if (r.selection === 6) return this.zoneAdmin(player);
        if (r.selection === 7) return this.forceUnclaim(player);
    }

    static async taxDiagnostics(player) {
        const db = LandService.db();
        const claims = Object.values(db.claims || {});
        const now = Date.now();
        let inGrace = 0, taxable = 0, debtClaims = 0;
        let nextSoon = Infinity;
        for (const c of claims) {
            const info = LandService.taxInfo(c);
            if (info.inGrace) inGrace++;
            if (info.taxable) taxable++;
            if ((c.taxDebt || 0) > 0) debtClaims++;
            if (!info.inGrace && info.nextTaxInMs < nextSoon) nextSoon = info.nextTaxInMs;
        }
        await new ActionFormData()
            .title(UI.title(UI.ICON.land, "Land Tax Diagnostics"))
            .body(UI.body(
                `§7Tax period: §f${CONFIG.LAND.TAX_PERIOD_HOURS || 24} hour(s)`,
                `§7Tax per day: §e${MoneyUtils.formatCents(CONFIG.LAND.TAX_PER_CHUNK_PER_DAY_CENTS)}`,
                `§7Tax per period: §e${MoneyUtils.formatCents(Math.floor((CONFIG.LAND.TAX_PER_CHUNK_PER_DAY_CENTS || 0) * ((CONFIG.LAND.TAX_PERIOD_HOURS || 24) / 24)))}`,
                `§7Grace: §f${CONFIG.LAND.TAX_GRACE_DAYS} day(s)`,
                `§7Claims: §f${claims.length}`,
                `§7In grace: §a${inGrace}`,
                `§7Ready to accrue: §e${taxable}`,
                `§7With debt: §c${debtClaims}`,
                nextSoon < Infinity ? `§7Next tax in: §e${Math.ceil(nextSoon / 60000)} min` : "§7Next tax: §8none"
            ))
            .button(UI.BACK)
            .show(player);
        return this.open(player);
    }

    static async simulateTax(player) {
        const r = await new ModalFormData()
            .title("§eSimulate Land Tax")
            .slider("Tax periods to simulate", 1, 30, { valueStep: 1, defaultValue: 1 })
            .toggle("Ignore grace period", { defaultValue: true })
            .show(player);
        if (__mcityLost(player)) return;
        if (r.canceled) return;
        const periods = Math.max(1, Math.floor(Number(r.formValues[0]) || 1));
        const ignoreGrace = !!r.formValues[1];
        const res = LandService.accrueTaxes(true, { forcePeriods: periods, ignoreGrace });
        player.sendMessage(CONFIG.PREFIX + `§aTax simulation started: §f${periods} period(s), ignore grace ${ignoreGrace ? "ON" : "OFF"}. ${res.message || ""}`);
        return this.open(player);
    }

    static async integrity(player, repair = false) {
        const res = LandService.integrityCheck(repair);
        await new ActionFormData()
            .title(UI.title("§6", repair ? "Land Integrity Repair" : "Land Integrity Check"))
            .body(UI.body(
                `§7Orphan Listings: §f${res.orphanListings || 0}`,
                `§7Invalid Trusted Entries: §f${res.invalidTrusted || 0}`,
                `§7Expired Entry Passes: §f${res.expiredEntryPasses || 0}`,
                `§7Empty Pass Players: §f${res.emptyPassPlayers || 0}`,
                `§7Zones: §b${res.zones || 0}`,
                `§7Indexes Rebuilt: ${res.indexesRebuilt ? "§aYes" : "§8No"}`,
                res.error ? `§cError: ${res.error}` : repair ? "§aRepair completed." : "§7No changes were made."
            ))
            .button(UI.BACK)
            .show(player);
        return this.open(player);
    }

    static async zoneAdmin(player) {
        const pc = LandService.playerChunk(player);
        const zones = LandService.zonesForChunk(pc.dimensionId, pc.cx, pc.cz);
        const all = Object.values(LandService.db().zones || {}).sort((a,b)=>(b.priority||0)-(a.priority||0));
        const form = new ActionFormData()
            .title(UI.title("§b", "Land Zone Admin"))
            .body(UI.body(
                `§7Current Chunk: §f${pc.id}`,
                `§7Zones Here: §f${zones.length}`,
                `§7Total Zones: §f${all.length}`
            ))
            .button("§aCreate Zone Around Me")
            .button("§eInspect Current Zone")
            .button("§cDelete Current Zone")
            .button("§fList All Zones")
            .button(UI.BACK);
        const r = await form.show(player);
        if (__mcityLost(player)) return;
        if (r.canceled) return; if (r.selection === 4) return this.open(player);
        if (r.selection === 0) return this.createZone(player);
        if (r.selection === 1) return this.inspectZone(player, zones[0] || null);
        if (r.selection === 2) return this.deleteZone(player, zones[0] || null);
        if (r.selection === 3) return this.listZones(player, 0);
    }

    static async createZone(player) {
        const types = ["generic", "no_claim", "market", "road", "public_build", "event"];
        const r = await new ModalFormData()
            .title("§aCreate Land Zone")
            .textField("Zone Name", "City Center", { defaultValue: "City Center" })
            .dropdown("Zone Type", types)
            .slider("Radius in chunks", 0, 16, { valueStep: 1, defaultValue: 2 })
            .toggle("Claim Allowed", { defaultValue: true })
            .toggle("Buy Allowed", { defaultValue: true })
            .toggle("Rent Allowed", { defaultValue: true })
            .textField("Price Multiplier", "1.0", { defaultValue: "1.0" })
            .textField("Rent Multiplier", "1.0", { defaultValue: "1.0" })
            .slider("Priority", 0, 100, { valueStep: 1, defaultValue: 10 })
            .textField("Note", "optional")
            .show(player);
        if (r.canceled) return;
        const type = types[r.formValues[1]];
        const res = LandService.createZone(player, {
            name: r.formValues[0] || "Land Zone",
            type,
            radius: r.formValues[2],
            claimAllowed: !!r.formValues[3],
            allowBuy: !!r.formValues[4],
            allowRent: !!r.formValues[5],
            priceMultiplier: Number(r.formValues[6]) || 1,
            rentMultiplier: Number(r.formValues[7]) || 1,
            priority: r.formValues[8],
            note: r.formValues[9] || ""
        });
        player.sendMessage(CONFIG.PREFIX + res.message);
        return this.zoneAdmin(player);
    }

    static async inspectZone(player, zone) {
        if (!zone) { player.sendMessage(CONFIG.PREFIX + "§eNo zone at current chunk."); return this.zoneAdmin(player); }
        await new ActionFormData()
            .title(UI.title("§b", "Zone Info"))
            .body(UI.body(
                `§7ID: §f${zone.id}`,
                `§7Name: §f${zone.name}`,
                `§7Type: §f${zone.type}`,
                `§7Dimension: §f${zone.dimension}`,
                `§7Chunks X: §f${zone.minChunkX} to ${zone.maxChunkX}`,
                `§7Chunks Z: §f${zone.minChunkZ} to ${zone.maxChunkZ}`,
                `§7Claim: ${zone.claimAllowed ? "§aAllowed" : "§cDenied"}`,
                `§7Buy: ${zone.allowBuy ? "§aAllowed" : "§cDenied"}`,
                `§7Rent: ${zone.allowRent ? "§aAllowed" : "§cDenied"}`,
                `§7Price Multiplier: §e${zone.priceMultiplier}`,
                `§7Rent Multiplier: §e${zone.rentMultiplier}`,
                `§7Priority: §f${zone.priority}`,
                zone.note ? `§7Note: §f${zone.note}` : ""
            ))
            .button(UI.BACK)
            .show(player);
        return this.zoneAdmin(player);
    }

    static async deleteZone(player, zone) {
        if (!zone) { player.sendMessage(CONFIG.PREFIX + "§eNo zone at current chunk."); return this.zoneAdmin(player); }
        const conf = await new MessageFormData()
            .title("§cDelete Zone")
            .body(`Delete zone §f${zone.name}§r? Existing claims will not be deleted.`)
            .button1("§cCancel")
            .button2("§aDelete")
            .show(player);
        if (conf.canceled) return; if (conf.selection !== 1) return this.zoneAdmin(player);
        const res = LandService.deleteZone(player, zone.id);
        player.sendMessage(CONFIG.PREFIX + res.message);
        return this.zoneAdmin(player);
    }

    static async listZones(player, page = 0) {
        const zones = Object.values(LandService.db().zones || {}).sort((a,b)=>(b.priority||0)-(a.priority||0));
        const per = 8, total = Math.max(1, Math.ceil(zones.length / per));
        page = Math.max(0, Math.min(page, total - 1));
        const slice = zones.slice(page * per, page * per + per);
        const form = new ActionFormData().title(UI.title("§6", "All Land Zones")).body(UI.body(`§7Zones: §f${zones.length}`, `§7Page: §f${page+1}/${total}`));
        const actions = [];
        for (const z of slice) { form.button(`§f${z.name}\n§f${z.type} §e| §fpriority ${z.priority}`); actions.push({ type: "view", z }); }
        if (page < total - 1) { form.button(UI.NEXT); actions.push({ type: "next" }); }
        if (page > 0) { form.button(UI.PREV); actions.push({ type: "prev" }); }
        form.button(UI.BACK); actions.push({ type: "back" });
        const r = await form.show(player); const a = actions[r.selection];
        if (__mcityLost(player)) return;
        if (r.canceled) return; if (!a || a.type === "back") return this.zoneAdmin(player);
        if (a.type === "next") return this.listZones(player, page + 1);
        if (a.type === "prev") return this.listZones(player, page - 1);
        if (a.type === "view") return this.inspectZone(player, a.z);
    }

    static async forceUnclaim(player) {
        const c = LandService.currentClaim(player);
        if (!c) { player.sendMessage(CONFIG.PREFIX + "§eNo claim here."); return this.open(player); }
        const conf = await new MessageFormData().title("§cForce Unclaim").body(`Delete claim §f${c.id}§r? This cannot be undone without backup.`).button1("§cCancel").button2("§aDelete").show(player);
        if (__mcityLost(player)) return;
        if (conf.canceled) return; if (conf.selection !== 1) return this.open(player);
        Database.transaction(CONFIG.LAND.COLLECTION, data => { if (data.claims[c.id]?.listingId) delete data.market.listings[data.claims[c.id].listingId]; delete data.claims[c.id]; rebuildLandIndexes(data); });
        Database.save(CONFIG.LAND.COLLECTION, true);
        player.sendMessage(CONFIG.PREFIX + `§cForce unclaimed: §f${c.id}`);
        return this.open(player);
    }

    static #back(player) { return import("../../dashboard/dashboardSystem.js").then(m => m.DashboardSystem.open(player)); }
}

export default LandAdminUI;
