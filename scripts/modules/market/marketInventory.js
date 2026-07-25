// MCity Dashboard V2 - Market Inventory Helpers
// Phase 7.7 (v1.0.0) (P7): Cache maxStack per itemId to avoid repeated
//                     `new ItemStack(itemId, 1)` allocations (native FFI).

import { ItemStack } from "@minecraft/server";
import { Logger } from "../../core/logger.js";

export class MarketInventory {
    // Phase 7.7 (v1.0.0) (P7): Cache of max stack sizes per itemId.
    // `new ItemStack(itemId, 1)` is a native FFI call that's expensive
    // when called repeatedly (e.g., in hasSpace/add loops). We cache
    // the result so each itemId is only queried once per session.
    static #maxStackCache = new Map();

    static getContainer(player) {
        try { return player.getComponent("minecraft:inventory")?.container || null; } catch (error) {
            Logger.debug("MarketInventory", `getContainer failed for ${player?.name || "unknown"}`, error);
            return null;
        }
    }

    /**
     * Phase 7.7 (v1.0.0) (P7): Get the max stack size for an item, with caching.
     * Falls back to 64 if the item can't be created (invalid itemId, etc.).
     */
    static #maxStackFor(itemId) {
        const cached = this.#maxStackCache.get(itemId);
        if (cached !== undefined) return cached;
        let max = 64;
        try {
            const sample = new ItemStack(itemId, 1);
            max = sample.maxAmount || 64;
        } catch {
            max = 64;
        }
        this.#maxStackCache.set(itemId, max);
        return max;
    }

    static isFungibleStack(item) {
        if (!item) return false;
        if (item.nameTag) return false;
        try { if ((item.getLore?.() || []).length) return false; } catch { return false; }
        try { if ((item.getComponent?.("minecraft:enchantable")?.getEnchantments?.() || []).length) return false; } catch {}
        try { const d = item.getComponent?.("minecraft:durability"); if (d && Number(d.damage || 0) > 0) return false; } catch {}
        return true;
    }

    static canReserveFungible(player, itemId, amount) {
        const c = this.getContainer(player); if (!c) return { ok: false, available: 0 };
        let available = 0;
        for (let i = 0; i < c.size; i++) {
            const item = c.getItem(i); if (item?.typeId !== itemId) continue;
            if (!this.isFungibleStack(item)) continue;
            available += item.amount || 0; if (available >= amount) return { ok: true, available };
        }
        return { ok: false, available };
    }

    static count(player, itemId) {
        const c = this.getContainer(player); if (!c) return 0;
        let n = 0;
        for (let i = 0; i < c.size; i++) {
            const it = c.getItem(i);
            if (it?.typeId === itemId) n += it.amount || 0;
        }
        return n;
    }

    static hasSpace(player, itemId, amount) {
        const c = this.getContainer(player); if (!c) return false;
        // Phase 7.7 (v1.0.0) (P7): Use cached maxStack instead of creating
        // a new ItemStack on every call.
        const maxStack = this.#maxStackFor(itemId);
        let space = 0;
        for (let i = 0; i < c.size; i++) {
            const it = c.getItem(i);
            if (!it) space += maxStack;
            else if (it.typeId === itemId && it.amount < maxStack) space += maxStack - it.amount;
            if (space >= amount) return true;
        }
        return false;
    }

    static deliveryToken(operationId) { return `mcity:market_delivery:${String(operationId).substring(0, 100)}`; }

    static addTagged(player, itemId, amount, operationId) {
        const c = this.getContainer(player); if (!c) return { success: false, added: 0, remaining: amount };
        const max = this.#maxStackFor(itemId), token = this.deliveryToken(operationId); let rem=Math.max(0,Math.floor(amount||0)),added=0;
        for(let i=0;i<c.size&&rem>0;i++){if(c.getItem(i))continue;const n=Math.min(max,rem),stack=new ItemStack(itemId,n);try{stack.setLore([token]);}catch{}c.setItem(i,stack);rem-=n;added+=n;}
        return { success: rem===0, added, remaining: rem, token };
    }

    static tokenAmount(player, operationId) { const c=this.getContainer(player);if(!c)return 0;const token=this.deliveryToken(operationId);let total=0;for(let i=0;i<c.size;i++){const item=c.getItem(i);try{if((item?.getLore?.()||[]).includes(token))total+=item.amount||0;}catch{}}return total; }
    static clearDeliveryToken(player, operationId) { const c=this.getContainer(player);if(!c)return 0;const token=this.deliveryToken(operationId);let total=0;for(let i=0;i<c.size;i++){const item=c.getItem(i);try{if((item?.getLore?.()||[]).includes(token)){total+=item.amount||0;item.setLore([]);c.setItem(i,item);}}catch{}}return total; }

    static add(player, itemId, amount) {
        const c = this.getContainer(player);
        if (!c) return { success: false, added: 0, remaining: amount };
        // Phase 7.7 (v1.0.0) (P7): Use cached maxStack.
        const maxStack = this.#maxStackFor(itemId);
        let rem = Math.max(0, Math.floor(amount || 0));
        let added = 0;
        // Phase 7.7 (v1.0.0): Combined the two passes (fill partials, then
        // empty slots) into a single pass by tracking the first empty slot.
        let firstEmpty = -1;
        for (let i = 0; i < c.size && rem > 0; i++) {
            const it = c.getItem(i);
            if (it?.typeId === itemId && it.amount < maxStack) {
                const add = Math.min(maxStack - it.amount, rem);
                it.amount += add;
                c.setItem(i, it);
                rem -= add;
                added += add;
            } else if (!it && firstEmpty === -1) {
                firstEmpty = i;
            }
        }
        // Fill empty slots starting from the first one found.
        for (let i = firstEmpty; i >= 0 && i < c.size && rem > 0; i++) {
            const it = c.getItem(i);
            if (!it) {
                const add = Math.min(maxStack, rem);
                c.setItem(i, new ItemStack(itemId, add));
                rem -= add;
                added += add;
            }
        }
        return { success: rem === 0, added, remaining: rem };
    }

    static remove(player, itemId, amount) {
        const c = this.getContainer(player);
        if (!c) return { success: false, removed: 0, remaining: amount };
        let rem = Math.max(0, Math.floor(amount || 0));
        let removed = 0;
        for (let i = 0; i < c.size && rem > 0; i++) {
            const it = c.getItem(i);
            if (it?.typeId !== itemId || !this.isFungibleStack(it)) continue;
            const take = Math.min(it.amount, rem);
            rem -= take;
            removed += take;
            if (take >= it.amount) c.setItem(i, undefined);
            else { it.amount -= take; c.setItem(i, it); }
        }
        return { success: rem === 0, removed, remaining: rem };
    }
}

export default MarketInventory;
