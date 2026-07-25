// MCity Dashboard V2 - Contract Inventory Helpers
// Phase 7.3 (v0.21.2): All-or-nothing remove (was partial-remove on failure,
//                     causing item loss when callers ignored the return value).

import { ItemStack } from "@minecraft/server";
import { Logger } from "../../core/logger.js";

export class ContractInventory {
    static #maxStackCache=new Map();
    static maxStack(itemId){if(this.#maxStackCache.has(itemId))return this.#maxStackCache.get(itemId);let max=64;try{max=new ItemStack(itemId,1).maxAmount||64;}catch{}this.#maxStackCache.set(itemId,max);return max;}
    static container(player) { try { return player.getComponent("minecraft:inventory")?.container || null; } catch { return null; } }
    static count(player, itemId) {
        const c = this.container(player); if (!c) return 0;
        let n = 0; for (let i=0;i<c.size;i++){ const it=c.getItem(i); if(it?.typeId===itemId)n+=it.amount||0; }
        return n;
    }

    /**
     * Phase 7.3 (v0.21.2) (CT6): All-or-nothing remove.
     *
     * Previously, `remove` returned `{success: rem===0, removed, remaining}`.
     * If `success` was false (partial removal — possible if items were moved
     * between the prior `count()` call and `remove()`, e.g., by the player
     * dropping during UI animation), the caller (`contractService.js:129`)
     * checked `!rem.success` and returned an error — but the `rem.removed`
     * items were already taken from the inventory and were NOT refunded.
     *
     * New behavior: if we cannot remove the full amount, we restore any
     * partially-removed items BEFORE returning. This way, a failed `remove`
     * leaves the inventory unchanged and the caller can safely abort.
     *
     * The return shape is unchanged for backward compat: `{success, removed, remaining}`.
     * On failure, `removed` is 0 and `remaining` equals the original `amount`.
     */
    static remove(player, itemId, amount) {
        const c=this.container(player);
        if(!c) return {success:false, removed:0, remaining:Math.max(0,Math.floor(amount||0))};

        const need = Math.max(0, Math.floor(amount||0));
        if (need === 0) return {success:true, removed:0, remaining:0};

        // Phase 7.3 (v0.21.2) (CT6): First pass — count available items.
        // If we don't have enough, abort without removing anything.
        let available = 0;
        for (let i = 0; i < c.size; i++) {
            const it = c.getItem(i);
            if (it?.typeId === itemId) available += it.amount || 0;
            if (available >= need) break;
        }
        if (available < need) {
            // Not enough items — do NOT remove anything.
            return {success:false, removed:0, remaining:need};
        }

        // Second pass — remove the items. Since we verified availability,
        // this should always succeed. If something goes wrong mid-removal
        // (shouldn't happen in a single-threaded JS runtime, but be safe),
        // we restore what we took.
        let rem = need, removed = 0;
        const taken = []; // {slot, item} for potential restore
        for (let i = 0; i < c.size && rem > 0; i++) {
            const it = c.getItem(i);
            if (it?.typeId !== itemId) continue;
            const take = Math.min(it.amount, rem);
            // Save a copy for restore if needed.
            taken.push({ slot: i, typeId: it.typeId, amount: take });
            rem -= take;
            removed += take;
            if (take >= it.amount) {
                c.setItem(i, undefined);
            } else {
                it.amount -= take;
                c.setItem(i, it);
            }
        }

        // Safety check: if we somehow didn't remove enough, restore.
        if (rem > 0) {
            Logger.warn("ContractInventory", `remove: partial removal after pre-check (need=${need}, removed=${removed}). Restoring.`);
            for (const t of taken) {
                const existing = c.getItem(t.slot);
                if (existing && existing.typeId === t.typeId) {
                    existing.amount += t.amount;
                    c.setItem(t.slot, existing);
                } else if (!existing) {
                    c.setItem(t.slot, new ItemStack(t.typeId, t.amount));
                }
                // If slot is occupied by something else, we lose the item —
                // but this is extremely unlikely in practice.
            }
            return {success:false, removed:0, remaining:need};
        }

        return {success:true, removed, remaining:0};
    }

    static add(player, itemId, amount) {
        const c=this.container(player); if(!c)return{success:false,added:0,remaining:amount};
        let rem=Math.max(0,Math.floor(amount||0)), added=0; const max=this.maxStack(itemId);
        for(let i=0;i<c.size&&rem>0;i++){ const it=c.getItem(i); if(it?.typeId===itemId&&it.amount<max){ const add=Math.min(max-it.amount,rem); it.amount+=add; c.setItem(i,it); rem-=add; added+=add; } }
        for(let i=0;i<c.size&&rem>0;i++){ const it=c.getItem(i); if(!it){ const add=Math.min(max,rem); c.setItem(i,new ItemStack(itemId,add)); rem-=add; added+=add; } }
        return {success:rem===0,added,remaining:rem};
    }
}

export default ContractInventory;
