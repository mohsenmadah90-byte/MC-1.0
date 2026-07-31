import { CONFIG } from "../config.js";

// MCity Dashboard V2 - UI Theme
// v1.7.9: centralized palette. Button subtext intentionally avoids gray.
export const UI = {
    COLOR: {
        title: "§3",
        main: "§f",
        sub: "§b",
        badge: "§e",
        success: "§a",
        warning: "§e",
        danger: "§c",
        admin: "§c",
        money: "§6",
        body: "§7",
        muted: "§8"
    },
    SEP: "§8━━━━━━━━━━━━━━━━",
    BACK: "§fBack",
    CLOSE: "§fClose",
    NEXT: "§fNext",
    PREV: "§fPrev",
    ICON: { system: "", dashboard: "", profile: "", money: "", level: "", market: "", land: "", contract: "", finance: "", notification: "", help: "", settings: "", admin: "", atm: "", backup: "", audit: "", close: "" },
    title(icon, title, subtitle = "") { return subtitle ? `${this.COLOR.title}§l${title}\n${this.COLOR.sub}${subtitle}` : `${this.COLOR.title}§l${title}`; },
    body(...lines) { return [this.SEP, ...lines.filter(l => l !== undefined && l !== null), this.SEP].join("\n"); },
    kv(key, value, color = "§f") { return `§f${key}: ${color}${value}`; },
    button(label, sub = "", style = "normal") {
        let main = this.COLOR.main;
        if (style === "danger") main = this.COLOR.danger;
        else if (style === "success") main = this.COLOR.success;
        else if (style === "warning") main = this.COLOR.warning;
        else if (style === "admin") main = this.COLOR.admin;
        return sub ? `${main}${label}\n${this.COLOR.sub}${sub}` : `${main}${label}`;
    },
    action(icon, color, label, sub = "") {
        // Existing callers pass many module-specific colors. To avoid a
        // rainbow UI, only danger/admin intent keeps a strong color; normal
        // navigation uses neutral main text with cyan subtext.
        const style = color && color.includes("§c") ? "danger" : "normal";
        return this.button(label, sub, style);
    },
    badge(label, badgeText) { return badgeText ? `${label}\n${this.COLOR.badge}${badgeText}` : label; },
    missingModule(m) { return this.body(`§f${m} is under construction.`, "§fPlease check back later."); }
};
export default UI;
