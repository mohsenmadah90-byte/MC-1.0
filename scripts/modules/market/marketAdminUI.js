// MCity Dashboard V2 - Market Admin UI Foundation
// Full Admin Center integration is planned for Phase 8.
// Phase 7.6 (v0.23.0) (S5): Uses MarketService public methods instead of
//                          calling Database directly.
// UX Phase 7 (v1.7.6): Add/Edit item flow uses searchable ItemPicker UI.
// Fix E (v1.8.1): Market item/category delete management tools.

import { ActionFormData, ModalFormData, MessageFormData } from "@minecraft/server-ui";
import { UI } from "../../core/uiTheme.js";
import { CONFIG } from "../../config.js";
import { Permissions } from "../../core/permissions.js";
import { MoneyUtils } from "../../core/moneyUtils.js";
import { ItemPickerUI } from "../../core/itemPickerUI.js";
import { ItemSettingsService } from "../../core/itemSettingsService.js";
import { normalizeMarketItem, normalizeItemId } from "../../schemas/marketSchema.js";
import { MarketService } from "./marketService.js";
import { MarketShardService } from "./marketShardService.js";

function __mcityCan(player) { return Permissions.canManageMarket(player); }
function __mcityLost(player) { if (__mcityCan(player)) return false; try { player.sendMessage("§cPermission changed. Action cancelled."); } catch {} return true; }
function __advancedAllowed(player) { return Permissions.isOwner(player) || Permissions.isAdmin(player); }
function cleanCategory(value) { return String(value || "materials").toLowerCase().replace(/[^a-z0-9_]/g, "_").substring(0, 32) || "materials"; }

export class MarketAdminUI {
    static async open(player) {
        if (!Permissions.canManageMarket(player)) return;
        const db = MarketService.db();
        const form = new ActionFormData()
            .title(UI.title(UI.ICON.market, "Market Admin"))
            .body(UI.body(`§7Categories: §f${db.categories.length}`, `§7Items: §f${MarketService.allItems(db).length}`))
            .button("§aAdd / Edit Item")
            .button("§fManage Items")
            .button("§fManage Categories")
            .button("§fItem Flags")
            .button("§eRecalculate Prices")
            .button("§6Expire Orders")
            .button("§fVerify Shard Mirrors")
            .button("§eRepair Shard Mirrors")
            .button(UI.BACK);
        const r = await form.show(player);
        if (__mcityLost(player)) return;
        if (r.canceled) return;
        if (r.selection === 8) return this.#back(player);
        if (r.selection === 0) return this.addEdit(player);
        if (r.selection === 1) return this.itemList(player, 0);
        if (r.selection === 2) return this.categoryList(player, 0);
        if (r.selection === 3) return this.itemFlags(player);
        if (r.selection === 4) {
            const res = MarketService.recalculateAllPrices();
            player.sendMessage(CONFIG.PREFIX + `§aMarket prices recalculated for ${res.count} items.`);
            return this.open(player);
        }
        if (r.selection === 5) {
            const res = MarketService.expireOrders();
            player.sendMessage(CONFIG.PREFIX + `§aExpired orders: §e${res.count}`);
            return this.open(player);
        }
        if (r.selection === 6) return this.verifyShards(player);
        if (r.selection === 7) return this.repairShards(player);
    }

    static async verifyShards(player) {
        if (!__mcityCan(player)) return;
        const rep = MarketShardService.verifyMirrors();
        await new ActionFormData()
            .title(UI.title(UI.ICON.market, "Market Shard Verify"))
            .body(UI.body(
                UI.kv("Status", rep.ok ? "OK" : "Needs Repair", rep.ok ? "§a" : "§c"),
                UI.kv("Legacy mailbox players", rep.legacyMailboxPlayers, rep.legacyMailboxPlayers ? "§e" : "§a"),
                UI.kv("Player order mismatches", rep.playerOrderMismatches, rep.playerOrderMismatches ? "§c" : "§a"),
                UI.kv("Player limit mismatches", rep.playerLimitMismatches, rep.playerLimitMismatches ? "§c" : "§a"),
                UI.kv("Order books", rep.orderBooks),
                UI.kv("Order book mismatches", rep.orderBookMismatches, rep.orderBookMismatches ? "§c" : "§a"),
                UI.kv("Missing order shard books", rep.missingOrderShardBooks, rep.missingOrderShardBooks ? "§e" : "§a")
            ))
            .button(UI.BACK)
            .show(player);
        return this.open(player);
    }

