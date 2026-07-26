// MCity Dashboard V2 - Conservative village and villager protection.
import { world, Player, ItemStack } from "@minecraft/server";
import { CONFIG } from "../../config.js";
import { BedrockCompat } from "../../core/bedrockCompat.js";
import { RuntimeHandleRegistry } from "../../core/runtimeHandleRegistry.js";
import { DisposableRegistry } from "../../core/disposableRegistry.js";
import { Logger } from "../../core/logger.js";

const VC = CONFIG.VILLAGE_PROTECTION;
const DIMENSIONS = ["minecraft:overworld", "minecraft:nether", "minecraft:the_end"];
const state = { initialized: false, villages: [], villagerIndex: new Map(), scanId: null };

function distanceSquared(a, b) { const dx = a.x - b.x, dz = a.z - b.z; return dx * dx + dz * dz; }
function isVillager(entity) { return entity?.typeId === "minecraft:villager" || entity?.typeId === "minecraft:villager_v2"; }
function isAllowedBlock(block) {
    const id = String(block?.typeId || "");
    return VC.ALLOWED_INTERACTION_BLOCKS.some(token => id === `minecraft:${token}` || id.includes(token));
}
function locationKey(dimension, x, z) { return `${dimension}:${Math.floor(x)}:${Math.floor(z)}`; }

export class VillageProtection {
    static initialize() {
        if (state.initialized || !VC.ENABLED) return;
        state.initialized = true;
        this.#scan();
        state.scanId = RuntimeHandleRegistry.interval("VillageProtection.scan", () => this.#scan(), VC.SCAN_INTERVAL_TICKS || 600, { budgetMs: 8 });
        this.#registerEvents();
        DisposableRegistry.registerShutdownCleanup("VillageProtection.lifecycle", () => this.shutdown());
        Logger.startup("VillageProtection", "Automatic village and villager protection initialized");
    }

    static shutdown() {
        if (state.scanId !== null) RuntimeHandleRegistry.clear(state.scanId);
        state.scanId = null;
        state.villages = [];
        state.villagerIndex.clear();
        state.initialized = false;
    }

    static #scan() {
        const candidates = [];
        for (const id of DIMENSIONS) {
            let entities = [];
            try { entities = world.getDimension(id).getEntities({ type: "minecraft:villager" }); } catch { continue; }
            for (const entity of entities.slice(0, VC.MAX_TRACKED_VILLAGERS || 512)) {
                if (isVillager(entity) && entity.location) candidates.push({ entity, dimensionId: id, location: { ...entity.location } });
            }
        }
        const groups = [];
        const radiusSq = Math.pow(VC.CLUSTER_RADIUS_BLOCKS || 48, 2);
        for (const candidate of candidates) {
            let group = groups.find(g => g.dimensionId === candidate.dimensionId && g.some(v => distanceSquared(v.location, candidate.location) <= radiusSq));
            if (!group) groups.push(group = []);
            group.push(candidate);
        }
        const villages = [];
        const index = new Map();
        for (const group of groups) {
            if (group.length < (VC.MIN_VILLAGERS_PER_VILLAGE || 1)) continue;
            const xs = group.map(v => v.location.x), zs = group.map(v => v.location.z), ys = group.map(v => v.location.y);
            const padding = VC.PROTECTION_PADDING_BLOCKS || 8;
            const village = {
                id: `village:${group[0].dimensionId}:${Math.floor((Math.min(...xs) + Math.max(...xs)) / 2)}:${Math.floor((Math.min(...zs) + Math.max(...zs)) / 2)}`,
                dimensionId: group[0].dimensionId,
                minX: Math.floor(Math.min(...xs) - padding), maxX: Math.ceil(Math.max(...xs) + padding),
                minZ: Math.floor(Math.min(...zs) - padding), maxZ: Math.ceil(Math.max(...zs) + padding),
                center: { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: Math.max(...ys), z: (Math.min(...zs) + Math.max(...zs)) / 2 },
                villagers: group.map(v => v.entity.id)
            };
            villages.push(village);
            for (const v of group) index.set(v.entity.id, village.id);
        }
        state.villages = villages;
        state.villagerIndex = index;
        this.#containVillagers(candidates, villages);
    }

