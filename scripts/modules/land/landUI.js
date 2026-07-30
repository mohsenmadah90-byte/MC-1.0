// MCity Dashboard V2 - Land UI
// Phase 9: Base/Child & Entry UI Updates
// New Changes Phase 6 (v1.8.7): Claim boundary preview before purchase.
// New Changes Phase 5 (v1.8.6): Tax grace/next-tax visibility.

import { world, Player } from "@minecraft/server";
import { ActionFormData, ModalFormData, MessageFormData } from "@minecraft/server-ui";
import { UI } from "../../core/uiTheme.js";
import { CONFIG } from "../../config.js";
import { MoneyUtils } from "../../core/moneyUtils.js";
import { PlayerRegistry } from "../../core/playerRegistry.js";
import { MoneyService } from "../economy/moneyService.js";
import { LandService } from "./landService.js";
import { FriendService } from "../friends/friendService.js";

const LC = CONFIG.LAND;
function backDashboard(player) { return import("../../dashboard/dashboardSystem.js").then(m => m.DashboardSystem.open(player)); }
function fmtDuration(ms) { const s=Math.max(0,Math.ceil((ms||0)/1000)); if(s<60)return `${s}s`; const m=Math.floor(s/60); if(m<60)return `${m}m`; const h=Math.floor(m/60); if(h<48)return `${h}h ${m%60}m`; const d=Math.floor(h/24); return `${d}d ${h%24}h`; }
function taxLine(c) { const info = LandService.taxInfo(c); if (!info || info.reason) return "§7Tax: §8unknown"; if (info.inGrace) return `§7Tax Grace: §a${fmtDuration(info.graceRemainingMs)} remaining`; return `§7Next Tax: §e${fmtDuration(info.nextTaxInMs)} §8(${MoneyUtils.formatCents(info.taxPerPeriodCents)} / ${info.periodHours}h)`; }
async function confirmTaxBeforeSale(player, claimId) {
    const claim = LandService.db().claims[claimId];
    const debt = Math.max(0, claim?.taxDebt || 0);
    if (!claim || debt <= 0) return { success: true, paid: 0 };
    const confirmation = await new MessageFormData()
        .title("§eTax Required Before Sale")
        .body(`This land has unpaid tax.\n\nTax due: §e${MoneyUtils.formatCents(debt)}§r\n\nYou must pay the full tax before listing or selling this land. After payment, you will receive a separate sale confirmation.`)
        .button1("§cCancel")
        .button2("§aPay Tax & Continue")
        .show(player);
    if (confirmation.canceled || confirmation.selection !== 1) return { success: false, canceled: true };
    const paid = LandService.payTax(player, claimId, { expectedDebt: debt });
    if (!paid.success) {
        player.sendMessage(CONFIG.PREFIX + paid.message);
        return paid;
    }
    player.sendMessage(CONFIG.PREFIX + `§aTax paid: §e${MoneyUtils.formatCents(paid.paid || debt)}§a. Continue to sale confirmation.`);
    return { success: true, paid: paid.paid || debt };
}

function claimInfo(c) {
    const sale = LandService.saleInfo(c);
    return `§7ID: §f${c.id}\n` +
           `§7Type: ${c.isBase ? "§bBase Chunk" : "§7Child Chunk"}\n` +
           `§7Owner: §f${c.ownerName}\n` +
           `§7Chunk: §f${c.chunkX}, ${c.chunkZ}\n` +
           `§7Y Range: §f${c.minY}-${c.maxY}\n` +
           `§7Tax Due: §e${MoneyUtils.formatCents(c.taxDebt || 0)}\n` +
           `${taxLine(c)}\n` +
           `§7Rent: ${c.rentEnabled ? "§a" + MoneyUtils.formatCents(c.rentPricePerDay) + "/day" : "§cDisabled"}\n` +
           `§7Entry: §f${c.flags?.entry || "public"}\n` +
           `§7For Sale: ${sale?.listed ? "§aYes §e" + MoneyUtils.formatCents(sale.priceCents) : "§cNo"}`; 
}