    static async repairShards(player) {
        if (!__mcityCan(player)) return;
        const res = MarketShardService.repairMirrors();
        await new ActionFormData()
            .title(UI.title(UI.ICON.market, "Market Shard Repair"))
            .body(UI.body(
                UI.kv("Player mirrors", res.playerMirrors),
                UI.kv("Order mirrors", res.orderMirrors),
                UI.kv("Moved legacy mailbox", res.movedMailbox),
                UI.kv("Verify after repair", res.verify?.ok ? "OK" : "Needs Attention", res.verify?.ok ? "§a" : "§c")
            ))
            .button(UI.BACK)
            .show(player);
        return this.open(player);
    }

    static async addEdit(player) {
        if (!__mcityCan(player)) return;
        const form = new ActionFormData()
            .title(UI.title(UI.ICON.market, "Add / Edit Market Item"))
            .body(UI.body(
                "§7Choose how to select the item.",
                "§aCatalog Search §7is recommended and blocks unsafe/banned items.",
                __advancedAllowed(player) ? "§eAdvanced Custom ID §7is for owner/admin edge cases." : ""
            ))
            .button("§aSearch Item Catalog")
            .button("§eAdvanced Custom Item ID")
            .button(UI.BACK);
        const r = await form.show(player);
        if (__mcityLost(player)) return;
        if (r.canceled) return;
        if (r.selection === 2) return this.open(player);
        if (r.selection === 0) return this.addEditFromCatalog(player);
        if (r.selection === 1) {
            if (!__advancedAllowed(player)) {
                player.sendMessage(CONFIG.PREFIX + "§cOnly owner/admin can use custom item IDs.");
                return this.open(player);
            }
            return this.addEditCustom(player);
        }
    }

    static async itemList(player, page = 0) {
        if (!__mcityCan(player)) return;
        const db = MarketService.db();
        const entries = [];
        for (const cat of db.categories || []) for (const item of cat.items || []) entries.push({ item, category: cat.name });
        const per = CONFIG.UI.ITEMS_PER_PAGE || 8;
        const total = Math.max(1, Math.ceil(entries.length / per));
        page = Math.max(0, Math.min(page, total - 1));
        const slice = entries.slice(page * per, page * per + per);
        const form = new ActionFormData().title(UI.title(UI.ICON.market, "Manage Market Items")).body(UI.body(`§7Items: §f${entries.length}`, `§7Page: §f${page + 1}/${total}`));
        const actions = [];
        for (const e of slice) {
            form.button(`${e.item.displayName || e.item.id}\n§b${e.item.id} | ${e.category}`);
            actions.push({ type: "item", itemId: e.item.id, category: e.category });
        }
        if (page < total - 1) { form.button(UI.NEXT); actions.push({ type: "next" }); }
        if (page > 0) { form.button(UI.PREV); actions.push({ type: "prev" }); }
        form.button(UI.BACK); actions.push({ type: "back" });
        const r = await form.show(player);
        if (__mcityLost(player)) return;
        if (r.canceled) return;
        const a = actions[r.selection];
        if (!a || a.type === "back") return this.open(player);
        if (a.type === "next") return this.itemList(player, page + 1);
        if (a.type === "prev") return this.itemList(player, page - 1);
        return this.itemDetails(player, a.itemId, page);
    }