    static #containVillagers(candidates, villages) {
        if (!VC.TELEPORT_ESCAPED_VILLAGERS) return;
        for (const candidate of candidates) {
            const village = villages.find(v => v.id === state.villagerIndex.get(candidate.entity.id));
            if (!village) continue;
            const outside = candidate.location.x < village.minX || candidate.location.x > village.maxX || candidate.location.z < village.minZ || candidate.location.z > village.maxZ;
            if (!outside) continue;
            try { candidate.entity.teleport(village.center, { dimension: world.getDimension(village.dimensionId), checkForBlocks: true }); }
            catch (error) { Logger.debug("VillageProtection", "Villager containment failed", error); }
        }
    }

    static #villageAt(blockOrEntity) {
        const location = blockOrEntity?.location;
        const dimensionId = blockOrEntity?.dimension?.id || blockOrEntity?.dimensionId;
        if (!location || !dimensionId) return null;
        return state.villages.find(v => v.dimensionId === dimensionId && location.x >= v.minX && location.x <= v.maxX && location.z >= v.minZ && location.z <= v.maxZ) || null;
    }

    static #registerEvents() {
        BedrockCompat.subscribe("block.break.before", "VillageProtection.break", event => {
            if (this.#villageAt(event.block)) { event.cancel = true; try { event.player.sendMessage(CONFIG.PREFIX + "§cVillage protection: blocks cannot be broken here."); } catch {} }
        });
        BedrockCompat.subscribe("block.place.before", "VillageProtection.placeBefore", event => {
            if (this.#villageAt(event.block)) { event.cancel = true; try { event.player.sendMessage(CONFIG.PREFIX + "§cVillage protection: blocks cannot be placed here."); } catch {} }
        });
        BedrockCompat.subscribe("block.place.after", "VillageProtection.placeAfter", event => {
            const village = this.#villageAt(event.block);
            if (!village || !event.block || !(event.player instanceof Player)) return;
            const typeId = event.block.typeId;
            RuntimeHandleRegistry.timeout("VillageProtection.placeCompensation", () => {
                try { if (event.block.typeId === typeId) event.block.setType("minecraft:air"); event.player.getComponent("minecraft:inventory")?.container?.addItem(new ItemStack(typeId, 1)); } catch (error) { Logger.warn("VillageProtection", "Placement compensation failed", error); }
            }, 1);
        });
        BedrockCompat.subscribe("block.interact.before", "VillageProtection.interact", event => {
            if (this.#villageAt(event.block) && !isAllowedBlock(event.block)) event.cancel = true;
        });
        BedrockCompat.subscribe("explosion.before", "VillageProtection.explosion", event => {
            const impacted = event.getImpactedBlocks();
            const safe = impacted.filter(block => !this.#villageAt(block));
            if (safe.length !== impacted.length) { if (!safe.length) event.cancel = true; else event.setImpactedBlocks(safe); }
        });
        BedrockCompat.subscribe("entity.hurt.after", "VillageProtection.villagerHurt", event => {
            const entity = event.hurtEntity;
            if (!isVillager(entity) || !this.#villageAt(entity)) return;
            try { const health = entity.getComponent("minecraft:health"); if (health && Number(event.damage) > 0) health.setCurrentValue(Math.min(health.effectiveMax || 20, health.currentValue + event.damage)); } catch {}
            try { event.damageSource?.damagingEntity?.sendMessage(CONFIG.PREFIX + "§cVillagers are protected in this village."); } catch {}
        });
        BedrockCompat.subscribe("entity.interact.before", "VillageProtection.villagerInteract", event => {
            if (isVillager(event.target || event.entity) && this.#villageAt(event.target || event.entity)) return; // trading and villager interaction are allowed
        });
    }

    static stats() { return { initialized: state.initialized, villages: state.villages.length, trackedVillagers: state.villagerIndex.size, scanIntervalTicks: VC.SCAN_INTERVAL_TICKS }; }
}

export default VillageProtection;
