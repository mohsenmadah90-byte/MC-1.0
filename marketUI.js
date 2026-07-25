import { ActionFormData, ModalFormData, MessageFormData } from "@minecraft/server-ui";
import { UI } from "../../uiTheme.js";
import { CONFIG } from "../../config.js";
import { MoneyUtils } from "../../core/moneyUtils.js";
import { MoneyService } from "../economy/moneyService.js";
import { MarketService } from "./marketService.js";
import { MarketPricing } from "./marketPricing.js";
import { normalizeItemId } from "../../schemas/marketSchema.js";
import { ItemCatalog } from "../../core/itemCatalog.js";
import { ItemSettingsService } from "../../core/itemSettingsService.js";

const MC = CONFIG.MARKET;
function itemName(item) { return item.displayName || ItemCatalog.get(item?.id)?.name || item.id?.split(":")?.[1] || item.id; }
function itemIcon(itemOrId) { const id = typeof itemOrId === "string" ? itemOrId : itemOrId?.id; return ItemCatalog.get(id)?.icon || ""; }
function buttonWithIcon(form, label, icon) { try { icon ? form.button(label, icon) : form.button(label); } catch { form.button(label); } }
function backDashboard(player) { return import("../../dashboard/dashboardSystem.js").then(m => m.DashboardSystem.open(player)); }

export class MarketUI {
    static initialize() { MarketService.initialize(); }
    static summary(player) {
        const ms = MarketService.mailboxStats(player);
        const open = MarketService.myOrders(player).filter(o => o.status === "open").length;
        if (ms.count || open) return `§7Market: §f${open} orders §8| §a${ms.count} mail`;
        return null;
    }
    static badge(player) {
        const ms = MarketService.mailboxStats(player);
        return ms.count ? `${ms.count} mail` : null;
    }

    static async open(player) {
        const db = MarketService.db();
        const mail = MarketService.mailboxStats(player);
        const openOrders = MarketService.myOrders(player).filter(o => o.status === "open").length;
        
        try {
            const form = new ActionFormData()
                .title(UI.title(UI.ICON.market, "Market"))
                .body(UI.body(
                    `§7Global Volume: §f${MoneyUtils.formatCents(db.stats.totalMoneyVolume || 0)}`,
                    `§7Active Orders: §f${openOrders}`,
                    mail.count ? `§7Mailbox: §a${mail.count} unread` : ""
                ))
                .button("§fBrowse Categories")
                .button("§fTrending Items")
                .button("§fMy Orders");
                
            if (mail.count) form.button("§aMarket Mailbox");
            form.button(UI.BACK);
            
            const r = await form.show(player);
            if (r.canceled) return;
            
            let btn = 0;
            if (r.selection === btn++) return this.categories(player);
            if (r.selection === btn++) return this.trending(player);
            if (r.selection === btn++) return this.myOrders(player);
            if (mail.count && r.selection === btn++) return this.mailbox(player);
            return backDashboard(player);
        } catch (e) { try { player.sendMessage("§cUI Error: " + String(e)); console.warn(e, e.stack); } catch(ex){} }
    }

    static async categories(player) {
        const cats = MarketService.categories().map(c => ({ ...c, items: (c.items || []).filter(i => ItemSettingsService.isMarketable(i.id)) })).filter(c => c.items.length > 0);
        try {
            const form = new ActionFormData().title(UI.title(UI.ICON.market, "Categories")).body(UI.body(`§7Categories: §f${cats.length}`));
            for (const c of cats) form.button(`§f${c.displayName}\n§f${c.items.length} items`);
            form.button(UI.BACK);
            const r = await form.show(player); 
            if (r.canceled) return; if (r.selection >= cats.length) return this.open(player);
            return this.itemList(player, cats[r.selection], 0);
        } catch (e) { try { player.sendMessage("§cUI Error: " + String(e)); console.warn(e, e.stack); } catch(ex){} }
    }