    static async itemDetails(player, itemId, page = 0) {
        if (!__mcityCan(player)) return;
        const found = MarketService.findItem(itemId);
        if (!found) { player.sendMessage(CONFIG.PREFIX + "§cItem not found."); return this.itemList(player, page); }
        const item = found.item;
        const openOrders = MarketService.countOpenOrdersForItem(MarketService.db(), item.id);
        const form = new ActionFormData()
            .title(UI.title(UI.ICON.market, "Market Item Details"))
            .body(UI.body(
                UI.kv("Name", item.displayName || item.id, "§e"),
                UI.kv("ID", item.id, "§f"),
                UI.kv("Category", found.category.name, "§f"),
                UI.kv("Buy", MoneyUtils.formatCents(item.buyPrice || item.baseBuyPrice || 0), "§a"),
                UI.kv("Sell", MoneyUtils.formatCents(item.sellPrice || item.baseSellPrice || 0), "§e"),
                UI.kv("Stock", item.stock || 0),
                UI.kv("Target", item.targetStock || 0),
                UI.kv("Open Orders", openOrders, openOrders ? "§c" : "§a")
            ))
            .button("§cRemove Item")
            .button(UI.BACK);
        const r = await form.show(player);
        if (__mcityLost(player)) return;
        if (r.canceled) return;
        if (r.selection === 1) return this.itemList(player, page);
        if (r.selection === 0) return this.confirmRemoveItem(player, item.id, page, openOrders);
    }

    static async confirmRemoveItem(player, itemId, page = 0, openOrders = 0) {
        if (!__mcityCan(player)) return;
        const body = openOrders > 0
            ? `§cThis item has ${openOrders} open order(s).\nCancel or expire orders before removing it.`
            : `§7Remove market item:\n§f${itemId}\n\n§cThis cannot be undone.`;
        if (openOrders > 0) {
            await new ActionFormData().title("§cCannot Remove Item").body(UI.body(body)).button(UI.BACK).show(player);
            return this.itemDetails(player, itemId, page);
        }
        const c = await new MessageFormData().title("§cRemove Market Item").body(body).button1("§cRemove").button2("§aKeep").show(player);
        if (__mcityLost(player)) return;
        if (c.canceled) return;
        if (c.selection !== 0) return this.itemDetails(player, itemId, page);
        const res = MarketService.removeItem(itemId);
        player.sendMessage(CONFIG.PREFIX + res.message);
        return this.itemList(player, page);
    }

    static async categoryList(player, page = 0) {
        if (!__mcityCan(player)) return;
        const cats = MarketService.categories();
        const per = CONFIG.UI.ITEMS_PER_PAGE || 8;
        const total = Math.max(1, Math.ceil(cats.length / per));
        page = Math.max(0, Math.min(page, total - 1));
        const slice = cats.slice(page * per, page * per + per);
        const form = new ActionFormData().title(UI.title(UI.ICON.market, "Manage Categories")).body(UI.body(`§7Categories: §f${cats.length}`, `§7Page: §f${page + 1}/${total}`));
        const actions = [];
        for (const cat of slice) {
            form.button(`${cat.displayName || cat.name}\n§b${cat.name} | ${cat.items?.length || 0} items`);
            actions.push({ type: "category", name: cat.name });
        }
        if (page < total - 1) { form.button(UI.NEXT); actions.push({ type: "next" }); }
        if (page > 0) { form.button(UI.PREV); actions.push({ type: "prev" }); }
        form.button(UI.BACK); actions.push({ type: "back" });
        const r = await form.show(player);
        if (__mcityLost(player)) return;
        if (r.canceled) return;
        const a = actions[r.selection];
        if (!a || a.type === "back") return this.open(player);
        if (a.type === "next") return this.categoryList(player, page + 1);
        if (a.type === "prev") return this.categoryList(player, page - 1);
        return this.categoryDetails(player, a.name, page);
    }

