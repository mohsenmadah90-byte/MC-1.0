// MCity Dashboard V2 - Item Picker UI
// UX Phase 5 (v1.7.4): Reusable searchable item selection UI.

import { ActionFormData, ModalFormData } from "@minecraft/server-ui";
import { UI } from "../uiTheme.js";
import { ITEM_CATEGORIES } from "./itemCatalog.js";
import { ItemSettingsService } from "./itemSettingsService.js";

const DEFAULT_PAGE_SIZE = 8;

function modeLabel(mode) {
    if (mode === "contract") return "Contract Items";
    if (mode === "market") return "Market Items";
    if (mode === "admin") return "Admin Catalog";
    return "Item Catalog";
}

function categoryName(cat) {
    return ITEM_CATEGORIES[cat] || cat || "All";
}

export class ItemPickerUI {
    /**
     * Open the picker and resolve to the selected catalog item or null.
     *
     * @param {Player} player
     * @param {object} options
     * @param {string} options.mode - any | contract | market | admin
     * @param {string} options.title
     * @param {string|null} options.initialQuery
     * @param {string|null} options.category
     * @param {number} options.pageSize
     * @returns {Promise<object|null>}
     */
    static async pick(player, options = {}) {
        const state = {
            mode: options.mode || "any",
            title: options.title || modeLabel(options.mode || "any"),
            query: options.initialQuery || "",
            category: options.category || null,
            pageSize: Math.max(3, Math.min(20, Math.floor(options.pageSize || DEFAULT_PAGE_SIZE)))
        };
        return this.#searchForm(player, state);
    }

    static async #searchForm(player, state) {
        const categories = ["all", ...Object.keys(ITEM_CATEGORIES)];
        const currentIndex = Math.max(0, categories.indexOf(state.category || "all"));
        const form = new ModalFormData()
            .title(`§3§l${state.title}`)
            .textField("Search item", "iron / آهن / wheat / diamond", { defaultValue: state.query || "" })
            .dropdown("Category", categories.map(c => c === "all" ? "All Categories" : categoryName(c)), { defaultValueIndex: currentIndex });
        const r = await form.show(player);
        if (r.canceled) return;
        state.query = String(r.formValues?.[0] || "").trim();
        const selectedCategory = categories[Math.max(0, Math.floor(Number(r.formValues?.[1]) || 0))] || "all";
        state.category = selectedCategory === "all" ? null : selectedCategory;
        return this.#resultsForm(player, state, 0);
    }

    static async #resultsForm(player, state, page = 0) {
        const results = ItemSettingsService.search(state.query, {
            mode: state.mode,
            category: state.category,
            limit: 100
        });
        const totalPages = Math.max(1, Math.ceil(results.length / state.pageSize));
        page = Math.max(0, Math.min(page, totalPages - 1));
        const slice = results.slice(page * state.pageSize, page * state.pageSize + state.pageSize);

        const lines = [
            `§7Mode: §f${modeLabel(state.mode)}`,
            `§7Search: §f${state.query || "all"}`,
            `§7Category: §f${state.category ? categoryName(state.category) : "All"}`,
            `§7Results: §f${results.length} §8| §7Page: §f${page + 1}/${totalPages}`,
            "",
            slice.length ? "§8Select an item:" : "§cNo matching items found."
        ];
        const form = new ActionFormData()
            .title(UI.title(UI.ICON.system, state.title))
            .body(UI.body(...lines));

        const actions = [];
        for (const it of slice) {
            const flags = [];
            if (it.adminOnly) flags.push("Admin");
            if (it.dangerous) flags.push("Danger");
            const sub = `${it.id}${flags.length ? ` | ${flags.join(", ")}` : ""}`;
            try { form.button(`${it.name}\n§b${sub}`, it.icon || undefined); }
            catch { form.button(`${it.name}\n§b${sub}`); }
            actions.push({ type: "select", item: it });
        }

        if (page < totalPages - 1) { form.button(UI.NEXT); actions.push({ type: "next" }); }
        if (page > 0) { form.button(UI.PREV); actions.push({ type: "prev" }); }
        form.button("§eNew Search"); actions.push({ type: "search" });
        form.button(UI.BACK); actions.push({ type: "back" });

        const r = await form.show(player);
        if (r.canceled) return;
        const action = actions[r.selection];
        if (!action || action.type === "back") return null;
        if (action.type === "next") return this.#resultsForm(player, state, page + 1);
        if (action.type === "prev") return this.#resultsForm(player, state, page - 1);
        if (action.type === "search") return this.#searchForm(player, state);
        if (action.type === "select") return this.#confirm(player, state, action.item, page);
        return null;
    }

    static async #confirm(player, state, item, page) {
        const lines = [
            `§7Name: §f${item.name}`,
            `§7ID: §f${item.id}`,
            `§7Category: §f${categoryName(item.category)}`,
            `§7Stack Size: §f${item.stackSize}`,
            `§7Marketable: ${item.marketable ? "§aYes" : "§cNo"}`,
            `§7Contractable: ${item.contractable ? "§aYes" : "§cNo"}`,
            item.adminOnly ? "§cAdmin-only item" : "",
            item.dangerous ? "§eMarked as dangerous/sensitive" : "",
            "",
            "§8Confirm this item?"
        ];
        const form = new ActionFormData()
            .title(UI.title(UI.ICON.system, "Confirm Item"))
            .body(UI.body(...lines))
            .button("§aSelect Item")
            .button("§eBack to Results")
            .button("§cCancel");
        const r = await form.show(player);
        if (r.canceled) return; if (r.selection === 2) return null;
        if (r.selection === 0) return item;
        return this.#resultsForm(player, state, page);
    }

    static formatButton(item) {
        return `${item?.name || "Unknown"}\n§b${item?.id || ""}`;
    }
}

export default ItemPickerUI;