export class LandUI {
    static initialize() { LandService.initialize(); }
    static summary(player) { const s = LandService.stats(player); return s.owned || s.trusted || s.taxDebt ? `§7Land: §f${s.owned} owned §8| §d${s.trusted} trusted §8| §e${MoneyUtils.formatCents(s.taxDebt)} tax` : null; }
    static badge(player) { const s = LandService.stats(player); const parts = []; if (s.owned) parts.push(`${s.owned} owned`); if (s.taxDebt) parts.push(`${MoneyUtils.formatCents(s.taxDebt)} tax`); return parts.join(" | "); }

    static async open(player) {
        const current = LandService.currentClaim(player);
        const pc = LandService.playerChunk(player);
        const s = LandService.stats(player);
        
        try {
            const form = new ActionFormData()
                .title(UI.title(UI.ICON.land, "Land", "Claims, Taxes and Market"))
                .body(UI.body(
                    `§7Current Chunk: §f${pc.id}`,
                    current ? `§7Status: §aClaimed by §f${current.ownerName}` : "§7Status: §eUnclaimed",
                    `§7Owned: §f${s.owned} §8| §7Trusted: §d${s.trusted}`,
                    `§7Tax Due: §e${MoneyUtils.formatCents(s.taxDebt)}`,
                    `§7Tax Period: §f${CONFIG.LAND.TAX_PERIOD_HOURS || 24}h §8| §7Grace: §f${CONFIG.LAND.TAX_GRACE_DAYS}d`,
                    `§7Balance: §a${MoneyUtils.formatCents(MoneyService.getBalance(player))}`
                ))
                .button("§fCurrent Chunk")
                .button("§aBuy Current Chunk")
                .button("§fMy Lands")
                .button("§ePay Taxes")
                .button("§fLand Market")
                .button("§fLand Help")
                .button(UI.BACK);
                
            const r = await form.show(player);
            if (r.canceled) return; if (r.selection === 6) return backDashboard(player);
            if (r.selection === 0) return this.current(player);
            if (r.selection === 1) return this.buyCurrent(player);
            if (r.selection === 2) return this.myLands(player, 0);
            if (r.selection === 3) return this.taxList(player);
            if (r.selection === 4) return this.market(player, 0);
            if (r.selection === 5) return this.help(player);
        } catch (e) { try { player.sendMessage("§cUI Error: " + String(e)); console.warn(e, e.stack); } catch(ex){} }
    }

    static async current(player) {
        const c = LandService.currentClaim(player);
        const pc = LandService.playerChunk(player);
        
        try {
            if (!c) {
                const v = LandService.validateClaimable(player);
                const typeStr = v.isBase ? "§bBase Chunk" : "§7Child Chunk";
                
                const form = new ActionFormData()
                    .title(UI.title(UI.ICON.land, "Current Chunk"))
                    .body(UI.body(
                        `§7Chunk: §f${pc.id}`, 
                        "§eThis chunk is unclaimed.", 
                        v.ok ? `§7Type: ${typeStr}\n§bPrice: §e${MoneyUtils.formatCents(v.price)}` : `§c${v.reason}`
                    ))
                    .button("§aBuy Claim")
                    .button(UI.BACK);
                    
                const r = await form.show(player); 
                if (!r.canceled && r.selection === 0) return this.buyCurrent(player); 
                return this.open(player);
            }
            
            const form = new ActionFormData()
                .title(UI.title(UI.ICON.land, "Current Claim"))
                .body(UI.body(claimInfo(c)))
                .button("§fManage Claim")
                .button("§ePay Tax")
                .button("§fRent Land")
                .button("§fPay Entry Tax")
                .button("§fBuy Listing / Info")
                .button(UI.BACK);
                
            const r = await form.show(player); 
            if (r.canceled) return; if (r.selection === 5) return this.open(player);
            
            if (r.selection === 0) return this.manage(player, c.id);
            if (r.selection === 1) { const res = LandService.payTax(player, c.id); player.sendMessage(CONFIG.PREFIX + res.message); return this.current(player); }
            if (r.selection === 2) return this.rentClaim(player, c.id);
            if (r.selection === 3) { const res = LandService.payEntryTax(player, c.id); player.sendMessage(CONFIG.PREFIX + res.message); return this.current(player); }
            if (r.selection === 4) return c.listingId ? this.marketDetails(player, c.listingId) : this.current(player);
        } catch (e) { try { player.sendMessage("§cUI Error: " + String(e)); console.warn(e, e.stack); } catch(ex){} }
    }

