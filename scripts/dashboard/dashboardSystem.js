// MCity Dashboard V2 - Dashboard System Foundation
// Phase 1: dashboard modules, help/settings, menu entry integration.
// UX Phase 3 (v1.7.2): Help & Rules rebuilt as a full multi-page guide.

import { ActionFormData } from "@minecraft/server-ui";
import { CONFIG } from "../config.js";
import { UI } from "../core/uiTheme.js";
import { Logger } from "../core/logger.js";
import { Permissions } from "../core/permissions.js";
import { DashboardEntry } from "./dashboardEntry.js";
import { MinePhoneService } from "../core/minePhoneService.js";
import { LeaderboardSettingsService } from "../core/leaderboardSettingsService.js";
import { CustomCardService } from "../core/customCardService.js";
import { DashboardRouter } from "./dashboardRouter.js";
import { EconomyUI } from "../modules/economy/economyUI.js";
import { PayoutUI } from "../modules/finance/payoutUI.js";
import { DashboardNotifications } from "./dashboardNotifications.js";
import { MarketUI } from "../modules/market/marketUI.js";
import { LandUI } from "../modules/land/landUI.js";
import { ContractUI } from "../modules/contracts/contractUI.js";
import { ATMAdminUI } from "../modules/atm/atmAdminUI.js";
import { AdminDashboard } from "./adminDashboard.js";
import { FriendUI } from "../modules/friends/friendUI.js";
import { ProfileUI } from "./profileUI.js";
import { HelpUI } from "./helpUI.js";

export class DashboardSystem {
    static #initialized = false;

    static initialize() {
        if (this.#initialized) return;
        this.#initialized = true;
        DashboardRouter.clear();
        this.#registerCoreModules();
        Logger.startup("Dashboard", "Core router initialized");
    }

    static async open(player, options = {}) {
        if (!Permissions.canUseDashboard(player)) return;
        return DashboardRouter.openHome(player, options);
    }

    static #registerCoreModules() {
        const placeholder = (title) => async (player) => {
            await new ActionFormData()
                .title(UI.title(UI.ICON.system, title))
                .body(UI.missingModule(title))
                .button(UI.BACK)
                .show(player);
            return this.open(player);
        };

        DashboardRouter.register({ id: "profile", title: "Profile", icon: UI.ICON.profile, color: "§f", order: 10, open: ProfileUI.open.bind(ProfileUI), badge: ProfileUI.badge.bind(ProfileUI), summary: ProfileUI.summary.bind(ProfileUI) });
        DashboardRouter.register({ id: "friends", title: "Friends", icon: UI.ICON.profile, color: "§b", order: 15, open: FriendUI.open.bind(FriendUI) });
        DashboardRouter.register({ id: "economy", title: "Economy", icon: UI.ICON.money, color: "§f", order: 20, open: EconomyUI.open.bind(EconomyUI), badge: EconomyUI.badge.bind(EconomyUI), summary: EconomyUI.summary.bind(EconomyUI) });
        DashboardRouter.register({ id: "market", title: "Market", icon: UI.ICON.market, color: "§f", order: 30, open: MarketUI.open.bind(MarketUI), badge: MarketUI.badge.bind(MarketUI), summary: MarketUI.summary.bind(MarketUI) });
        DashboardRouter.register({ id: "land", title: "Land", icon: UI.ICON.land, color: "§f", order: 40, open: LandUI.open.bind(LandUI), badge: LandUI.badge.bind(LandUI), summary: LandUI.summary.bind(LandUI) });
        DashboardRouter.register({ id: "contracts", title: "Contracts", icon: UI.ICON.contract, color: "§f", order: 50, open: ContractUI.open.bind(ContractUI), badge: ContractUI.badge.bind(ContractUI), summary: ContractUI.summary.bind(ContractUI) });
        DashboardRouter.register({ id: "payouts", title: "Payouts", icon: UI.ICON.finance, color: "§f", order: 60, open: PayoutUI.open.bind(PayoutUI), badge: PayoutUI.badge.bind(PayoutUI), summary: PayoutUI.summary.bind(PayoutUI) });
        DashboardRouter.register({ id: "notifications", title: "Notifications", icon: UI.ICON.notification, color: "§f", order: 70, open: DashboardNotifications.open.bind(DashboardNotifications), badge: DashboardNotifications.badge.bind(DashboardNotifications), summary: DashboardNotifications.summary.bind(DashboardNotifications) });
        DashboardRouter.register({ id: "help", title: "Help & Rules", icon: UI.ICON.help, color: "§f", order: 80, open: HelpUI.open.bind(HelpUI) });
        DashboardRouter.register({ id: "settings", title: "Settings", icon: UI.ICON.settings, color: "§f", order: 90, open: this.openSettings.bind(this) });
        DashboardRouter.register({ id: "atm_admin", title: "ATM Admin", icon: UI.ICON.atm, color: "§3", order: 850, visible: p => Permissions.canManageATM(p), open: ATMAdminUI.open.bind(ATMAdminUI) });
        DashboardRouter.register({ id: "admin", title: "Admin Center", icon: UI.ICON.admin, color: "§c", order: 900, visible: p => Permissions.canAccessAdminCenter(p), open: AdminDashboard.open.bind(AdminDashboard) });
    }

