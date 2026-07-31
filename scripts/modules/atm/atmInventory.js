// MCity Dashboard V2 - ATM Inventory Helpers

import { ItemStack } from "@minecraft/server";
import { CONFIG } from "../../config.js";

const ORES = [...new Set(Object.values(CONFIG.ATM.ORE_COMBINATIONS).flat())];

export class ATMInventory {
    static getContainerFromPlayer(player) { try { return player.getComponent("minecraft:inventory")?.container || null; } catch { return null; } }
    static getContainerFromBlock(block) { try { return block.getComponent("minecraft:inventory")?.container || null; } catch { return null; } }

    static oreCounts(player) {
        const c = this.getContainerFromPlayer(player);
        const counts = Object.fromEntries(ORES.map(id => [id, 0]));
        if (!c) return counts;
        for (let i = 0; i < c.size; i++) { const it = c.getItem(i); if (it && counts[it.typeId] !== undefined) counts[it.typeId] += it.amount || 0; }
        return counts;
    }

    static count(player, itemId) { return this.oreCounts(player)[itemId] || 0; }

    static prepareItems(comboKey, amount) {
        const ores = CONFIG.ATM.ORE_COMBINATIONS[comboKey] || [];
        const out = {};
        for (const id of ores) out[id] = (out[id] || 0) + amount;
        return out;
    }

    static hasItems(player, items) {
        const counts = this.oreCounts(player);
        for (const [id, amount] of Object.entries(items || {})) if ((counts[id] || 0) < amount) return false;
        return true;
    }

    static removeItems(player, items) {
        const c = this.getContainerFromPlayer(player); if (!c) return false;
        const need = {}; for (const [id, n] of Object.entries(items || {})) need[id] = Math.max(0, Math.floor(n || 0));
        if (!this.hasItems(player, need)) return false;
        for (let i = 0; i < c.size; i++) {
            const it = c.getItem(i); if (!it || !need[it.typeId]) continue;
            const take = Math.min(it.amount, need[it.typeId]); need[it.typeId] -= take;
            if (take >= it.amount) c.setItem(i, undefined); else { it.amount -= take; c.setItem(i, it); }
        }
        return Object.values(need).every(v => v === 0);
    }

    static hasSpace(container, items) {
        if (!container) return false;
        const need = {}; for (const [id, n] of Object.entries(items || {})) { const v = Math.max(0, Math.floor(n || 0)); if (v) need[id] = v; }
        const max = 64; let empty = 0; const space = {};
        for (let i = 0; i < container.size; i++) {
            const it = container.getItem(i);
            if (!it) { empty++; continue; }
            if (need[it.typeId] && it.amount < max) space[it.typeId] = (space[it.typeId] || 0) + (max - it.amount);
        }
        let required = 0;
        for (const [id, amount] of Object.entries(need)) required += Math.ceil(Math.max(0, amount - (space[id] || 0)) / max);
        return required <= empty;
    }

    static addItems(container, items) {
        if (!this.hasSpace(container, items)) return false;
        const rem = {}; for (const [id, n] of Object.entries(items || {})) rem[id] = Math.max(0, Math.floor(n || 0));
        const max = 64;
        for (let i = 0; i < container.size; i++) {
            const it = container.getItem(i); if (!it || !rem[it.typeId] || it.amount >= max) continue;
            const add = Math.min(max - it.amount, rem[it.typeId]); it.amount += add; rem[it.typeId] -= add; container.setItem(i, it);
        }
        for (let i = 0; i < container.size; i++) {
            if (container.getItem(i)) continue;
            const entry = Object.entries(rem).find(([, n]) => n > 0); if (!entry) break;
            const [id, amount] = entry; const add = Math.min(max, amount); container.setItem(i, new ItemStack(id, add)); rem[id] -= add;
        }
        return Object.values(rem).every(v => v === 0);
    }

    static returnItems(player, items) { const c = this.getContainerFromPlayer(player); return c ? this.addItems(c, items) : false; }

    /**
     * Phase 1 Fix: Remove items from a container (e.g., a source chest).
     *
     * Previously, ATMService.exchange had no way to "undo" an `addItems`
     * call to a source chest. If `addMoney` failed after `addItems`
     * succeeded, the items were stuck in the source chest with no recovery
     * path. This helper mirrors `removeItems` but operates on any
     * container (not just a player inventory), enabling journal-based
     * recovery in ATMService.exchange.
     *
     * Returns true if all items were removed; false otherwise (e.g.,
     * container changed, items moved by another player).
     */
    static removeFromContainer(container, items) {
        if (!container) return false;
        const need = {}; for (const [id, n] of Object.entries(items || {})) need[id] = Math.max(0, Math.floor(n || 0));
        // First pass: verify all items are present in sufficient quantity.
        const available = {};
        for (let i = 0; i < container.size; i++) {
            const it = container.getItem(i); if (!it) continue;
            if (need[it.typeId]) available[it.typeId] = (available[it.typeId] || 0) + (it.amount || 0);
        }
        for (const [id, n] of Object.entries(need)) {
            if ((available[id] || 0) < n) return false;
        }
        // Second pass: actually remove.
        for (let i = 0; i < container.size; i++) {
            const it = container.getItem(i); if (!it || !need[it.typeId]) continue;
            const take = Math.min(it.amount, need[it.typeId]); need[it.typeId] -= take;
            if (take >= it.amount) container.setItem(i, undefined); else { it.amount -= take; container.setItem(i, it); }
        }
        return Object.values(need).every(v => v === 0);
    }
}

export default ATMInventory;