    static async buyCurrent(player) {
        const validation = LandService.validateClaimable(player);
        if (!validation.ok) { player.sendMessage(CONFIG.PREFIX + `§c${validation.reason}`); return this.open(player); }
        try {
            const typeStr = validation.isBase ? "Base Chunk" : "Child Chunk";
            const c = await new MessageFormData()
                .title("§aChunk Preview & Buy")
                .body(`Chunk: §f${validation.pc.id}§r\nType: §b${typeStr}§r\nPrice: §e${MoneyUtils.formatCents(validation.price)}§r\nProtected Y: ${LC.MIN_CLAIM_Y}-${LC.MAX_CLAIM_Y}\n\nChoose Show Chunk to place four temporary white banners. The menu will close and banners expire after one minute.`)
                .button1("§fShow Chunk")
                .button2("§aBuy Claim")
                .show(player);
            if (c.canceled) return;
            if (c.selection === 0) {
                const shown = LandService.previewCurrentChunk(player);
                if (shown.success) player.sendMessage(CONFIG.PREFIX + `§aFour white banners placed around ${validation.pc.id}. They expire in ${Math.ceil((shown.durationMs || 60000) / 1000)} seconds.`);
                else player.sendMessage(CONFIG.PREFIX + shown.message);
                return;
            }
            if (c.selection === 1) {
                const shown = LandService.previewCurrentChunk(player);
                if (!shown.success) { player.sendMessage(CONFIG.PREFIX + shown.message); return this.open(player); }
                const confirm = await new MessageFormData()
                    .title("§aConfirm Claim Purchase")
                    .body(`Buy ${validation.pc.id} for §e${MoneyUtils.formatCents(validation.price)}§r?`)
                    .button1("§cCancel")
                    .button2("§aConfirm Buy")
                    .show(player);
                if (confirm.canceled || confirm.selection !== 1) { LandService.clearClaimPreview(player.id); return this.open(player); }
                LandService.clearClaimPreview(player.id);
                const res = LandService.buyCurrentChunk(player);
                player.sendMessage(CONFIG.PREFIX + res.message);
                return this.open(player);
            }
        } catch (e) { LandService.clearClaimPreview(player.id); try { player.sendMessage("§cUI Error: " + String(e)); console.warn(e, e.stack); } catch(ex){} }
    }

    static async myLands(player, page = 0) {
        const claims = [...LandService.ownedClaims(player), ...LandService.trustedClaims(player)];
        // Sort: Base chunk first
        claims.sort((a, b) => {
            if (a.isBase && !b.isBase) return -1;
            if (!a.isBase && b.isBase) return 1;
            return (b.createdAt || 0) - (a.createdAt || 0);
        });

        const per = CONFIG.UI.ITEMS_PER_PAGE || 8; 
        const total = Math.max(1, Math.ceil(claims.length / per)); 
        page = Math.max(0, Math.min(page, total - 1));
        const slice = claims.slice(page * per, page * per + per);
        
        try {
            const form = new ActionFormData()
                .title(UI.title(UI.ICON.land, "My Lands"))
                .body(UI.body(`§7Claims: §f${claims.length}`, `§7Page: §f${page + 1}/${total}`)); 
            const actions = [];
            
            for (const c of slice) { 
                const typeStr = c.isBase ? "§b(Base)" : "§7(Child)";
                const sale = LandService.saleInfo(c);
                const saleText = sale?.listed ? `§eFor Sale ${MoneyUtils.formatCents(sale.priceCents)}` : "";
                form.button(`${c.ownerId === player.id ? "§aOwned" : "§dTrusted"} §f${c.id}\n${typeStr} §e| §fTax ${MoneyUtils.formatCents(c.taxDebt || 0)} ${saleText}`); 
                actions.push({ type: "claim", id: c.id }); 
            }
            
            if (page < total - 1) { form.button(UI.NEXT); actions.push({ type: "next" }); }
            if (page > 0) { form.button(UI.PREV); actions.push({ type: "prev" }); }
            form.button(UI.BACK); actions.push({ type: "back" });
            
            const r = await form.show(player); 
            if (r.canceled) return; 
            
            const a = actions[r.selection]; 
            if (!a || a.type === "back") return this.open(player); 
            if (a.type === "next") return this.myLands(player, page + 1); 
            if (a.type === "prev") return this.myLands(player, page - 1); 
            return this.manage(player, a.id);
        } catch (e) { try { player.sendMessage("§cUI Error: " + String(e)); console.warn(e, e.stack); } catch(ex){} }
    }

