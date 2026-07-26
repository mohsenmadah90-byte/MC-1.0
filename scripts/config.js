// MCity Dashboard V2 - Central Configuration
// Phase 0: Foundation scaffold

export const CONFIG = {
    VERSION: "1.14.3-market-authority",
    SYSTEM_NAME: "MCity Dashboard V2",
    PREFIX: "§r[§6§lMCity§r] §r",

    TAGS: {
        ADMIN: "admin",
        OWNER: "mcity_owner",
        MODERATOR: "mcity_moderator",
        ECONOMY_ADMIN: "mcity_economy_admin",
        LAND_ADMIN: "mcity_land_admin",
        MARKET_ADMIN: "mcity_market_admin",
        CONTRACT_ADMIN: "mcity_contract_admin",
        ATM_ADMIN: "mcity_atm_admin",
        BACKUP_ADMIN: "mcity_backup_admin"
    },

    COMMANDS: {
        // Phase 0+ design rule: no public command registration.
        ENABLE_PUBLIC_COMMANDS: false,
        ENABLE_ADMIN_COMMANDS: false,
        ENABLE_EMERGENCY_COMMANDS: false
    },

    DATABASE: {
        PREFIX: "mcity2:",
        SAVE_INTERVAL_TICKS: 6000,
        PRUNE_INTERVAL_TICKS: 12000,
        CACHE_CLEANUP_INTERVAL_TICKS: 1200,
        MAX_COLLECTION_SIZE: 3 * 1024 * 1024,
        DYNAMIC_PROPERTY_CHUNK_SIZE: 30000,
        BATCH_SAVE_SIZE: 25,
        AUTO_PRUNE_ENABLED: true,
        MEMORY_MONITOR: {
            ALERT_THRESHOLD: 600000,
            CRITICAL_THRESHOLD: 750000,
            REPORT_INTERVAL_MS: 10 * 60 * 1000,
            CHECK_INTERVAL_TICKS: 6000
        },
        SHARDING: {
            ENABLED: true,
            PLAYER_SHARD_COUNT: 8,
            ITEM_SHARD_COUNT: 8,
            REGION_SIZE_CHUNKS: 16,
            MIGRATION_COLLECTION: "shard_migrations",
            MODULES: {
                MONEY: { ENABLED: true, TYPE: "player_hash", BASE: "money", SHARD_COUNT: 16, EXISTING_COUNT_LOCKED: true },
                LEVEL: { ENABLED: true, TYPE: "player_hash", BASE: "levels", SHARD_COUNT: 8, AUTHORITY: "shard", EXISTING_COUNT_LOCKED: true },
                NOTIFICATIONS: { ENABLED: true, TYPE: "player_hash", BASE: "notifications", SHARD_COUNT: 8, AUTHORITY: "shard", EXISTING_COUNT_LOCKED: true },
                FINANCE_PAYOUTS: { ENABLED: true, TYPE: "player_hash", BASE: "finance_payouts", SHARD_COUNT: 8, AUTHORITY: "shard", EXISTING_COUNT_LOCKED: true },
                MARKET_ORDERS: { ENABLED: true, TYPE: "item_hash", BASE: "market_orders", SHARD_COUNT: 8, AUTHORITY: "shard", EXISTING_COUNT_LOCKED: true },
                MARKET_PLAYERS: { ENABLED: true, TYPE: "player_hash", BASE: "market_players", SHARD_COUNT: 8, AUTHORITY: "shard", EXISTING_COUNT_LOCKED: true },
                CONTRACT_MAILBOX: { ENABLED: true, TYPE: "player_hash", BASE: "contract_mailbox", SHARD_COUNT: 8 },
                LAND_ENTRY_PASSES: { ENABLED: true, TYPE: "player_hash", BASE: "land_entry_passes", SHARD_COUNT: 8 },
                OPERATION_JOURNALS: { ENABLED: true, TYPE: "operation_hash", BASE: "operation_journals", SHARD_COUNT: 8, EXISTING_COUNT_LOCKED: true },
                LAND_REGIONS: { ENABLED: false, TYPE: "region", BASE: "land", REGION_SIZE_CHUNKS: 16 }
            }
        }
    },

    PLAYER_REGISTRY: {
        COLLECTION: "players",
        MAX_PLAYERS: 10000,
        TRACK_FIRST_SEEN: true,
        TRACK_LAST_SEEN: true
    },

    MONEY: {
        COLLECTION: "money",
        DOLLAR_OBJECTIVE: "money",
        CENT_OBJECTIVE: "moneycent",
        MAX_MONEY_CENTS: 100000000,
        STARTING_BALANCE_CENTS: 0,
        TOP_CACHE_TTL_MS: 30000,
        BALANCE_CACHE_TTL_MS: 60000,
        MAX_TRANSFER_CENTS: 100000000
    },

    LEVEL: {
        COLLECTION: "levels",
        SHARD_COUNT: 8,
        SCORE_OBJECTIVE: "playerScore",
        LEVEL_OBJECTIVE: "playerLevel",
        MAX_SCORE: 999999,
        SCORE_CACHE_TTL_MS: 60000,
        LEADERBOARD_CACHE_TTL_MS: 30000,
        LEVELS: [
            {
                name: "Novice", min: 0, max: 49, color: "§f", displayName: "§f[Novice]",
                bonuses: { copper: 1.00, copper_iron: 0.85, iron_emerald: 0.55, emerald_gold: 0.40, gold_diamond: 0.25, diamond_netherite: 0.10 }
            },
            {
                name: "Apprentice", min: 50, max: 99, color: "§a", displayName: "§a[Apprentice]",
                bonuses: { copper: 1.05, copper_iron: 1.00, iron_emerald: 0.85, emerald_gold: 0.55, gold_diamond: 0.40, diamond_netherite: 0.25 }
            },
            {
                name: "Artisan", min: 100, max: 199, color: "§1", displayName: "§1[Artisan]",
                bonuses: { copper: 1.10, copper_iron: 1.05, iron_emerald: 1.00, emerald_gold: 0.85, gold_diamond: 0.55, diamond_netherite: 0.40 }
            },
            {
                name: "Master", min: 200, max: 299, color: "§5", displayName: "§5[Master]",
                bonuses: { copper: 1.15, copper_iron: 1.10, iron_emerald: 1.05, emerald_gold: 1.00, gold_diamond: 0.85, diamond_netherite: 0.55 }
            },
            {
                name: "Investor", min: 300, max: 499, color: "§6", displayName: "§6[Investor]",
                bonuses: { copper: 1.20, copper_iron: 1.15, iron_emerald: 1.10, emerald_gold: 1.05, gold_diamond: 1.00, diamond_netherite: 0.85 }
            },
            {
                name: "Emperor", min: 500, max: 999999, color: "§4", displayName: "§4[Emperor]",
                bonuses: { copper: 1.25, copper_iron: 1.20, iron_emerald: 1.15, emerald_gold: 1.10, gold_diamond: 1.05, diamond_netherite: 1.00 }
            }
        ]
    },

    ATM_INFO: {
        RESET_MINUTES: 10,
        EXCHANGE_LIMITS: {
            copper: 16,
            copper_iron: 4,
            iron_emerald: 4,
            emerald_gold: 4,
            gold_diamond: 4,
            diamond_netherite: 4
        },
        COMBINATION_NAMES: {
            copper: "Copper Only",
            copper_iron: "Copper + Iron",
            iron_emerald: "Iron + Emerald",
            emerald_gold: "Emerald + Gold",
            gold_diamond: "Gold + Diamond",
            diamond_netherite: "Diamond + Netherite"
        }
    },

    ATM: {
        COLLECTION: "atm",
        SOURCE_COLLECTION: "source",
        ATM_BLOCK: "minecraft:emerald_block",
        SOURCE_BLOCK: "minecraft:netherite_block",
        CHEST_BLOCK: "minecraft:chest",
        SETUP_HOOK: "minecraft:tripwire_hook",
        HOOK_ATM_NAME: "atm",
        HOOK_SOURCE_NAME: "source",
        HOOK_SETTING_NAME: "setting",
        MAX_CODES_HISTORY: 500,
        MAX_ACTIVE_ATMS: 500,
        MAX_WAITING_ATMS: 200,
        MAX_ATMS_PER_SOURCE: 50,
        RESET_INTERVAL_TICKS: 10 * 60 * 20,
        RESET_MINUTES: 10,
        BROADCAST_RESET: true,
        BASE_PRICES: {
            copper: 100,
            copper_iron: 500,
            iron_emerald: 1000,
            emerald_gold: 1500,
            gold_diamond: 2500,
            diamond_netherite: 4000
        },
        SCORE_REWARDS: {
            copper: 1,
            copper_iron: 2,
            iron_emerald: 4,
            emerald_gold: 6,
            gold_diamond: 8,
            diamond_netherite: 10
        },
        ORE_COMBINATIONS: {
            copper: ["minecraft:copper_ingot"],
            copper_iron: ["minecraft:copper_ingot", "minecraft:iron_ingot"],
            iron_emerald: ["minecraft:iron_ingot", "minecraft:emerald"],
            emerald_gold: ["minecraft:emerald", "minecraft:gold_ingot"],
            gold_diamond: ["minecraft:gold_ingot", "minecraft:diamond"],
            diamond_netherite: ["minecraft:diamond", "minecraft:netherite_ingot"]
        }
    },

    VILLAGE_PROTECTION: {
        ENABLED: true,
        SCAN_INTERVAL_TICKS: 600,
        CLUSTER_RADIUS_BLOCKS: 48,
        PROTECTION_PADDING_BLOCKS: 8,
        MIN_VILLAGERS_PER_VILLAGE: 1,
        MAX_TRACKED_VILLAGERS: 512,
        TELEPORT_ESCAPED_VILLAGERS: true,
        ALLOWED_INTERACTION_BLOCKS: [
            "door", "trapdoor", "chest", "barrel", "shulker", "furnace", "blast_furnace", "smoker",
            "brewing_stand", "hopper", "dispenser", "dropper", "lectern", "composter", "smithing_table",
            "cartography_table", "fletching_table", "grindstone", "loom", "stonecutter", "villager"
        ]
    },

    CONTRACTS: {
        COLLECTION: "contracts",
        PLAYER_CONTRACT_FEE_RATE: 0.05,
        MAX_ACTIVE_CREATED_PER_PLAYER: 5,
        MAX_ACTIVE_ACCEPTED_PER_PLAYER: 1,
        MAX_CONTRACTS: 5000,
        MAX_COMPLETED_HISTORY: 1000,
        MAX_MAILBOX_PER_PLAYER: 200,
        GC_INTERVAL_TICKS: 6000,
        ITEMS_PER_PAGE: 8,
        DEFAULT_EXPIRE_DAYS: 3,
        SERVER_CONTRACTS_ENABLED: true,
        PLAYER_CONTRACTS_ENABLED: true,
        CONTRIBUTION_CONTRACTS_ENABLED: true,
        DEFAULT_SERVER_CONTRACTS: [
            { title: "Server needs Wheat", category: "farming", itemId: "minecraft:wheat", amountRequired: 128, rewardCents: 250000, rewardScore: 10, resetMode: "daily" },
            { title: "Server needs Cobblestone", category: "mining", itemId: "minecraft:cobblestone", amountRequired: 512, rewardCents: 180000, rewardScore: 8, resetMode: "daily" },
            { title: "Server needs Iron", category: "mining", itemId: "minecraft:iron_ingot", amountRequired: 64, rewardCents: 450000, rewardScore: 15, resetMode: "weekly" }
        ],
        CATEGORIES: {
            farming: { name: "Farming", color: "§a", icon: "☘" },
            mining: { name: "Mining", color: "§7", icon: "⛏" },
            building: { name: "Building", color: "§e", icon: "▧" },
            player_request: { name: "Player Request", color: "§b", icon: "" },
            other: { name: "Other", color: "§f", icon: "" }
        }
    },

    LAND: {
        COLLECTION: "land",
        ENABLED: true,
        BASE_PRICE_CENTS: 500000,
        SELL_REFUND_RATIO: 0.60,
        RENT_PRICE_PER_DAY_CENTS: 35000,
        MIN_CLAIM_Y: 50,
        MAX_CLAIM_Y: 120,
        SPAWN_PROTECTION_RADIUS_CHUNKS: 10,
        MAX_CLAIMS_DEFAULT: 4,
        MAX_CLAIMS_VIP: 10,
        VIP_TAG: "vip",
        TAX_PER_CHUNK_PER_DAY_CENTS: 5000,
        TAX_PERIOD_HOURS: 24,
        TAX_GRACE_DAYS: 7,
        TAX_ACCRUAL_INTERVAL_TICKS: 1200,
        TAX_BATCH_SIZE: 250,
        DEFAULT_ENTRY_TAX_CENTS: 1000,
        ENTRY_TAX_COOLDOWN_MS: 3600000,
        ENTRY_CHECK_INTERVAL_TICKS: 20,
        CLAIM_PREVIEW_DURATION_MS: 60000,
        CLAIM_PREVIEW_MARKER_BLOCK: "minecraft:white_banner",
        PROTECTION: {
            BREAK: true,
            PLACE: true,
            INTERACT: true,
            CONTAINERS: true,
            PVP: true,
            FIRE_LIQUID: true,
            REDSTONE: true,
            EXPLOSIONS: true,
            PISTONS: true
        },
        DEFAULT_FLAGS: {
            entry: "public",
            break: "owner_trusted",
            place: "owner_trusted",
            interact: "public",
            containers: "owner_trusted",
            pvp: false,
            explosions: false,
            pistons: false,
            fire: false,
            liquids: false,
            redstone: false,
            entryTaxCents: 1000
        },
        ROLES: {
            visitor: { build: false, interact: false, containers: false, manage: false },
            builder: { build: true, interact: true, containers: false, manage: false },
            container: { build: false, interact: true, containers: true, manage: false },
            manager: { build: true, interact: true, containers: true, manage: true },
            coowner: { build: true, interact: true, containers: true, manage: true }
        }
    },

    MARKET: {
        COLLECTION: "market",
        SEED_DEFAULT_ITEMS: false,
        DEFAULTS: {
            SELL_RATIO: 0.70,
            DAILY_BUY_LIMIT: 128,
            DAILY_SELL_LIMIT: 128,
            TARGET_STOCK: 512,
            INITIAL_STOCK: 256
        },
        PRICE: {
            DYNAMIC_ENABLED: true,
            MIN_MULTIPLIER: 0.65,
            MAX_MULTIPLIER: 1.75,
            ELASTICITY: 0.35,
            MAX_CHANGE_PER_UPDATE: 0.10,
            HISTORY_LIMIT: 48
        },
        TAX: {
            ENABLED: true,
            SELL_TAX_RATE: 0.08,
            BUY_TAX_RATE: 0.00,
            TAX_DESTINATION: "burn",
            TAX_TREASURY_RATIO: 0.50
        },
        FEE: {
            ENABLED: true,
            BUY_FEE_RATE: 0.02,
            SELL_FEE_RATE: 0.02,
            SEND_TO_TREASURY: true
        },
        LIMITS: {
            ENABLED: true,
            RESET_HOURS: 24,
            MAX_TRANSACTION_AMOUNT: 256
        },
        ORDERS: {
            ENABLED: true,
            MAX_ACTIVE_PER_PLAYER: 5,
            MAX_ORDER_AMOUNT: 256,
            EXPIRE_DAYS: 7,
            MAX_ORDERS_PER_ITEM_SIDE: 100,
            ALLOW_PARTIAL_FILL: true
        },
        MAILBOX: {
            MAX_ENTRIES_PER_PLAYER: 50
        },
        UI: {
            ITEMS_PER_PAGE: 8,
            ORDERS_PER_PAGE: 8
        },
        DEFAULT_CATEGORIES: []
    },

    FINANCE: {
        COLLECTION: "finance",
        MAX_TRANSACTIONS: 5000, // legacy compatibility; canonical history uses MAX_LEDGER_HISTORY
        MAX_LEDGER_HISTORY: 1500,
        MAX_PAYOUTS_PER_PLAYER: 100, // warning threshold only; never an economic trim cap
        PAYOUT_SHARD_SOFT_LIMIT_BYTES: 850000,
        CLAIM_BATCH_SIZE: 50,
        LEDGER_MIGRATION_BATCH_SIZE: 5,
        AUTO_CLAIM_ON_JOIN: false,
        DIRECT_PAY_ONLINE: false
    },

    OPERATION_JOURNAL: {
        CATALOG_COLLECTION: "operation_journal_catalog",
        BASE: "operation_journals",
        SHARD_COUNT: 8,
        RECOVERY_INTERVAL_TICKS: 100,
        RECOVERY_BATCH_SIZE: 25,
        MAX_ATTEMPTS: 8,
        RETRY_BASE_MS: 5000,
        RETRY_MAX_MS: 600000,
        TERMINAL_RETENTION_DAYS: 30,
        SOFT_SHARD_LIMIT_BYTES: 850000,
        MAX_PAYLOAD_BYTES: 16000,
        PRUNE_BATCH_SIZE: 25
    },

    NOTIFICATIONS: {
        COLLECTION: "notifications",
        MAX_PER_PLAYER: 100,
        MAX_SYSTEM_EVENTS: 500,
        BADGES_ENABLED: true
    },

    DASHBOARD: {
        ENABLED: true,
        COLLECTION: "dashboard",
        ITEM_ID: "minecraft:paper",
        ITEM_NAME: "menu",
        ITEM_DISPLAY_NAME: "§6§lMCity Menu",
        GIVEN_PROPERTY: "mcity2_dashboard_given",
        GIVE_ON_FIRST_JOIN: true,
        OPEN_COOLDOWN_MS: 700,
        NOTIFICATION_BADGES_ENABLED: true
    },

    UI: {
        ITEMS_PER_PAGE: 8,
        LONG_LIST_PAGE_SIZE: 10,
        CONFIRM_DANGER_COLOR: "§c",
        BACK_LABEL: "§8⬅ Back",
        CLOSE_LABEL: "§c Close"
    },

    SCALABILITY: {
        PRUNE_INTERVAL_TICKS: 12000,
        CONTRACT_COMPLETED_RETENTION_DAYS: 14,
        CONTRACT_EXPIRED_RETENTION_DAYS: 7,
        MARKET_CLOSED_ORDER_RETENTION_DAYS: 7,
        FINANCE_TRANSACTION_PRUNE_MULTIPLIER: 1.2,
        NOTIFICATION_READ_RETENTION_DAYS: 14,
        LAND_ENTRY_PASS_PRUNE_BATCH: 500,
        LARGE_COLLECTION_WARNING_BYTES: 750000
    },

    DEBUG: {
        ENABLED: false,
        LOG_LEVEL: "info",
        LOG_STARTUP_REPORT: true
    },

    // Phase 4 Scalability: Rate limits to prevent click spam and abuse.
    // Each entry: [max, windowMs]. Set to null to disable.
    RATE_LIMITS: {
        MONEY_TRANSFER: [10, 60_000],          // 10 transfers per minute per player
        MONEY_SET: [30, 60_000],                // 30 set operations per minute (admin)
        MARKET_BUY: [20, 60_000],               // 20 buys per minute per player
        MARKET_SELL: [20, 60_000],              // 20 sells per minute per player
        MARKET_ORDER_CREATE: [10, 60_000],      // 10 order creations per minute
        MARKET_ORDER_CANCEL: [10, 60_000],      // 10 cancels per minute
        ATM_EXCHANGE: [10, 60_000],             // 10 ATM exchanges per minute
        CONTRACT_CREATE: [5, 60_000],           // 5 contracts per minute
        CONTRACT_SUBMIT: [20, 60_000],          // 20 submissions per minute
        DASHBOARD_OPEN: [30, 60_000],           // 30 dashboard opens per minute
        AUDIT_GLOBAL: [500, 1_000]              // 500 audit events per second (anti-spam)
    }
};