    static async categoryDetails(player, categoryName, page = 0) {
        if (!__mcityCan(player)) return;
        const cat = MarketService.categories().find(c => c.name === categoryName);
        if (!cat) { player.sendMessage(CONFIG.PREFIX + "§cCategory not found."); return this.categoryList(player, page); }
        const itemIds = (cat.items || []).map(i => i.id);
        const openOrders = itemIds.reduce((sum, id) => sum + MarketService.countOpenOrdersForItem(MarketService.db(), id), 0);
        const form = new ActionFormData()
            .title(UI.title(UI.ICON.market, "Category Details"))
            .body(UI.body(
                UI.kv("Name", cat.displayName || cat.name, "§e"),
                UI.kv("ID", cat.name, "§f"),
                UI.kv("Items", cat.items?.length || 0),
                UI.kv("Open Orders", openOrders, openOrders ? "§c" : "§a")
            ))
            .button("§cRemove Category")
            .button(UI.BACK);
        const r = await form.show(player);
        if (__mcityLost(player)) return;
        if (r.canceled) return;
        if (r.selection === 1) return this.categoryList(player, page);
        if (r.selection === 0) return this.confirmRemoveCategory(player, cat.name, page, cat.items?.length || 0, openOrders);
    }

    static async confirmRemoveCategory(player, categoryName, page = 0, itemCount = 0, openOrders = 0) {
        if (!__mcityCan(player)) return;
        if (openOrders > 0) {
            await new ActionFormData().title("§cCannot Remove Category").body(UI.body(`§cThis category has ${openOrders} open order(s).`, "§7Cancel or expire orders first.")).button(UI.BACK).show(player);
            return this.categoryDetails(player, categoryName, page);
        }
        const body = `§7Remove category: §f${categoryName}\n§7Items inside: §e${itemCount}\n\n§cRemoving a category also removes all its items. This cannot be undone.`;
        const c = await new MessageFormData().title("§cRemove Market Category").body(body).button1("§cRemove").button2("§aKeep").show(player);
        if (__mcityLost(player)) return;
        if (c.canceled) return;
        if (c.selection !== 0) return this.categoryDetails(player, categoryName, page);
        const res = MarketService.removeCategory(categoryName, { deleteItems: true });
        player.sendMessage(CONFIG.PREFIX + res.message);
        return this.categoryList(player, page);
    }

    static async itemFlags(player) {
        if (!__mcityCan(player)) return;
        const selected = await ItemPickerUI.pick(player, { mode: "admin", title: "Select Item Flags", pageSize: CONFIG.UI.ITEMS_PER_PAGE || 8 });
        if (__mcityLost(player)) return;
        if (!selected) return this.open(player);
        return this.itemFlagDetails(player, selected.id);
    }

    static async itemFlagDetails(player, itemId) {
        if (!__mcityCan(player)) return;
        const item = ItemSettingsService.effective(itemId);
        if (!item) { player.sendMessage(CONFIG.PREFIX + "§cCatalog item not found."); return this.open(player); }
        const override = ItemSettingsService.overrideFor(item.id);
        const form = new ActionFormData()
            .title(UI.title(UI.ICON.market, "Item Flags"))
            .body(UI.body(
                UI.kv("Item", item.name, "§e"),
                UI.kv("ID", item.id, "§f"),
                UI.kv("Category", item.category),
                UI.kv("Marketable", item.marketable ? "ON" : "OFF", item.marketable ? "§a" : "§c"),
                UI.kv("Contractable", item.contractable ? "ON" : "OFF", item.contractable ? "§a" : "§c"),
                UI.kv("Override", override ? "Custom" : "Default", override ? "§e" : "§a"),
                item.adminOnly ? "§cAdmin-only catalog item" : "",
                item.dangerous ? "§eDangerous/sensitive item" : ""
            ))
            .button(item.marketable ? "§cDisable Marketable" : "§aEnable Marketable")
            .button(item.contractable ? "§cDisable Contractable" : "§aEnable Contractable")
            .button("§eReset Override")
            .button(UI.BACK);
        const r = await form.show(player);
        if (__mcityLost(player)) return;
        if (r.canceled) return;
        if (r.selection === 3) return this.open(player);
        if (r.selection === 0) {
            const res = ItemSettingsService.setFlags(item.id, { marketable: !item.marketable }, player.name);
            player.sendMessage(CONFIG.PREFIX + res.message);
            return this.itemFlagDetails(player, item.id);
        }
        if (r.selection === 1) {
            const res = ItemSettingsService.setFlags(item.id, { contractable: !item.contractable }, player.name);
            player.sendMessage(CONFIG.PREFIX + res.message);
            return this.itemFlagDetails(player, item.id);
        }
        if (r.selection === 2) {
            const res = ItemSettingsService.reset(item.id);
            player.sendMessage(CONFIG.PREFIX + res.message);
            return this.itemFlagDetails(player, item.id);
        }
    }