    static async manage(player, claimId) {
        const c = LandService.db().claims[claimId]; if (!c) return this.open(player);
        const canManage = LandService.canManage(c, player);
        
        try {
            const form = new ActionFormData()
                .title(UI.title(UI.ICON.land, "Manage Claim"))
                .body(UI.body(claimInfo(c)))
                .button("§ePay Tax")
                .button("§fFlags & Protection")
                .button("§fTrusted Players")
                .button("§fRent Settings")
                .button("§cEvict Tenant")
                .button("§fList For Sale")
                .button("§cCancel Listing")
                .button("§cSell To Server")
                .button(UI.BACK);
                
            const r = await form.show(player); 
            if (r.canceled) return; if (r.selection === 8) return this.open(player);
            if (!canManage) { player.sendMessage(CONFIG.PREFIX + "§cYou cannot manage this claim."); return this.open(player); }
            
            if (r.selection === 0) { const res = LandService.payTax(player, claimId); player.sendMessage(CONFIG.PREFIX + res.message); return this.manage(player, claimId); }
            if (r.selection === 1) return this.flags(player, claimId);
            if (r.selection === 2) return this.trusted(player, claimId);
            if (r.selection === 3) return this.rentSettings(player, claimId);
            if (r.selection === 4) { const res = LandService.evictTenant(player, claimId); player.sendMessage(CONFIG.PREFIX + res.message); return this.manage(player, claimId); }
            if (r.selection === 5) return this.listSale(player, claimId);
            if (r.selection === 6) { const res = LandService.unlistForSale(player, claimId); player.sendMessage(CONFIG.PREFIX + res.message); return this.manage(player, claimId); }
            if (r.selection === 7) return this.sellServer(player, claimId);
        } catch (e) { try { player.sendMessage("§cUI Error: " + String(e)); console.warn(e, e.stack); } catch(ex){} }
    }

    static async flags(player, claimId) {
        const c = LandService.db().claims[claimId]; if (!c) return this.open(player);
        const modes = ["owner_trusted", "trusted", "public", "deny"]; 
        const entries = ["public", "trusted", "private", "taxed"];
        
        try {
            const form = new ModalFormData().title("§7Land Flags")
                .dropdown("Entry Mode (Shield Barrier)", entries, { defaultValueIndex: Math.max(0, entries.indexOf(c.flags.entry || "public")) })
                .dropdown("Break Blocks", modes, { defaultValueIndex: Math.max(0, modes.indexOf(c.flags.break || "owner_trusted")) })
                .dropdown("Place Blocks", modes, { defaultValueIndex: Math.max(0, modes.indexOf(c.flags.place || "owner_trusted")) })
                .dropdown("Interact (Doors/Buttons)", modes, { defaultValueIndex: Math.max(0, modes.indexOf(c.flags.interact || "public")) })
                .dropdown("Containers (Chests)", modes, { defaultValueIndex: Math.max(0, modes.indexOf(c.flags.containers || "owner_trusted")) })
                .textField("Entry Tax ($)", "10.00", { defaultValue: String((c.flags.entryTaxCents || LC.DEFAULT_ENTRY_TAX_CENTS) / 100) })
                .toggle("PVP Allowed", { defaultValue: !!c.flags.pvp })
                .toggle("Explosions (TNT/etc)", { defaultValue: !!c.flags.explosions })
                .toggle("Pistons Allowed", { defaultValue: !!c.flags.pistons })
                .toggle("Fire Allowed", { defaultValue: !!c.flags.fire })
                .toggle("Liquids Allowed", { defaultValue: !!c.flags.liquids })
                .toggle("Redstone Allowed", { defaultValue: !!c.flags.redstone });
                
            const r = await form.show(player); 
            if (r.canceled) return;
            
            const tax = MoneyUtils.parseFloatToCents(r.formValues[5], false);
            
            const res = LandService.updateFlags(player, claimId, { 
                entry: entries[r.formValues[0]], 
                break: modes[r.formValues[1]], 
                place: modes[r.formValues[2]], 
                interact: modes[r.formValues[3]], 
                containers: modes[r.formValues[4]], 
                entryTaxCents: tax.ok ? tax.cents : (c.flags.entryTaxCents || LC.DEFAULT_ENTRY_TAX_CENTS), 
                pvp: !!r.formValues[6], 
                explosions: !!r.formValues[7], 
                pistons: !!r.formValues[8], 
                fire: !!r.formValues[9], 
                liquids: !!r.formValues[10], 
                redstone: !!r.formValues[11] 
            });
            
            player.sendMessage(CONFIG.PREFIX + res.message); 
            return this.manage(player, claimId);
        } catch (e) { try { player.sendMessage("§cUI Error: " + String(e)); console.warn(e, e.stack); } catch(ex){} }
    }