    static async itemList(player, category, page = 0) {
        const items = (category.items || []).filter(i => ItemSettingsService.isMarketable(i.id));
        const per = CONFIG.UI.ITEMS_PER_PAGE || 8;
        const total = Math.max(1, Math.ceil(items.length / per));
        page = Math.max(0, Math.min(page, total - 1));
        const slice = items.slice(page * per, page * per + per);
        
        try {
            const form = new ActionFormData().title(UI.title(UI.ICON.market, category.displayName)).body(UI.body(`§7Items: §f${items.length}`, `§7Page: §f${page + 1}/${total}`));
            const actions = [];
            for (const item of slice) { buttonWithIcon(form, `§f${itemName(item)}\n§bBuy ${MoneyUtils.formatCents(item.buyPrice)} §e| §fSell ${MoneyUtils.formatCents(item.sellPrice)}`, itemIcon(item)); actions.push({ type: "item", id: item.id }); }
            if (page < total - 1) { form.button(UI.NEXT); actions.push({ type: "next" }); }
            if (page > 0) { form.button(UI.PREV); actions.push({ type: "prev" }); }
            form.button(UI.BACK); actions.push({ type: "back" });
            
            const r = await form.show(player); 
            if (r.canceled) return;
            const a = actions[r.selection]; 
            if (!a || a.type === "back") return this.categories(player);
            if (a.type === "next") return this.itemList(player, category, page + 1);
            if (a.type === "prev") return this.itemList(player, category, page - 1);
            return this.itemDetails(player, a.id, category.name, page);
        } catch (e) { try { player.sendMessage("§cUI Error: " + String(e)); console.warn(e, e.stack); } catch(ex){} }
    }

    static async itemDetails(player, itemId, categoryName = null, page = 0) {
        const found = MarketService.findItem(itemId);
        if (!found) return this.open(player);
        const item = found.item;
        
        try {
            const form = new ActionFormData()
                .title(UI.title(UI.ICON.market, itemName(item)))
                .body(UI.body(
                    UI.kv("Stock", item.stock), 
                    UI.kv("Buy Price", MoneyUtils.formatCents(item.buyPrice), "§a"), 
                    UI.kv("Sell Price", MoneyUtils.formatCents(item.sellPrice), "§a"), 
                    UI.kv("24h Trend", MarketPricing.trendText(item))
                ));
                
            const actions = [];
            if (item.allowBuy) { form.button("§aInstant Buy"); actions.push(() => this.tradeForm(player, itemId, "buy", categoryName, page)); }
            if (item.allowSell) { form.button("§fInstant Sell"); actions.push(() => this.tradeForm(player, itemId, "sell", categoryName, page)); }
            
            form.button("§fView Order Book"); actions.push(() => this.orderBook(player, itemId, categoryName, page));
            form.button("§fCreate Order (Buy/Sell)"); actions.push(() => this.createOrderForm(player, itemId, categoryName, page));
            form.button(UI.BACK); actions.push(() => categoryName ? this.itemList(player, found.category, page) : this.open(player));
            
            const r = await form.show(player); 
            if (r.canceled) return;
            return actions[r.selection]();
        } catch (e) { try { player.sendMessage("§cUI Error: " + String(e)); console.warn(e, e.stack); } catch(ex){} }
    }

    static async tradeForm(player, itemId, mode, categoryName, page) {
        const found = MarketService.findItem(itemId);
        if (!found) return this.open(player);
        const item = found.item;
        
        const dbData = MarketService.db();
        const buyLimitInfo = MarketService.canBuy(dbData, player, item, 1);
        const sellLimitInfo = MarketService.canSell(dbData, player, item, 1);
        
        const maxLimit = mode === "buy" ? buyLimitInfo.remaining : sellLimitInfo.remaining;
        const maxTrans = Math.min(MC.LIMITS.MAX_TRANSACTION_AMOUNT, maxLimit);
        const max = mode === "buy" ? Math.min(item.stock, maxTrans) : maxTrans;
        
        if (max <= 0) {
            player.sendMessage(CONFIG.PREFIX + `§cCannot ${mode}. Limit reached or out of stock.`);
            return this.itemDetails(player, itemId, categoryName, page);
        }

        try {
            const form = new ModalFormData()
                .title(mode === "buy" ? "§aBuy Item" : "§3Sell Item")
                .slider(`Quantity (Max: ${max})`, 1, Math.max(1, isNaN(max) ? 1 : max), { valueStep: 1, defaultValue: 1 });
                
            const r = await form.show(player); 
            if (r.canceled) return;
            
            const amount = Math.max(1, Math.floor(r.formValues[0] || 1));
            const b = mode === "buy" ? MarketService.buyBreakdown(item, amount) : MarketService.sellBreakdown(item, amount);
            const body = mode === "buy"
                ? `Buy §f${amount}x ${itemName(item)}§r for §a${MoneyUtils.formatCents(b.total)}§r?`
                : `Sell §f${amount}x ${itemName(item)}§r for net §a${MoneyUtils.formatCents(b.net)}§r?`;
                
            const conf = await new MessageFormData().title("§3Confirm Trade").body(body).button1("§7Cancel").button2("§aConfirm").show(player);
            if (conf.canceled) return; if (conf.selection !== 1) return this.itemDetails(player, itemId, categoryName, page);
            
            const res = mode === "buy" ? MarketService.instantBuy(player, itemId, amount) : MarketService.instantSell(player, itemId, amount);
            player.sendMessage(CONFIG.PREFIX + res.message);
            return this.itemDetails(player, itemId, categoryName, page);
        } catch (e) { try { player.sendMessage("§cUI Error: " + String(e)); console.warn(e, e.stack); } catch(ex){} }
    }

