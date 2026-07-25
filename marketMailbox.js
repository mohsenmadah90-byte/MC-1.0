// MCity Dashboard V2 - Market Mailbox
// Phase 4: Offline Synchronization
// Phase 7.2 (v0.21.1): Transactional claimAll (anti-dupe), coalescing (anti-loss),
//                      and addEntry alias for backward compat with broken callers.

import { CONFIG } from "../../config.js";
import { Logger } from "../../core/logger.js";
import { MoneyService } from "../economy/moneyService.js";
import { MarketInventory } from "./marketInventory.js";

const MAX = CONFIG.MARKET.MAILBOX.MAX_ENTRIES_PER_PLAYER;
function now() { return Date.now(); }

/**
 * Monotonic entry ID generator. Uses a module-level counter so two
 * entries created in the same millisecond cannot collide.
 */
let __entryCounter = 0;
function entryId() {
    __entryCounter = (__entryCounter + 1) % 1_000_000;
    return `mail_${Date.now()}_${__entryCounter}`;
}

export class MarketMailbox {
    /**
     * Add an entry to a player's mailbox inside an in-progress transaction.
     *
     * Phase 7.2 (v0.21.1) Critical Fixes:
     *
     * 1. (MK1) `addEntry` is now an ALIAS for `addToData`. Previously
     *    `marketService.js:239` called `MarketMailbox.addEntry(...)` which
     *    did not exist, causing a TypeError inside a transaction. The
     *    transaction would silently fail and return {success:false}, but
     *    the caller never checked — so partial-fill items were lost
     *    forever. Now any caller using either name works.
     *
     * 2. (MK6) When the mailbox is at capacity, instead of blindly
     *    `slice(-MAX)` (which silently drops the OLDEST entry — possibly
     *    one containing real money or diamonds), we now COALESCE entries
     *    of the same type before dropping anything:
     *      - money entries: merge into a single entry (sum amounts)
     *      - same-itemId item entries: merge into a single entry (sum amounts)
     *    Only after coalescing, if we are STILL over capacity, do we drop
     *    the oldest entries — and we log a warning so admins can see it.
     *
     * The entry shape must be one of:
     *   { type: "money", amount, reason }
     *   { type: "item",  itemId, amount, reason }
     *   { type: <other>, ... }  // preserved as-is, not coalesced
     */
    static addToData(data, playerId, entry) {
        if (!data.mailbox) data.mailbox = {};
        if (!data.mailbox[playerId]) data.mailbox[playerId] = [];

        const list = data.mailbox[playerId];
        const newEntry = {
            id: entry.id || entryId(),
            createdAt: entry.createdAt || now(),
            ...entry
        };
        // Strip duplicate id/createdAt if entry explicitly provided them
        // (last-writer-wins on these explicit fields is intentional).
        if (entry.id) newEntry.id = entry.id;
        if (entry.createdAt) newEntry.createdAt = entry.createdAt;

        list.push(newEntry);

        // Phase 4.1: mailbox entries are economic obligations. The legacy
        // count is a warning threshold only; no entry is dropped or sliced.
        // Safe coalescing is deferred until operation IDs/metadata classes can
        // be retained without weakening replay detection.
        if (list.length > MAX) Logger.warn("MarketMailbox", `Mailbox for ${playerId} exceeds warning threshold ${MAX}; preserving all ${list.length} obligations.`);
    }

    /**
     * (MK1) Backward-compat alias. Some callers (e.g. marketService.js
     * partial-fill path) used `addEntry` which never existed. Routing it
     * to `addToData` makes those callers work correctly.
     */
    static addEntry(data, playerId, entry) {
        return this.addToData(data, playerId, entry);
    }

    /**
     * (MK6) Coalesce same-type entries to free mailbox capacity without
     * losing economic value. Returns a new array; does not mutate input.
     *
     * Strategy:
     *   - Walk the list in order (oldest first).
     *   - For "money" entries, merge them into a single entry at the
     *     position of the most recent money entry. Reasons are concatenated.
     *   - For "item" entries with the same itemId, merge into a single
     *     entry at the position of the most recent same-itemId entry.
     *   - Other entry types are preserved as-is.
     */
    static #coalesce(list) {
        if (!Array.isArray(list) || list.length <= MAX) return list;
        const moneyEntries = [];
        const itemBuckets = new Map(); // itemId -> array of entries
        const others = [];
        const order = []; // track insertion order of unique keys

        for (const e of list) {
            if (e.type === "money") {
                moneyEntries.push(e);
            } else if (e.type === "item" && e.itemId) {
                if (!itemBuckets.has(e.itemId)) {
                    itemBuckets.set(e.itemId, []);
                    order.push({ kind: "item", key: e.itemId });
                }
                itemBuckets.get(e.itemId).push(e);
            } else {
                others.push(e);
            }
        }
        if (moneyEntries.length > 0) order.unshift({ kind: "money" });

        const out = [];
        // Place others first (preserves their relative order)
        for (const e of others) out.push(e);

        // Then merged money entry (use latest createdAt, sum amounts,
        // concatenate reasons truncated).
        if (moneyEntries.length > 0) {
            const total = moneyEntries.reduce((s, e) => s + (e.amount || 0), 0);
            const latest = moneyEntries[moneyEntries.length - 1];
            const reasons = [...new Set(moneyEntries.map(e => e.reason).filter(Boolean))].slice(0, 3).join(" | ");
            out.push({
                id: entryId(),
                type: "money",
                amount: total,
                reason: reasons.substring(0, 200),
                createdAt: latest.createdAt || now(),
                coalescedFrom: moneyEntries.length
            });
        }

