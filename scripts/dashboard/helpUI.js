// MCity Dashboard V2 - Help & Rules UI
// UX Phase 3 (v1.7.2): Complete multi-page player guide.

import { ActionFormData } from "@minecraft/server-ui";
import { CONFIG } from "../config.js";
import { UI } from "../core/uiTheme.js";
import { Permissions } from "../core/permissions.js";
import { MoneyUtils } from "../core/moneyUtils.js";

function backDashboard(player) { return import("./dashboardSystem.js").then(m => m.DashboardSystem.open(player)); }
function money(cents) { return MoneyUtils.formatCents(Math.max(0, Math.floor(Number(cents) || 0))); }

export class HelpUI {
    static async open(player) {
        const isAdmin = Permissions.canAccessAdminCenter(player);
        const form = new ActionFormData()
            .title(UI.title(UI.ICON.help, "Help & Rules"))
            .body(UI.body(
                "§7Welcome to MCity. Choose a guide below.",
                "§8This help section explains gameplay systems, safe economy usage, and server rules."
            ))
            .button("§aQuick Start")
            .button("§fEconomy & Level")
            .button("§fLand & Protection")
            .button("§fMarket")
            .button("§fContracts")
            .button("§fATM")
            .button("§fPayouts & Mailboxes")
            .button("§cServer Rules")
            .button("§fFAQ");
        if (isAdmin) form.button("§fAdmin Notes");
        form.button(UI.BACK);

        const r = await form.show(player);
        const backIndex = isAdmin ? 10 : 9;
        if (r.canceled) return; if (r.selection === backIndex) return backDashboard(player);
        if (r.selection === 0) return this.page(player, "Quick Start", this.quickStart());
        if (r.selection === 1) return this.page(player, "Economy & Level", this.economy());
        if (r.selection === 2) return this.page(player, "Land & Protection", this.land());
        if (r.selection === 3) return this.page(player, "Market", this.market());
        if (r.selection === 4) return this.page(player, "Contracts", this.contracts());
        if (r.selection === 5) return this.page(player, "ATM", this.atm());
        if (r.selection === 6) return this.page(player, "Payouts & Mailboxes", this.payouts());
        if (r.selection === 7) return this.page(player, "Server Rules", this.rules());
        if (r.selection === 8) return this.page(player, "FAQ", this.faq());
        if (isAdmin && r.selection === 9) return this.page(player, "Admin Notes", this.adminNotes());
    }

    static async page(player, title, lines) {
        await new ActionFormData()
            .title(UI.title(UI.ICON.help, title))
            .body(UI.body(...lines))
            .button(UI.BACK)
            .show(player);
        return this.open(player);
    }

    static quickStart() {
        return [
            "§6MCity is a commandless city/economy dashboard.",
            "§7Open it with the §fMCity Menu §7paper.",
            "", 
            "§eCore loop:",
            "§71. Check your Profile for status.",
            "§72. Use Economy for money and levels.",
            "§73. Use Land to buy/protect chunks.",
            "§74. Use Market and Contracts to trade and earn.",
            "§75. Claim pending money/items from Payouts and mailboxes.",
            "", 
            "§8Tip: if your menu paper is lost, open Settings and recover it."
        ];
    }

    static economy() {
        return [
            "§6Money",
            "§7Money is stored safely by MCity and mirrored to scoreboards for display.",
            `§7Max transfer: §e${money(CONFIG.MONEY.MAX_TRANSFER_CENTS)}`,
            "", 
            "§6Level / Score",
            "§7Score controls your progression level and may improve some rewards.",
            `§7Max score: §b${CONFIG.LEVEL.MAX_SCORE}`,
            "", 
            "§eHow to progress:",
            "§7- Complete contracts.",
            "§7- Use physical ATMs where available.",
            "§7- Participate in server economy systems."
        ];
    }

    static land() {
        return [
            "§6Land Claims",
            `§7Base claim price: §e${money(CONFIG.LAND.BASE_PRICE_CENTS)}`,
            `§7Claim height: §fY ${CONFIG.LAND.MIN_CLAIM_Y}-${CONFIG.LAND.MAX_CLAIM_Y}`,
            `§7Default claim limit: §f${CONFIG.LAND.MAX_CLAIMS_DEFAULT}`,
            "", 
            "§eImportant rules:",
            "§7- Your first claim becomes your Base Chunk.",
            "§7- Extra claims must attach to your allowed base area.",
            "§7- Trusted players can receive roles and permissions.",
            "§7- Taxes must be paid to keep land healthy.",
            `§7Daily tax per chunk: §e${money(CONFIG.LAND.TAX_PER_CHUNK_PER_DAY_CENTS)}`,
            "", 
            "§8Protection blocks griefing, containers, PvP and other actions based on claim flags."
        ];
    }

