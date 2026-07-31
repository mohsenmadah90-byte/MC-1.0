// MCity Dashboard V2 - Mine Phone battery, charger and flashlight state.
import { world, ItemStack, EquipmentSlot } from "@minecraft/server";
import { CustomItemRegistry } from "./customItemRegistry.js";
import { BedrockCompat } from "./bedrockCompat.js";
import { RuntimeHandleRegistry } from "./runtimeHandleRegistry.js";
import { DisposableRegistry } from "./disposableRegistry.js";

const BATTERY_KEY = "mcity_phone_battery";
const FLASHLIGHT_KEY = "mcity_phone_flashlight";
const LAST_KEY = "mcity_phone_last_active";
const CHARGE_KEY = "mcity_phone_charge_session";
const MAX_SECONDS = 20 * 60;
const CHARGE_SECONDS = 5 * 60;
const sessions = new Set();
const phoneVisuals = new Map();
let intervalId = null;
let animationPhase = 0;

function redstoneSource(block) {
    const id = String(block?.typeId || "");
    return id === "minecraft:redstone_block" || id === "minecraft:redstone_torch" || id === "minecraft:lit_redstone_torch" || id.includes("powered_repeater") || id.includes("powered_comparator") || id.includes("lever") || id.includes("button");
}
function chargerPowered(block) {
    if (redstoneSource(block)) return true;
    for (const offset of [{x:1,y:0,z:0},{x:-1,y:0,z:0},{x:0,y:1,z:0},{x:0,y:-1,z:0},{x:0,y:0,z:1},{x:0,y:0,z:-1}]) { try { if (redstoneSource(block?.offset(offset))) return true; } catch {} }
    return false;
}