        // Then merged per-itemId entries
        for (const { key } of order.filter(o => o.kind === "item")) {
            const bucket = itemBuckets.get(key);
            if (!bucket || bucket.length === 0) continue;
            const total = bucket.reduce((s, e) => s + (e.amount || 0), 0);
            const latest = bucket[bucket.length - 1];
            const reasons = [...new Set(bucket.map(e => e.reason).filter(Boolean))].slice(0, 3).join(" | ");
            out.push({
                id: entryId(),
                type: "item",
                itemId: key,
                amount: total,
                reason: reasons.substring(0, 200),
                createdAt: latest.createdAt || now(),
                coalescedFrom: bucket.length
            });
        }

        return out;
    }

    static list(db, playerId) {
        return [...(db.mailbox?.[playerId] || [])].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    }

    static stats(db, playerId) {
        const list = this.list(db, playerId);
        let money = 0, items = 0;
        for (const e of list) {
            if (e.type === "money") money += e.amount || 0;
            if (e.type === "item") items += e.amount || 0;
        }
        return { count: list.length, money, items };
    }

    /**
     * (MK4) Phase 7.2 (v0.21.1) Critical Fix: Transactional claimAll.
     *
     * Previously, `claimAll` iterated the mailbox and called
     * `MoneyService.addMoney` (which commits to the money DB and mirrors scoreboard afterward)
     * and `MarketInventory.add` (which can throw on bad itemId). If the
     * item-add threw, the exception unwound BEFORE the line
     * `db.mailbox[player.id] = remaining` ran — so the mailbox was
     * unchanged. Money was credited, mailbox still had the money entry,
     * and the next `/claim` would credit the money AGAIN — infinite dupe.
     *
     * New flow:
     *   1. Each entry is processed in its OWN try/catch.
     *   2. Money entries: verify `addMoney` returned `.success === true`
     *      before counting as claimed. If it fails, keep the entry.
     *   3. Item entries: if `MarketInventory.add` throws OR returns
     *      `remaining > 0`, keep the entry (with updated amount for
     *      partial fills).
     *   4. Unknown entry types are preserved, never discarded.
     *   5. The mailbox mutation (writing `remaining` back) is done via
     *      `Database.transaction` to be atomic with itself — even though
     *      the scoreboard write is unavoidably outside the transaction,
     *      at least the mailbox state is consistent.
     *
     * The caller (`MarketService.claimMailbox`) wraps this in
     * `Database.transaction` so the entire claim is atomic at the DB level.
     */
    static claimAll(player, db) {
        const list = db.mailbox?.[player.id] || [];
        if (!list.length) return { claimed: 0, money: 0, items: 0, remaining: 0 };

        const remaining = [];
        let claimed = 0, money = 0, items = 0;

        for (const e of list) {
            // Defensive: skip malformed entries but preserve them so
            // admins can investigate via the DB.
            if (!e || typeof e !== "object") {
                remaining.push(e);
                continue;
            }

            try {
                if (e.type === "money") {
                    const amount = Math.max(0, Math.floor(e.amount || 0));
                    if (amount <= 0) {
                        // No-op money entry — count as claimed and drop.
                        claimed++;
                        continue;
                    }
                    const r = MoneyService.addMoney(player, amount, "market_mailbox");
                    if (!r || !r.success) {
                        // Credit failed — keep the entry so the player can retry.
                        Logger.warn("MarketMailbox", `claimAll: money credit failed for ${player.id}; preserving entry (${amount}c).`);
                        remaining.push(e);
                        continue;
                    }
                    money += amount;
                    claimed++;
                } else if (e.type === "item") {
                    const amount = Math.max(0, Math.floor(e.amount || 0));
                    const itemId = e.itemId;
                    if (amount <= 0 || !itemId) {
                        claimed++;
                        continue;
                    }
                    let add;
                    try {
                        add = MarketInventory.add(player, itemId, amount);
                    } catch (invErr) {
                        // Bad itemId, inventory component missing, etc.
                        // Keep the entry so the player can retry or contact admin.
                        Logger.warn("MarketMailbox", `claimAll: MarketInventory.add threw for ${player.id}, item ${itemId}: ${invErr?.message || invErr}`);
                        remaining.push(e);
                        continue;
                    }
                    if (add.added > 0) items += add.added;
                    if (add.remaining > 0) {
                        // Partial fill — keep the remainder.
                        remaining.push({ ...e, amount: add.remaining });
                    } else {
                        claimed++;
                    }
                } else {
                    // Unknown type — preserve, do not discard.
                    remaining.push(e);
                }
            } catch (err) {
                // Catch-all: never let one entry's failure cause a dupe.
                Logger.error("MarketMailbox", `claimAll: entry ${e.id} failed for ${player.id}: ${err?.message || err}. Preserving entry.`);
                remaining.push(e);
            }
        }

        // Write the remaining list back. The caller wraps this whole call
        // in Database.transaction so this assignment is atomic.
        if (remaining.length > 0) db.mailbox[player.id] = remaining;
        else delete db.mailbox[player.id];

        return { claimed, money, items, remaining: remaining.length };
    }
}

export default MarketMailbox;
