// MCity Dashboard V2 - Notifications Service + UI
// Phase 5 Polish: Sanitize notification titles and messages.
// Sharding Phase 2 (v1.9.1): Player notifications are stored in player hash shards.

import { ActionFormData } from "@minecraft/server-ui";
import { CONFIG } from "../config.js";
import { UI } from "../core/uiTheme.js";
import { Database } from "../core/database.js";
import { Logger } from "../core/logger.js";
import { Sanitizer } from "../core/sanitizer.js";
import { ShardUtils } from "../core/shardUtils.js";
import { DEFAULT_NOTIFICATION_DB, validateNotificationData } from "../schemas/notificationSchema.js";
import { DisposableRegistry } from "../core/disposableRegistry.js";

const NC = CONFIG.NOTIFICATIONS;
const COLLECTION = NC.COLLECTION;

function noteId() { return `note_${Date.now()}_${Math.floor(Math.random() * 1000000)}`; }

export class NotificationService {
    static #initialized = false;

    static initialize() {
        if (this.#initialized) return;
        this.#initialized = true;
        this.db();
        this.#migratePlayersToShards();
        DisposableRegistry.registerShutdownCleanup("NotificationService.lifecycle", () => { this.#initialized = false; });
        Logger.startup("Notifications", `Notification service initialized (player shards=${this.#shardCount()})`);
    }

    static db() {
        return Database.collection(COLLECTION, DEFAULT_NOTIFICATION_DB, { validate: validateNotificationData });
    }
    static #shardConfig() { return CONFIG.DATABASE?.SHARDING?.MODULES?.NOTIFICATIONS || {}; }
    static #shardingEnabled() { return !!this.#shardConfig().ENABLED; }
    static #shardCount() { return Math.max(1, Math.floor(Number(this.#shardConfig().SHARD_COUNT || CONFIG.DATABASE?.SHARDING?.PLAYER_SHARD_COUNT || 1))); }
    static collectionFor(playerId) { return this.#shardingEnabled() ? ShardUtils.playerShardName(COLLECTION, playerId, this.#shardCount()) : COLLECTION; }
    static dbFor(playerId) { return Database.collection(this.collectionFor(playerId), DEFAULT_NOTIFICATION_DB, { validate: validateNotificationData }); }

    static #migratePlayersToShards() {
        if (!this.#shardingEnabled()) return { migrated: 0, skipped: "disabled" };
        const base = this.db();
        const players = base.players || {};
        const ids = Object.keys(players);
        if (!ids.length) { base.shardEnabled = true; base.shardCount = this.#shardCount(); return { migrated: 0 }; }
        let migrated = 0;
        for (const pid of ids) {
            const shard = this.dbFor(pid);
            shard.players[pid] = players[pid];
            shard.stats.totalCreated = (shard.stats.totalCreated || 0) + players[pid].length;
            shard.stats.lastCreatedAt = Math.max(shard.stats.lastCreatedAt || 0, ...players[pid].map(n => n.createdAt || 0));
            Database.markDirty(this.collectionFor(pid));
            migrated++;
        }
        base.players = {};
        base.shardEnabled = true;
        base.shardCount = this.#shardCount();
        Database.markDirty(COLLECTION);
        Logger.startup("Notifications", `Migrated ${migrated} player notification list(s) to ${this.#shardCount()} shard(s)`);
        return { migrated };
    }


    static create(playerId, { type = "info", source = "system", title = "Notification", message = "", action = "", meta = {} } = {}) {
        if (!playerId) return null;
        const note = {
            id: noteId(),
            type: Sanitizer.sanitizeKey(type, 32),
            source: Sanitizer.sanitizeKey(source, 64),
            title: Sanitizer.sanitizeText(title, 80),
            message: Sanitizer.sanitizeMessage(message, 260),
            action: Sanitizer.sanitizeText(action, 64),
            read: false,
            createdAt: Date.now(),
            meta: this.#safeMeta(meta)
        };
        const tx = Database.transaction(this.collectionFor(playerId), data => {
            if (!data.players[playerId]) data.players[playerId] = [];
            data.players[playerId].push(note);
            data.players[playerId] = data.players[playerId].slice(-NC.MAX_PER_PLAYER);
            data.stats.totalCreated = (data.stats.totalCreated || 0) + 1;
            data.stats.lastCreatedAt = note.createdAt;
            return note;
        });
        if (!tx.success) Logger.warn("Notifications", `Failed to create notification for ${playerId}: ${tx.error}`);
        return tx.success ? tx.result : null;
    }

    static systemEvent({ type = "system", source = "system", title = "System Event", message = "", meta = {} } = {}) {
        // Phase 7.5 (v0.22.0) (DB10): systemEvent previously skipped the
        // sanitization that `create()` applies. While `systemEvent` is
        // "trusted" by contract, any caller (current or future) that passes
        // user-controllable strings would get §-color-code injection into
        // the persisted DB. The schema validator also strips color codes
        // now (defense-in-depth), but applying Sanitizer here ensures the
        // in-memory state is clean too.
        const note = {
            id: noteId(),
            type: Sanitizer.sanitizeKey(type, 32),
            source: Sanitizer.sanitizeKey(source, 64),
            title: Sanitizer.sanitizeText(title, 80),
            message: Sanitizer.sanitizeMessage(message, 260),
            action: "",
            read: false,
            createdAt: Date.now(),
            meta: this.#safeMeta(meta)
        };
        const tx = Database.transaction(COLLECTION, data => {
            data.systemEvents.push(note);
            data.systemEvents = data.systemEvents.slice(-NC.MAX_SYSTEM_EVENTS);
            data.stats.totalCreated = (data.stats.totalCreated || 0) + 1;
            data.stats.lastCreatedAt = note.createdAt;
            return note;
        });
        return tx.success ? tx.result : null;
    }

    static list(playerId, { unreadOnly = false, limit = 100 } = {}) {
        const arr = [...(this.dbFor(playerId).players[playerId] || [])];
        const filtered = unreadOnly ? arr.filter(n => !n.read) : arr;
        return filtered.slice(-Math.max(1, Math.min(200, limit))).reverse();
    }

    static unreadCount(playerId) {
        return (this.dbFor(playerId).players[playerId] || []).filter(n => !n.read).length;
    }

    static stats(playerId) {
        const arr = this.dbFor(playerId).players[playerId] || [];
        return { total: arr.length, unread: arr.filter(n => !n.read).length };
    }

    static markRead(playerId, noteIdValue) {
        const tx = Database.transaction(this.collectionFor(playerId), data => {
            const list = data.players[playerId] || [];
            let changed = 0;
            for (const n of list) {
                if (n.id === noteIdValue && !n.read) { n.read = true; changed++; }
            }
            data.stats.totalRead = (data.stats.totalRead || 0) + changed;
            return changed;
        });
        return tx.success ? tx.result : 0;
    }

    static markAllRead(playerId) {
        const tx = Database.transaction(this.collectionFor(playerId), data => {
            const list = data.players[playerId] || [];
            let changed = 0;
            for (const n of list) if (!n.read) { n.read = true; changed++; }
            data.stats.totalRead = (data.stats.totalRead || 0) + changed;
            return changed;
        });
        return tx.success ? tx.result : 0;
    }

    static clearRead(playerId) {
        const tx = Database.transaction(this.collectionFor(playerId), data => {
            const list = data.players[playerId] || [];
            const next = list.filter(n => !n.read);
            data.players[playerId] = next;
            if (!next.length) delete data.players[playerId];
            return list.length - next.length;
        });
        return tx.success ? tx.result : 0;
    }

    static #safeMeta(meta) {
        try {
            const json = JSON.stringify(meta || {});
            if (json.length > 800) return { truncated: true, preview: json.slice(0, 800) };
            return JSON.parse(json);
        } catch { return {}; }
    }
}

export class DashboardNotifications {
    static summary(player) {
        const count = NotificationService.unreadCount(player.id);
        return count ? `§7Notifications: §e${count} unread` : null;
    }

    static badge(player) {
        const count = NotificationService.unreadCount(player.id);
        return count ? `${count} unread` : "";
    }

    static async open(player, page = 0) {
        const all = NotificationService.list(player.id, { limit: 100 });
        const unread = all.filter(n => !n.read).length;
        const per = CONFIG.UI.ITEMS_PER_PAGE || 8;
        const totalPages = Math.max(1, Math.ceil(all.length / per));
        page = Math.max(0, Math.min(page, totalPages - 1));
        const slice = all.slice(page * per, page * per + per);
        const form = new ActionFormData()
            .title(UI.title(UI.ICON.notification, "Notifications"))
            .body(UI.body(
                `§7Stored: §f${all.length}`,
                `§7Unread: §e${unread}`,
                `§7Page: §f${page + 1}/${totalPages}`
            ));
        const actions = [];
        if (unread > 0) { form.button("§aMark All Read"); actions.push({ type: "markAll" }); }
        for (const note of slice) {
            form.button(`${note.read ? "§f" : "§e! "}${note.title}\n§f${note.source} §e| §f${new Date(note.createdAt).toLocaleTimeString()}`);
            actions.push({ type: "view", note });
        }
        if (page < totalPages - 1) { form.button(UI.NEXT); actions.push({ type: "next" }); }
        if (page > 0) { form.button(UI.PREV); actions.push({ type: "prev" }); }
        if (all.length) { form.button("§eClear Read Notifications"); actions.push({ type: "clearRead" }); }
        form.button(UI.BACK); actions.push({ type: "back" });

        const result = await form.show(player);
        if (result.canceled) return;
        const action = actions[result.selection];
        if (!action || action.type === "back") return this.#back(player);
        if (action.type === "next") return this.open(player, page + 1);
        if (action.type === "prev") return this.open(player, page - 1);
        if (action.type === "markAll") { NotificationService.markAllRead(player.id); return this.open(player, page); }
        if (action.type === "clearRead") { NotificationService.clearRead(player.id); return this.open(player, page); }
        if (action.type === "view") return this.details(player, action.note, page);
    }

    static async details(player, note, page = 0) {
        if (!note.read) NotificationService.markRead(player.id, note.id);
        await new ActionFormData()
            .title(UI.title(UI.ICON.notification, note.title))
            .body(UI.body(
                UI.kv("Type", note.type),
                UI.kv("Source", note.source),
                UI.kv("Created", new Date(note.createdAt).toLocaleString()),
                "",
                `§f${note.message || "-"}`,
                note.action ? `\n§bAction: §e${note.action}` : ""
            ))
            .button(UI.BACK)
            .show(player);
        return this.open(player, page);
    }

    static #back(player) {
        return import("./dashboardSystem.js").then(m => m.DashboardSystem.open(player));
    }
}

export default DashboardNotifications;