export function validateConfig() {
    const errors = [];
    const warnings = [];

    if (!CONFIG.VERSION) errors.push("Missing CONFIG.VERSION");
    if (!CONFIG.SYSTEM_NAME) errors.push("Missing CONFIG.SYSTEM_NAME");
    if (!CONFIG.DASHBOARD.ITEM_ID) errors.push("Missing dashboard item id");
    if (!CONFIG.DATABASE.PREFIX || typeof CONFIG.DATABASE.PREFIX !== "string") errors.push("Invalid database prefix");
    if (!Array.isArray(CONFIG.LEVEL.LEVELS) || CONFIG.LEVEL.LEVELS.length === 0) errors.push("No levels configured.");
    if (CONFIG.MONEY.MAX_MONEY_CENTS <= 0) errors.push("Invalid max money.");
    if (CONFIG.ATM.MAX_ACTIVE_ATMS <= 0) errors.push("Invalid ATM active limit.");
    if (CONFIG.CONTRACTS.MAX_ACTIVE_CREATED_PER_PLAYER <= 0) errors.push("Invalid contract created limit.");
    if (CONFIG.LAND.BASE_PRICE_CENTS < 0) errors.push("Invalid land base price.");
    if (CONFIG.LAND.MIN_CLAIM_Y > CONFIG.LAND.MAX_CLAIM_Y) errors.push("Invalid land Y range.");
    if (CONFIG.MARKET.ORDERS.MAX_ACTIVE_PER_PLAYER <= 0) errors.push("Invalid market order limit.");
    if (CONFIG.FINANCE.MAX_PAYOUTS_PER_PLAYER <= 0) errors.push("Invalid finance payout limit.");
    if (CONFIG.NOTIFICATIONS.MAX_PER_PLAYER <= 0) errors.push("Invalid notification limit.");
    if (CONFIG.DATABASE.DYNAMIC_PROPERTY_CHUNK_SIZE < 1024) warnings.push("Dynamic property chunk size is very small.");
    if ((CONFIG.DATABASE.SHARDING?.PLAYER_SHARD_COUNT || 1) < 1) errors.push("Invalid shard player count.");
    if ((CONFIG.DATABASE.SHARDING?.ITEM_SHARD_COUNT || 1) < 1) errors.push("Invalid shard item count.");
    if (CONFIG.COMMANDS.ENABLE_PUBLIC_COMMANDS) warnings.push("Public commands are enabled, but Dashboard V2 is designed commandless.");
    
    // Phase 4 Stability: Additional safety checks
    if (CONFIG.DATABASE.SAVE_INTERVAL_TICKS < 1200) warnings.push("Save interval is very aggressive (< 1 minute). May cause lag.");
    if (CONFIG.LAND.TAX_ACCRUAL_INTERVAL_TICKS < 600) warnings.push("Tax accrual interval is very aggressive (< 30 seconds).");
    if ((CONFIG.LAND.TAX_PERIOD_HOURS || 24) <= 0) errors.push("Invalid land tax period hours.");
    if (CONFIG.MARKET.PRICE.MAX_CHANGE_PER_UPDATE > 0.25) warnings.push("Market price max change per update is very high. Volatility may be extreme.");
    if (CONFIG.MONEY.MAX_MONEY_CENTS > 1_000_000_000) warnings.push("Max money is extremely high. Scoreboard overflow risk.");
    if (!CONFIG.DEBUG.ENABLED && CONFIG.DEBUG.LOG_LEVEL === "debug") warnings.push("Debug log level is set to 'debug' but DEBUG.ENABLED is false.");

    return { valid: errors.length === 0, errors, warnings };
}

function deepFreeze(obj) {
    for (const key of Object.keys(obj)) {
        const value = obj[key];
        if (value && typeof value === "object" && !Object.isFrozen(value)) deepFreeze(value);
    }
    return Object.freeze(obj);
}

deepFreeze(CONFIG);

const validation = validateConfig();
if (!validation.valid) {
    console.error("§6[MCity Config] §cConfiguration errors:");
    for (const err of validation.errors) console.error(`§c  • ${err}`);
} else if (validation.warnings.length) {
    console.warn("§6[MCity Config] §eConfiguration warnings:");
    for (const warn of validation.warnings) console.warn(`§e  • ${warn}`);
} else {
    console.log("§6[MCity Config] §aConfiguration validated successfully");
}

export default CONFIG;