export class MinePhoneService {
    static initialize() {
        if (intervalId !== null) return;
        intervalId = RuntimeHandleRegistry.interval("MinePhone.battery", () => this.tick(), 20);
        BedrockCompat.subscribe("item.use.before", "MinePhone.charger", event => this.tryStartCharging(event.source, event.itemStack));
        BedrockCompat.subscribe("item.use.before", "MinePhone.placeOnCharger", event => this.tryPlaceOnCharger(event.source, event.itemStack, event));
        DisposableRegistry.registerShutdownCleanup("MinePhone.battery", () => this.shutdown());
    }
    static shutdown() { if (intervalId !== null) RuntimeHandleRegistry.clear(intervalId); intervalId = null; sessions.clear(); phoneVisuals.clear(); }
    static begin(player) { if (!player) return; this.ensure(player); try { player.setDynamicProperty(LAST_KEY, Date.now()); } catch {} this.syncDurability(player); sessions.add(player.id); }
    static end(player) { if (player) { sessions.delete(player.id); try { player.setDynamicProperty(LAST_KEY, Date.now()); } catch {} } }
    static syncDurability(player) {
        try {
            const container = player?.getComponent("minecraft:inventory")?.container;
            if (!container) return;
            const damage = Math.max(0, Math.min(100, Math.round(100 - this.battery(player))));
            for (let i = 0; i < container.size; i++) {
                const stack = container.getItem(i);
                if (stack?.typeId !== "mcity:mine_phone") continue;
                const durability = stack.getComponent("minecraft:durability");
                if (durability) { durability.damage = damage; container.setItem(i, stack); }
            }
        } catch {}
    }
    static ensure(player) { try { if (player.getDynamicProperty(BATTERY_KEY) === undefined) player.setDynamicProperty(BATTERY_KEY, 100); if (player.getDynamicProperty(LAST_KEY) === undefined) player.setDynamicProperty(LAST_KEY, Date.now()); } catch {} }
    static battery(player) { try { this.ensure(player); return Math.max(0, Math.min(100, Number(player.getDynamicProperty(BATTERY_KEY) ?? 100))); } catch { return 0; } }
    static flashlight(player) { try { return player.getDynamicProperty(FLASHLIGHT_KEY) === true; } catch { return false; } }
    static toggleFlashlight(player) { const next = !this.flashlight(player); try { player.setDynamicProperty(FLASHLIGHT_KEY, next); } catch {} return next; }
    static tryPlaceOnCharger(player, stack, event) {
        if (!player || !CustomItemRegistry.isMinePhone(stack?.typeId)) return false;
        let target; try { target = player.getBlockFromViewDirection({ includeLiquidBlocks: false, includePassableBlocks: false, maxDistance: 5 })?.block; } catch {}
        if (target?.typeId !== "mcity:phone_charger") return false;
        try {
            event.cancel = true;
            const slot = player.getComponent("minecraft:equippable")?.getEquipmentSlot(EquipmentSlot.Mainhand);
            slot?.setItem(undefined);
            const visual = target.dimension.spawnItem(new ItemStack("mcity:mine_phone", 1), { x: target.location.x + 0.5, y: target.location.y + 1.15, z: target.location.z + 0.5 });
            try { visual.addTag("mcity_phone_display"); } catch {}
            phoneVisuals.set(player.id, visual);
            player.setDynamicProperty(CHARGE_KEY, JSON.stringify({ startedAt: Date.now(), lastAt: Date.now(), dimensionId: target.dimension.id, x: target.location.x, y: target.location.y, z: target.location.z, phonePlaced: true }));
            player.sendMessage("§aMine Phone placed on the charger.");
            return true;
        } catch { return false; }
    }
    static tryStartCharging(player, stack) {
        if (!player || !CustomItemRegistry.isCharger?.(stack?.typeId)) return false;
        let target; try { target = player.getBlockFromViewDirection({ includeLiquidBlocks: false, includePassableBlocks: false, maxDistance: 5 })?.block; } catch {}
        if (!redstoneSource(target)) return false;
        try { player.setDynamicProperty(CHARGE_KEY, JSON.stringify({ startedAt: Date.now(), lastAt: Date.now(), dimensionId: target.dimension.id, x: target.location.x, y: target.location.y, z: target.location.z })); player.sendMessage("§aMine Phone charging started. Keep the charger aimed at a powered Redstone source."); } catch {}
        return true;
    }
    static #animatePhone(player, charge, now) {
        const entity = phoneVisuals.get(player.id);
        if (!entity || !charge?.phonePlaced) return;
        try {
            const t = now / 1000;
            const y = charge.y + 1.15 + Math.sin(t * 2.2) * 0.08;
            const angle = (t * 36) % 360;
            entity.teleport({ x: charge.x + 0.5, y, z: charge.z + 0.5 }, { dimension: world.getDimension(charge.dimensionId), keepVelocity: false });
            entity.setRotation?.({ x: 20, y: angle });
            const block = world.getDimension(charge.dimensionId)?.getBlock({ x: charge.x, y: charge.y, z: charge.z });
            if (chargerPowered(block)) world.getDimension(charge.dimensionId)?.spawnParticle?.("mcity:charger_charging", { x: charge.x + 0.5, y: charge.y + 0.25, z: charge.z + 0.5 });
        } catch { phoneVisuals.delete(player.id); }
    }

    static tick() {
        const now = Date.now();
        const players = world.getAllPlayers();
        const active = new Set([...sessions, ...players.filter(p => { try { return typeof p.getDynamicProperty(CHARGE_KEY) === "string"; } catch { return false; } }).map(p => p.id)]);
        animationPhase = (animationPhase + 1) % 20;
        for (const id of [...active]) {
            const player = world.getAllPlayers().find(p => p.id === id);
            if (!player) { sessions.delete(id); continue; }
            try {
                this.ensure(player); const last = Number(player.getDynamicProperty(LAST_KEY) || now); const elapsed = Math.max(0, now - last);
                if (elapsed >= 1000) { const drain = elapsed / (MAX_SECONDS * 1000) * (this.flashlight(player) ? 2 : 1); player.setDynamicProperty(BATTERY_KEY, Math.max(0, this.battery(player) - drain * 100)); player.setDynamicProperty(LAST_KEY, now); this.syncDurability(player); }
                const raw = player.getDynamicProperty(CHARGE_KEY); if (typeof raw === "string") {
                    const charge = JSON.parse(raw); const block = world.getDimension(charge.dimensionId)?.getBlock({ x: charge.x, y: charge.y, z: charge.z });
                    this.#animatePhone(player, charge, now);
                    if (charge.phonePlaced ? !chargerPowered(block) : !redstoneSource(block)) { player.setDynamicProperty(CHARGE_KEY, undefined); continue; }
                    const chargeElapsed = Math.max(0, now - Number(charge.lastAt || now)); const increase = chargeElapsed / (CHARGE_SECONDS * 1000) * 100;
                    if (increase > 0) { player.setDynamicProperty(BATTERY_KEY, Math.min(100, this.battery(player) + increase)); this.syncDurability(player); charge.lastAt = now; player.setDynamicProperty(CHARGE_KEY, JSON.stringify(charge)); if (this.battery(player) >= 100) player.setDynamicProperty(CHARGE_KEY, undefined); }
                }
                if (this.battery(player) <= 0) sessions.delete(id);
            } catch { sessions.delete(id); }
        }
    }
}

export default MinePhoneService;
