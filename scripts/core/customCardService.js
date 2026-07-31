// MCity Dashboard V2 - Personal Card Identity Service
import { world } from "@minecraft/server";
import { CONFIG } from "../config.js";
import { Database } from "./database.js";
import { Logger } from "./logger.js";
import { DisposableRegistry } from "./disposableRegistry.js";
import { BedrockCompat } from "./bedrockCompat.js";
import { CustomItemRegistry } from "./customItemRegistry.js";
import { DEFAULT_CUSTOM_CARD_DB, validateCustomCardData } from "../schemas/customCardSchema.js";

const COLLECTION = "custom_cards";
const CARD_VERSION = 1;
const SIGNATURE_SALT = String(CONFIG.CUSTOM_ITEMS?.CARD_SIGNATURE_SALT || "mcity-card-v1");
const DYNAMIC = Object.freeze({ cardId: "mcity_card_id", ownerId: "mcity_card_owner_id", ownerName: "mcity_card_owner_name", color: "mcity_card_color", version: "mcity_card_version", signature: "mcity_card_signature" });

function now() { return Date.now(); }
function text(value, max = 128) { return String(value || "").replace(/[\u0000-\u001f\u007f]/g, "").slice(0, max); }
function hash(value) { let h = 2166136261; for (let i = 0; i < value.length; i++) { h ^= value.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return `mcity:${h.toString(16).padStart(8, "0")}`; }
function cardId(playerId) { return `card_${Date.now()}_${hash(`${playerId}:${Math.random()}`).slice(-8)}`; }

export class CustomCardService {
    static #initialized = false;
    static initialize() {
        if (this.#initialized) return;
        this.#initialized = true;
        this.db();
        BedrockCompat.subscribe("player.craft.after", "CustomCardService.cardCraft", event => this.#onCraft(event), { required: false });
        DisposableRegistry.registerShutdownCleanup("CustomCardService.lifecycle", () => { this.#initialized = false; });
        Logger.startup("CustomCard", "Personal card identity service initialized");
    }
    static shutdown() { this.#initialized = false; }
    static db() { return Database.collection(COLLECTION, DEFAULT_CUSTOM_CARD_DB, { validate: validateCustomCardData }); }
    static signature(card) { return hash(`${SIGNATURE_SALT}|${card.cardId}|${card.ownerId}|${card.color}|${card.version}`); }
    static #onCraft(event) {
        const player = event?.player;
        const stack = event?.itemStack;
        if (!player || !stack || !CustomItemRegistry.isPersonalCard(stack.typeId)) return;
        this.issue(player, stack, CustomItemRegistry.get(stack.typeId)?.color || "");
    }
    static issue(player, stack, color) {
        if (!player || !stack) return { success: false, message: "Invalid card owner." };
        const card = { cardId: cardId(player.id), ownerId: text(player.id), ownerName: text(player.name, 64), color: text(color, 24), version: CARD_VERSION, createdAt: now(), revoked: false, revokedAt: 0 };
        card.signature = this.signature(card);
        try {
            stack.setDynamicProperty(DYNAMIC.cardId, card.cardId); stack.setDynamicProperty(DYNAMIC.ownerId, card.ownerId); stack.setDynamicProperty(DYNAMIC.ownerName, card.ownerName); stack.setDynamicProperty(DYNAMIC.color, card.color); stack.setDynamicProperty(DYNAMIC.version, card.version); stack.setDynamicProperty(DYNAMIC.signature, card.signature);
        } catch (error) { Logger.warn("CustomCard", "Could not bind card dynamic properties", error); return { success: false, message: "Card binding failed." }; }
        const tx = Database.transaction(COLLECTION, data => { data.cards[card.cardId] = card; data.stats.issued = Object.keys(data.cards).length; data.stats.lastUpdated = now(); return card; });
        if (!tx.success) return { success: false, message: tx.error };
        Database.flushCritical(COLLECTION, "custom_card_issue");
        return { success: true, card };
    }
    static read(stack) {
        if (!stack || !CustomItemRegistry.isPersonalCard(stack.typeId)) return null;
        try { return { cardId: text(stack.getDynamicProperty(DYNAMIC.cardId)), ownerId: text(stack.getDynamicProperty(DYNAMIC.ownerId)), ownerName: text(stack.getDynamicProperty(DYNAMIC.ownerName), 64), color: text(stack.getDynamicProperty(DYNAMIC.color), 24), version: Number(stack.getDynamicProperty(DYNAMIC.version)) || 0, signature: text(stack.getDynamicProperty(DYNAMIC.signature), 64) }; } catch { return null; }
    }
    static validate(player, stack) {
        const card = this.read(stack); if (!card?.cardId || !card.ownerId || !card.signature) return { valid: false, reason: "unbound" };
        if (!player || card.ownerId !== player.id) return { valid: false, reason: "owner_mismatch", card };
        if (card.signature !== this.signature(card)) return { valid: false, reason: "bad_signature", card };
        const record = this.db().cards[card.cardId];
        if (!record || record.revoked) return { valid: false, reason: "revoked_or_unknown", card };
        return { valid: true, card, record };
    }
    static revoke(cardIdValue, actor = "system") {
        const id = text(cardIdValue, 96); const tx = Database.transaction(COLLECTION, data => { const card = data.cards[id]; if (!card) return false; card.revoked = true; card.revokedAt = now(); card.revokedBy = text(actor, 64); data.stats.revoked = (data.stats.revoked || 0) + 1; data.stats.lastUpdated = now(); return true; });
        if (tx.success) Database.flushCritical(COLLECTION, "custom_card_revoke");
        return { success: !!tx.success && !!tx.result };
    }
    static stats() { const db = this.db(); return { ...db.stats, active: Object.values(db.cards || {}).filter(card => !card.revoked).length }; }
}

export { DYNAMIC as CUSTOM_CARD_DYNAMIC_PROPERTIES };
export default CustomCardService;