    static async openHelp(player) {
        return HelpUI.open(player);
    }

    static async openSettings(player) {
        const hasItem = DashboardEntry.hasMenuItem(player);
        const given = !!player.getDynamicProperty(CONFIG.DASHBOARD.GIVEN_PROPERTY);
        const form = new ActionFormData()
            .title(UI.title(UI.ICON.settings, "Mine Phone Settings"))
            .body(UI.body(
                UI.kv("Mine Phone", CONFIG.DASHBOARD.ENABLED ? "Enabled" : "Disabled", CONFIG.DASHBOARD.ENABLED ? "§a" : "§c"),
                UI.kv("Phone Item", `${CONFIG.DASHBOARD.ITEM_ID} (${CONFIG.DASHBOARD.ITEM_NAME})`),
                UI.kv("Has Mine Phone", hasItem ? "Yes" : "No", hasItem ? "§a" : "§e"),
                UI.kv("Given Flag", given ? "Yes" : "No", given ? "§a" : "§e"),
                UI.kv("Flash Light", MinePhoneService.flashlight(player) ? "ON" : "OFF", MinePhoneService.flashlight(player) ? "§e" : "§8"),
                UI.kv("Money Leaderboard", LeaderboardSettingsService.moneyVisible(player) ? "Shown" : "Hidden"),
                UI.kv("Level Leaderboard", LeaderboardSettingsService.levelVisible(player) ? "Shown" : "Hidden"),
                "§8Mine Phone information and preferences."
            ))
            .button("§aGive / Recover Mine Phone")
            .button("§eReset Given Flag")
            .button("§6Flash Light")
            .button("§bPhone Information")
            .button("§aToggle Money Leaderboard")
            .button("§bToggle Level Leaderboard")
            .button(UI.BACK);
        const result = await form.show(player);
        if (result.canceled) return; if (result.selection === 6) return this.open(player);
        if (result.selection === 0) {
            const ok = DashboardEntry.ensureMenuItem(player, true);
            player.sendMessage(CONFIG.PREFIX + (ok ? "§aMine Phone recovered." : "§cCould not give Mine Phone. Check inventory space."));
            return this.openSettings(player);
        }
        if (result.selection === 1) {
            DashboardEntry.resetGivenFlag(player);
            player.sendMessage(CONFIG.PREFIX + "§aMine Phone given flag reset.");
            return this.openSettings(player);
        }
        if (result.selection === 2) {
            const enabled = MinePhoneService.toggleFlashlight(player);
            player.sendMessage(CONFIG.PREFIX + (enabled ? "§eFlash Light enabled." : "§7Flash Light disabled."));
            return this.openSettings(player);
        }
        if (result.selection === 3) return this.phoneInformation(player);
        if (result.selection === 4) { LeaderboardSettingsService.setMoneyVisible(player, !LeaderboardSettingsService.moneyVisible(player)); return this.openSettings(player); }
        if (result.selection === 5) { LeaderboardSettingsService.setLevelVisible(player, !LeaderboardSettingsService.levelVisible(player)); return this.openSettings(player); }
    }

    static async phoneInformation(player) {
        let card = null;
        const inventory = player.getComponent("minecraft:inventory")?.container;
        if (inventory) for (let i = 0; i < inventory.size; i++) { const result = CustomCardService.validate(player, inventory.getItem(i)); if (result.valid) { card = result.card; break; } }
        const lines = [
            UI.kv("Phone", "Mine Phone", "§b"),
            UI.kv("Battery", `${MinePhoneService.battery(player).toFixed(0)}%`, "§a"),
            UI.kv("Flash Light", MinePhoneService.flashlight(player) ? "ON" : "OFF"),
            UI.kv("Personal Card", card ? "Valid" : "Not found", card ? "§a" : "§e")
        ];
        if (card) { lines.push(UI.kv("Card Color", card.color, "§f"), UI.kv("Card Owner", card.ownerId === player.id ? "You" : "Other", "§f"), UI.kv("Card Version", card.version, "§f")); }
        await new ActionFormData().title(UI.title(UI.ICON.settings, "Phone Information")).body(UI.body(...lines)).button(UI.BACK).show(player);
        return this.openSettings(player);
    }

    static shutdown() {
        DashboardRouter.clear();
        this.#initialized = false;
    }
}

export default DashboardSystem;