    static async trusted(player, claimId) {
        const c = LandService.db().claims[claimId]; if (!c) return this.open(player);
        const players = FriendService.list(player).filter(p => p.playerId !== player.id).map(p => ({ id: p.playerId, name: p.playerName }));
        
        try {
            const form = new ActionFormData()
                .title(UI.title("§b", "Trusted Players"))
                .body(UI.body(`§7Trusted: §f${Object.keys(c.trusted || {}).length}`))
                .button("§aAdd Online Player"); 
                
            const actions = [{ type: "add" }];
            
            for (const [pid, t] of Object.entries(c.trusted || {})) { 
                form.button(`§cRemove §f${t.name}\n§fRole: ${t.role}`); 
                actions.push({ type: "view", pid, name: t.name }); 
            }
            
            form.button(UI.BACK); actions.push({ type: "back" });
            const r = await form.show(player); 
            
            if (r.canceled) return; 
            const a = actions[r.selection]; 
            if (!a || a.type === "back") return this.manage(player, claimId);
            
            if (a.type === "add") return this.addTrusted(player, claimId, players);
            if (a.type === "view") { 
                const res = LandService.setTrusted(player, claimId, a.name, a.pid, null); // null role = remove
                player.sendMessage(CONFIG.PREFIX + res.message); 
                return this.trusted(player, claimId); 
            }
        } catch (e) { try { player.sendMessage("§cUI Error: " + String(e)); console.warn(e, e.stack); } catch(ex){} }
    }

    static async addTrusted(player, claimId, players) {
        if (!players.length) { player.sendMessage(CONFIG.PREFIX + "§eNo online players to trust."); return this.trusted(player, claimId); }
        const roles = Object.keys(LC.ROLES);
        
        try {
            const form = new ModalFormData()
                .title("§aAdd Trusted Player")
                .dropdown("Player", players.map(p => p.name))
                .dropdown("Role", roles, { defaultValueIndex: 0 }); // 0 is visitor
                
            const r = await form.show(player); 
            if (r.canceled) return;
            
            const target = players[r.formValues[0]]; 
            const role = roles[r.formValues[1]];
            
            const res = LandService.setTrusted(player, claimId, target.name, target.id, role); 
            player.sendMessage(CONFIG.PREFIX + res.message); 
            return this.trusted(player, claimId);
        } catch (e) { try { player.sendMessage("§cUI Error: " + String(e)); console.warn(e, e.stack); } catch(ex){} }
    }