    static async addEditFromCatalog(player) {
        if (!__mcityCan(player)) return;
        const selected = await ItemPickerUI.pick(player, { mode: "market", title: "Select Market Item", pageSize: CONFIG.UI.ITEMS_PER_PAGE || 8 });
        if (__mcityLost(player)) return;
        if (!selected) { player.sendMessage(CONFIG.PREFIX + "§eMarket item creation cancelled: no item selected."); return this.open(player); }
        return this.configureItem(player, {
            id: selected.id,
            displayName: selected.name,
            category: selected.category || "materials",
            fromCatalog: true
        });
    }

    static async addEditCustom(player) {
        if (!__advancedAllowed(player)) return;
        const r = await new ModalFormData()
            .title("§eAdvanced Custom Market Item")
            .textField("Category", "materials", { defaultValue: "materials" })
            .textField("Item ID", "minecraft:diamond")
            .textField("Display Name", "Diamond")
            .show(player);
        if (__mcityLost(player)) return;
        if (r.canceled) return;
        return this.configureItem(player, {
            id: normalizeItemId(r.formValues[1]),
            displayName: r.formValues[2] || null,
            category: cleanCategory(r.formValues[0]),
            fromCatalog: false,
            custom: true
        });
    }

    static async configureItem(player, base) {
        if (!__mcityCan(player)) return;
        const r = await new ModalFormData()
            .title("§aConfigure Market Item")
            .textField("Category", "materials", { defaultValue: base.category || "materials" })
            .textField("Display Name", base.displayName || base.id)
            .textField("Base Buy Price ($)", "20.00")
            .textField("Base Sell Price ($)", "14.00")
            .textField("Stock", "100")
            .textField("Target Stock", "100")
            .show(player);
        if (__mcityLost(player)) return;
        if (r.canceled) return;
        const buy = MoneyUtils.parseFloatToCents(r.formValues[2], false);
        const sell = MoneyUtils.parseFloatToCents(r.formValues[3], false);
        if (!buy.ok || !sell.ok) { player.sendMessage(CONFIG.PREFIX + "§cInvalid price."); return this.open(player); }
        const catName = cleanCategory(r.formValues[0]);
        const itemId = normalizeItemId(base.id);
        const item = normalizeMarketItem({
            id: itemId,
            displayName: r.formValues[1] || base.displayName || null,
            baseBuyPrice: buy.cents,
            baseSellPrice: sell.cents,
            buyPrice: buy.cents,
            sellPrice: sell.cents,
            stock: Number(r.formValues[4]) || 0,
            targetStock: Number(r.formValues[5]) || 1
        });

        const confirm = await new ActionFormData()
            .title(UI.title(UI.ICON.market, "Confirm Market Item"))
            .body(UI.body(
                UI.kv("Item", item.displayName || item.id, "§e"),
                UI.kv("ID", item.id, "§8"),
                UI.kv("Source", base.fromCatalog ? "Catalog" : "Advanced Custom", base.fromCatalog ? "§a" : "§e"),
                UI.kv("Category", catName),
                UI.kv("Buy", MoneyUtils.formatCents(buy.cents), "§a"),
                UI.kv("Sell", MoneyUtils.formatCents(sell.cents), "§e"),
                UI.kv("Stock", item.stock),
                UI.kv("Target Stock", item.targetStock),
                "",
                "§8Add or update this market item?"
            ))
            .button("§aSave Item")
            .button("§cCancel")
            .show(player);
        if (__mcityLost(player)) return;
        if (confirm.canceled) return; if (confirm.selection !== 0) return this.open(player);

        const res = MarketService.addItem(item, catName, true);
        player.sendMessage(CONFIG.PREFIX + res.message);
        return this.open(player);
    }

    static #back(player) { return import("../../dashboard/dashboardSystem.js").then(m => m.DashboardSystem.open(player)); }
}

export default MarketAdminUI;