    static market() {
        return [
            "§6Market",
            "§7Buy and sell configured server items from the Dashboard.",
            "§7Some prices may be dynamic based on stock and demand.",
            "", 
            "§eLimits and safety:",
            `§7Max transaction amount: §f${CONFIG.MARKET.LIMITS.MAX_TRANSACTION_AMOUNT}`,
            `§7Daily buy/sell limits reset about every §f${CONFIG.MARKET.LIMITS.RESET_HOURS}h§7.`,
            "§7If your inventory is full, items can be moved to Market Mailbox.",
            "", 
            "§6Orders",
            `§7Max active orders per player: §f${CONFIG.MARKET.ORDERS.MAX_ACTIVE_PER_PLAYER}`,
            `§7Orders expire after: §f${CONFIG.MARKET.ORDERS.EXPIRE_DAYS} day(s)`
        ];
    }

    static contracts() {
        return [
            "§6Contracts",
            "§7Contracts let players request items or earn money by delivering items.",
            "", 
            "§eTypes:",
            "§7- Player Supply: one worker accepts and completes delivery.",
            "§7- Contribution: multiple players can contribute.",
            "§7- Server Supply: server-created item requests.",
            "", 
            "§6Limits",
            `§7Created active contracts: §f${CONFIG.CONTRACTS.MAX_ACTIVE_CREATED_PER_PLAYER}`,
            `§7Accepted active contracts: §f${CONFIG.CONTRACTS.MAX_ACTIVE_ACCEPTED_PER_PLAYER}`,
            `§7Default expiry: §f${CONFIG.CONTRACTS.DEFAULT_EXPIRE_DAYS} day(s)`,
            "", 
            "§8Rewards may be delivered through pending payouts so offline players do not lose money."
        ];
    }

    static atm() {
        return [
            "§6ATM",
            "§7ATM is a physical world system. Interact with configured ATM blocks/chests.",
            "", 
            "§eExchange tiers:",
            ...Object.values(CONFIG.ATM_INFO.COMBINATION_NAMES || {}).map(name => `§7- ${name}: available from inventory and server rate limit`),
            "", 
            "§8Admins create ATMs and Sources with setup hooks."
        ];
    }

    static payouts() {
        return [
            "§6Payouts",
            "§7Some rewards are queued instead of being paid directly.",
            "§7Open Payouts to claim pending money.",
            "", 
            "§6Mailboxes",
            "§7Market and Contracts can store items/money when you are offline or your inventory is full.",
            "§7Claim mailbox entries from their related module.",
            "", 
            "§eSafety:",
            "§7If something cannot be delivered immediately, MCity tries to keep a pending record so you can claim later."
        ];
    }

    static rules() {
        return [
            "§cServer Rules",
            "§71. Do not exploit bugs, dupes, or economy loopholes.",
            "§72. Do not grief protected land or bypass claim permissions.",
            "§73. Do not scam through fake promises outside official systems.",
            "§74. Report bugs instead of abusing them.",
            "§75. Staff may use audit logs to investigate disputes.",
            "", 
            "§8Breaking rules may result in rollback, fines, jail, or bans depending on server policy."
        ];
    }

    static faq() {
        return [
            "§6FAQ",
            "§eI lost my menu paper.",
            "§7Open Dashboard Settings or rename a paper to the configured menu name.",
            "", 
            "§eWhere did my reward go?",
            "§7Check Payouts, Market Mailbox, or Contract Mailbox.",
            "", 
            "§eWhy can't I build somewhere?",
            "§7The chunk may be claimed, protected by spawn, or inside a restricted zone.",
            "", 
            "§eWhy did a market/contract action fail?",
            "§7Daily limits, inventory space, escrow balance, or changed contract/order state may block the action."
        ];
    }

    static adminNotes() {
        return [
            "§4Admin Notes",
            "§7Use Admin Center for player, economy, land, market, backup and health tools.",
            "", 
            "§eImportant tags:",
            `§7Owner: §f${CONFIG.TAGS.OWNER}`,
            `§7Admin: §f${CONFIG.TAGS.ADMIN}`,
            `§7Moderator: §f${CONFIG.TAGS.MODERATOR}`,
            "", 
            "§eMaintenance:",
            "§7- Create backups before major changes.",
            "§7- Test restore in staging first.",
            "§7- Use Health Check for storage, pruning and risk reports.",
            "§7- Review Audit logs after suspicious economy activity."
        ];
    }
}

export default HelpUI;