    static async rentSettings(player, claimId) {
        const c = LandService.db().claims[claimId]; if (!c) return this.open(player);

        try {
            // Phase 7.3 (v0.21.2) (LD1): Read from the unified field names.
            // Previously read `rentEnabled` and `rentPricePerDay` which were
            // dead fields — `rentLand` checks `listedForRent` and reads
            // `rentPricePerDayCents`. Now we read from the correct fields.
            const form = new ModalFormData().title("§6Rent Settings")
                .toggle("List for Rent", { defaultValue: !!c.listedForRent })
                .textField("Price per day ($)", "350.00", { defaultValue: String((c.rentPricePerDayCents ?? c.rentPricePerDay ?? LC.RENT_PRICE_PER_DAY_CENTS) / 100) });

            const r = await form.show(player);
            if (r.canceled) return;

            const enabled = !!r.formValues[0];
            const price = MoneyUtils.parseFloatToCents(r.formValues[1], false);
            const priceCents = price.ok ? price.cents : LC.RENT_PRICE_PER_DAY_CENTS;

            // Phase 7.3 (v0.21.2) (LD1): Use the new LandService.setRentTerms
            // method — a synchronous transaction with a verified return value.
            // Previously this was a fire-and-forget dynamic-import Promise
            // that was never awaited, so the success message was sent before
            // the transaction even started (a lie).
            const res = LandService.setRentTerms(player, claimId, enabled, priceCents);
            player.sendMessage(CONFIG.PREFIX + res.message);
            return this.manage(player, claimId);
        } catch (e) { try { player.sendMessage("§cUI Error: " + String(e)); console.warn(e, e.stack); } catch(ex){} }
    }

    static async rentClaim(player, claimId) {
        const c = LandService.db().claims[claimId]; if (!c) return this.open(player);
        if (c.ownerId === player.id) { player.sendMessage(CONFIG.PREFIX + "§eYou own this claim."); return this.current(player); }
        
        try {
            const form = new ModalFormData().title("§bRent Land")
                .slider("Days", 1, 30, { valueStep: 1, defaultValue: 1 }); // step=1, default=1
                
            const r = await form.show(player); 
            if (r.canceled) return;
            
            const res = LandService.rentLand(player, claimId, Math.floor(r.formValues[0] || 1));
            player.sendMessage(CONFIG.PREFIX + res.message); 
            return this.current(player);
        } catch (e) { try { player.sendMessage("§cUI Error: " + String(e)); console.warn(e, e.stack); } catch(ex){} }
    }

    static async listSale(player, claimId) {
        try {
            const tax = await confirmTaxBeforeSale(player, claimId);
            if (!tax.success) return this.manage(player, claimId);
            const form = new ModalFormData().title("§dList Land For Sale").textField("Price ($)", "10000.00"); 
            const r = await form.show(player); 
            if (r.canceled) return;
            
            const parsed = MoneyUtils.parseFloatToCents(r.formValues[0], false); 
            if (!parsed.ok) { player.sendMessage(CONFIG.PREFIX + "§cInvalid price."); return this.manage(player, claimId); }
            const confirmation = await new MessageFormData()
                .title("§dConfirm Land Listing")
                .body(`List claim §f${claimId}§r for §e${MoneyUtils.formatCents(parsed.cents)}§r?\n\nAny required tax was paid before this confirmation.`)
                .button1("§cCancel")
                .button2("§aConfirm Listing")
                .show(player);
            if (confirmation.canceled || confirmation.selection !== 1) return this.manage(player, claimId);
            const res = LandService.listForSale(player, claimId, parsed.cents); 
            player.sendMessage(CONFIG.PREFIX + res.message); 
            return this.manage(player, claimId);
        } catch (e) { try { player.sendMessage("§cUI Error: " + String(e)); console.warn(e, e.stack); } catch(ex){} }
    }

    static async sellServer(player, claimId) {
        const refund = Math.floor(LC.BASE_PRICE_CENTS * LC.SELL_REFUND_RATIO);
        try {
            const tax = await confirmTaxBeforeSale(player, claimId);
            if (!tax.success) return this.manage(player, claimId);
            const c = await new MessageFormData().title("§cSell To Server").body(`Sell claim §f${claimId}§r to server for §e${MoneyUtils.formatCents(refund)}§r pending payout?`).button1("§cCancel").button2("§aSell").show(player);
            if (c.canceled) return; if (c.selection !== 1) return this.manage(player, claimId);
            const res = LandService.sellToServer(player, claimId); player.sendMessage(CONFIG.PREFIX + res.message); return this.open(player);
        } catch (e) { try { player.sendMessage("§cUI Error: " + String(e)); console.warn(e, e.stack); } catch(ex){} }
    }