    static async createOrderForm(player, itemId, categoryName, page) {
        const item = MarketService.findItem(itemId)?.item; if (!item) return this.open(player);
        try {
            const form = new ModalFormData()
                .title("§3Create Order")
                .dropdown("Order Type", ["Buy", "Sell"], { defaultValueIndex: 0 })
                .slider("Amount", 1, Math.max(1, MC.ORDERS.MAX_ORDER_AMOUNT), { valueStep: 1, defaultValue: 1 })
                .textField("Price per item ($)", "10.00", { defaultValue: String(item.buyPrice/100) });
                
            const r = await form.show(player); 
            if (r.canceled) return;
            
            const type = r.formValues[0] === 0 ? "buy" : "sell";
            const amount = Math.floor(r.formValues[1] || 1);
            const priceParsed = MoneyUtils.parseFloatToCents(r.formValues[2], false);
            
            if (!priceParsed.ok) { player.sendMessage(CONFIG.PREFIX + "§cInvalid price."); return this.itemDetails(player, itemId, categoryName, page); }
            
            const res = type === "buy" ? MarketService.createBuyOrder(player, itemId, amount, priceParsed.cents) : MarketService.createSellOrder(player, itemId, amount, priceParsed.cents);
            player.sendMessage(CONFIG.PREFIX + res.message);
            return this.itemDetails(player, itemId, categoryName, page);
        } catch (e) { try { player.sendMessage("§cUI Error: " + String(e)); console.warn(e, e.stack); } catch(ex){} }
    }

    static async orderBook(player, itemId, categoryName, page) {
        const db = MarketService.db(); 
        const normalized = normalizeItemId(itemId);
        const found = MarketService.findItem(normalized);
        const display = found?.item ? itemName(found.item) : (ItemCatalog.get(normalized)?.name || normalized);
        const icon = itemIcon(normalized);
        const book = MarketService.orderBookFor(normalized) || { bids: [], asks: [] };
        const lines = [`§7Item: §f${display}`, `§8${normalized}`, "", `§aTop Bids (Buyers): §f${book.bids.length}`, `§eTop Asks (Sellers): §f${book.asks.length}`];
        try {
            const form = new ActionFormData().title(UI.title("", "Order Book")).body(UI.body(...lines));
            const actions = [];
            const bids = book.bids.slice(0, 5);
            const asks = book.asks.slice(0, 5);
            if (bids.length) {
                for (const b of bids) { buttonWithIcon(form, `§aBID §f${b.remaining}x ${display}\n§b${MoneyUtils.formatCents(b.pricePerItem)} §e| §f${b.ownerName}`, icon); actions.push({ type: "noop" }); }
            }
            if (asks.length) {
                for (const a of asks) { buttonWithIcon(form, `§eASK §f${a.remaining}x ${display}\n§b${MoneyUtils.formatCents(a.pricePerItem)} §e| §f${a.ownerName}`, icon); actions.push({ type: "noop" }); }
            }
            form.button(UI.BACK); actions.push({ type: "back" });
            const r = await form.show(player);
            if (r.canceled) return;
            const action = actions[r.selection];
            if (!action || action.type === "back") return this.itemDetails(player, itemId, categoryName, page);
            return this.orderBook(player, itemId, categoryName, page);
        } catch (e) { try { player.sendMessage("§cUI Error: " + String(e)); console.warn(e, e.stack); } catch(ex){} }
    }

    static async trending(player) {
        const items = MarketService.allItems().filter(i => ItemSettingsService.isMarketable(i.id)).sort((a, b) => Math.abs(b.priceChange24h || 0) - Math.abs(a.priceChange24h || 0)).slice(0, 20);
        try {
            const form = new ActionFormData().title(UI.title("", "Trending Items"));
            for (const item of items) buttonWithIcon(form, `§f${itemName(item)}\n${MarketPricing.trendText(item)} §e| §a${MoneyUtils.formatCents(item.buyPrice)}`, itemIcon(item));
            form.button(UI.BACK);
            const r = await form.show(player); 
            if (r.canceled) return; if (r.selection >= items.length) return this.open(player);
            return this.itemDetails(player, items[r.selection].id);
        } catch (e) { try { player.sendMessage("§cUI Error: " + String(e)); console.warn(e, e.stack); } catch(ex){} }
    }

