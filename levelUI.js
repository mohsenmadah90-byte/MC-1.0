// MCity Dashboard V2 - Level UI

import { ActionFormData } from "@minecraft/server-ui";
import { UI } from "../../uiTheme.js";
import { CONFIG } from "../../config.js";
import { LevelService } from "./levelService.js";

export class LevelUI {
    static async progress(player, back) {
        const p = LevelService.getProgress(player);
        const percent = Math.floor((p.progress || 0) * 100);
        const lines = [
            `§7Current: ${p.level.color}[${p.level.name}]`,
            UI.kv("Score", p.score, "§b"),
            p.next ? `§7Next: ${p.next.color}[${p.next.name}] §8at §e${p.next.min}` : "§aYou are at the highest configured level.",
            p.next ? UI.kv("Needed", p.needed, "§e") : "",
            p.next ? UI.kv("Progress", `${percent}%`, "§a") : ""
        ];
        const result = await new ActionFormData()
            .title(UI.title(UI.ICON.level, "Level Progress"))
            .body(UI.body(...lines))
            .button("§fView Level Bonuses")
            .button(UI.BACK)
            .show(player);
        if (!result.canceled && result.selection === 0) return this.bonuses(player, back);
        return back(player);
    }

    static async bonuses(player, back) {
        const level = LevelService.getLevelInfo(player);
        const names = CONFIG.ATM_INFO.COMBINATION_NAMES || {};
        const lines = [`§7Current Level: ${level.color}[${level.name}]`, "", "§6ATM Exchange Bonuses"];
        for (const [key, value] of Object.entries(level.bonuses || {})) {
            const pct = Math.round(Number(value || 0) * 100);
            lines.push(`§7${names[key] || key}: §e${pct}%`);
        }
        await new ActionFormData()
            .title(UI.title(UI.ICON.level, "Level Bonuses"))
            .body(UI.body(...lines))
            .button(UI.BACK)
            .show(player);
        return back(player);
    }

    static async leaderboard(player, back, page = 0) {
        const list = LevelService.leaderboard(100);
        const per = CONFIG.UI.LONG_LIST_PAGE_SIZE || 10;
        const totalPages = Math.max(1, Math.ceil(list.length / per));
        page = Math.max(0, Math.min(page, totalPages - 1));
        const slice = list.slice(page * per, page * per + per);
        const form = new ActionFormData()
            .title(UI.title(UI.ICON.level, "Level Leaderboard"))
            .body(UI.body(`§7Players: §f${list.length}`, `§7Page: §f${page + 1}/${totalPages}`));
        const actions = [];
        for (let i = 0; i < slice.length; i++) {
            const rank = page * per + i + 1;
            const rec = slice[i];
            form.button(`§e#${rank} §f${rec.name}\n${rec.level.color}[${rec.level.name}] §b${rec.score}`);
            actions.push({ type: "view", rec, rank });
        }
        if (page < totalPages - 1) { form.button(UI.NEXT); actions.push({ type: "next" }); }
        if (page > 0) { form.button(UI.PREV); actions.push({ type: "prev" }); }
        form.button(UI.BACK); actions.push({ type: "back" });
        const result = await form.show(player);
        if (result.canceled) return;
        const action = actions[result.selection];
        if (!action || action.type === "back") return back(player);
        if (action.type === "next") return this.leaderboard(player, back, page + 1);
        if (action.type === "prev") return this.leaderboard(player, back, page - 1);
        await new ActionFormData()
            .title(`§e#${action.rank} ${action.rec.name}`)
            .body(UI.body(`§7Level: ${action.rec.level.color}[${action.rec.level.name}]`, UI.kv("Score", action.rec.score, "§b"), UI.kv("Last Seen", action.rec.lastSeen ? new Date(action.rec.lastSeen).toLocaleString() : "Unknown")))
            .button(UI.BACK)
            .show(player);
        return this.leaderboard(player, back, page);
    }
}

export default LevelUI;