    static async taxList(player) {
        const claims = LandService.ownedClaims(player).filter(c => (c.taxDebt || 0) > 0);
        if (!claims.length) { player.sendMessage(CONFIG.PREFIX + "§aNo land taxes due."); return this.open(player); }
        
        try {
            const form = new ActionFormData().title(UI.title("§e", "Tax Due Claims")); 
            for (const c of claims) form.button(`§f${c.id}\n§e${MoneyUtils.formatCents(c.taxDebt)}`); 
            form.button(UI.BACK);
            
            const r = await form.show(player); 
            if (r.canceled) return; if (r.selection >= claims.length) return this.open(player); 
            
            const res = LandService.payTax(player, claims[r.selection].id); 
            player.sendMessage(CONFIG.PREFIX + res.message); 
            return this.taxList(player);
        } catch (e) { try { player.sendMessage("§cUI Error: " + String(e)); console.warn(e, e.stack); } catch(ex){} }
    }

    static async market(player, page = 0) {
        const list = LandService.listings(); const per = CONFIG.UI.ITEMS_PER_PAGE || 8; const total = Math.max(1, Math.ceil(list.length / per)); page = Math.max(0, Math.min(page, total - 1)); const slice = list.slice(page * per, page * per + per);
        
        try {
            const form = new ActionFormData().title(UI.title("§d", "Land Market")).body(UI.body(`§7Listings: §f${list.length}`, `§7Page: §f${page + 1}/${total}`)); const actions = [];
            for (const l of slice) { form.button(`§f${l.claimId}\n§fSeller ${l.sellerName} §e| §e${MoneyUtils.formatCents(l.price)}`); actions.push({ type: "listing", id: l.id }); }
            if (page < total - 1) { form.button(UI.NEXT); actions.push({ type: "next" }); } if (page > 0) { form.button(UI.PREV); actions.push({ type: "prev" }); } form.button(UI.BACK); actions.push({ type: "back" });
            
            const r = await form.show(player); 
            if (r.canceled) return; 
            const a = actions[r.selection]; 
            if (!a || a.type === "back") return this.open(player); 
            if (a.type === "next") return this.market(player, page + 1); 
            if (a.type === "prev") return this.market(player, page - 1); 
            return this.marketDetails(player, a.id);
        } catch (e) { try { player.sendMessage("§cUI Error: " + String(e)); console.warn(e, e.stack); } catch(ex){} }
    }

    static async marketDetails(player, listingId) {
        const l = LandService.db().market.listings[listingId]; if (!l) return this.market(player);
        try {
            const c = await new MessageFormData().title("§dBuy Land Listing").body(`Claim: §f${l.claimId}\nSeller: §f${l.sellerName}\nPrice: §e${MoneyUtils.formatCents(l.price)}\n\nBuy this land?`).button1("§cCancel").button2("§aBuy").show(player);
            if (c.canceled) return; if (c.selection !== 1) return this.market(player);
            // The method is buyPlayerLand based on phase 6
            const res = LandService.buyPlayerLand(player, l.claimId); 
            player.sendMessage(CONFIG.PREFIX + res.message); 
            return this.open(player);
        } catch (e) { try { player.sendMessage("§cUI Error: " + String(e)); console.warn(e, e.stack); } catch(ex){} }
    }

    static async help(player) {
        try {
            await new ActionFormData().title(UI.title("?", "Land Help")).body(UI.body(
                "§6Land System Rules", 
                "§7Claims protect one chunk within configured Y range.", 
                `§7Protected Y: §f${LC.MIN_CLAIM_Y}-${LC.MAX_CLAIM_Y}`, 
                `§7Base price: §e${MoneyUtils.formatCents(LC.BASE_PRICE_CENTS)}`, 
                "", 
                "§6Base & Child Architecture:",
                "§7Your first claim is your §bBase Chunk§7.",
                "§7Any further claims MUST be attached to it (a 3x3 grid).",
                "",
                "§6Entry Shields:",
                "§7Set Entry to §eTaxed§7 to deploy a Toll Gate Energy Shield.",
                "§7Set it to §ePrivate§7 to physically repel all intruders."
            )).button(UI.BACK).show(player);
            return this.open(player);
        } catch (e) { try { player.sendMessage("§cUI Error: " + String(e)); console.warn(e, e.stack); } catch(ex){} }
    }
}

export default LandUI;