    static async mailbox(player) {
        const list = MarketService.mailboxList(player);
        const stats = MarketService.mailboxStats(player);
        try {
            const form = new ActionFormData().title(UI.title("", "Market Mailbox")).body(UI.body(`§7Entries: §f${stats.count}`, `§7Money: §a${MoneyUtils.formatCents(stats.money)}`, `§7Items: §f${stats.items}`));
            const actions = [];
            if (list.length) { form.button("§aClaim All"); actions.push({ type: "claim" }); }
            for (const e of list.slice(0, 20)) { form.button(`${e.type === "money" ? "§a" + MoneyUtils.formatCents(e.amount) : "§f" + e.amount + "x " + e.itemId}\n§f${e.reason || "Market mailbox"}`); actions.push({ type: "view", e }); }
            form.button(UI.BACK); actions.push({ type: "back" });
            const r = await form.show(player); 
            if (r.canceled) return;
            const a = actions[r.selection]; 
            if (!a || a.type === "back") return this.open(player);
            if (a.type === "claim") { 
                const c = MarketService.claimMailbox(player); 
                player.sendMessage(CONFIG.PREFIX + `§aClaimed market mailbox. Money ${MoneyUtils.formatCents(c.money)}, Items ${c.items}. Remaining ${c.remaining}.`); 
                return this.open(player); 
            }
            if (a.type === "view") return this.mailboxDetails(player, a.e);
        } catch (e) { try { player.sendMessage("§cUI Error: " + String(e)); console.warn(e, e.stack); } catch(ex){} }
    }

    static async mailboxDetails(player, entry) {
        try {
            await new ActionFormData().title(UI.title("", "Mail Details")).body(UI.body(
                entry.type === "money" ? UI.kv("Amount", MoneyUtils.formatCents(entry.amount || 0), "§a") : UI.kv("Item", `${entry.amount || 0}x ${entry.itemId}`, "§f"),
                UI.kv("Reason", entry.reason || "Market mailbox"),
                UI.kv("Created", entry.createdAt ? new Date(entry.createdAt).toLocaleString() : "Unknown")
            )).button(UI.BACK).show(player);
            return this.mailbox(player);
        } catch (e) { try { player.sendMessage("§cUI Error: " + String(e)); console.warn(e, e.stack); } catch(ex){} }
    }

    static async myOrders(player) {
        const orders = MarketService.myOrders(player);
        const open = orders.filter(o => o.status === "open");
        try {
            const form = new ActionFormData().title(UI.title("", "My Orders")).body(UI.body(`§7Open: §f${open.length}`, `§7Total stored: §f${orders.length}`));
            const actions = [];
            for (const o of orders.slice(0, 30)) { buttonWithIcon(form, `${o.status === "open" ? "§a" : "§f"}${o.type.toUpperCase()} ${o.remaining}/${o.amount} ${ItemCatalog.get(o.itemId)?.name || o.itemId}\n§b@ ${MoneyUtils.formatCents(o.pricePerItem)} §e${o.status}`, itemIcon(o.itemId)); actions.push({ type: "order", o }); }
            form.button(UI.BACK); actions.push({ type: "back" });
            const r = await form.show(player); 
            if (r.canceled) return;
            const a = actions[r.selection]; 
            if (!a || a.type === "back") return this.open(player);
            if (a.type === "order") return this.orderDetails(player, a.o);
        } catch (e) { try { player.sendMessage("§cUI Error: " + String(e)); console.warn(e, e.stack); } catch(ex){} }
    }

    static async orderDetails(player, order) {
        try {
            const form = new ActionFormData().title(UI.title("", "Order Details")).body(UI.body(UI.kv("Type", order.type), UI.kv("Item", order.itemId), UI.kv("Remaining", `${order.remaining}/${order.amount}`), UI.kv("Price", MoneyUtils.formatCents(order.pricePerItem)), UI.kv("Status", order.status)));
            if (order.status === "open") form.button("§cCancel Order");
            form.button(UI.BACK);
            const r = await form.show(player); 
            if (r.canceled) return;
            if (order.status === "open" && r.selection === 0) { const res = MarketService.cancelOrder(player, order.id); player.sendMessage(CONFIG.PREFIX + res.message); return this.myOrders(player); }
            return this.myOrders(player);
        } catch (e) { try { player.sendMessage("§cUI Error: " + String(e)); console.warn(e, e.stack); } catch(ex){} }
    }
}
export default MarketUI;