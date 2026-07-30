// MCity Dashboard V2 - ATM Physical Event Handling / Protection
// Phase 3: Event-Driven Optimization
// Phase 7.3 (v0.21.2): Source chest protection (always cancel) + hopper placement block.
// UX Fix (v1.7.7): Source owners/admins may open source chests normally; setting hook opens local management UI.

import { system, Player, ItemStack } from "@minecraft/server";
import { CONFIG } from "../../config.js";
import { Logger } from "../../core/logger.js";
import { Permissions } from "../../core/permissions.js";
import { ATMService } from "./atmService.js";
import { ATMUI } from "./atmUI.js";
import { ATMAdminUI } from "./atmAdminUI.js";
import { AccessCardService } from "../../core/accessCardService.js";
import { BedrockCompat } from "../../core/bedrockCompat.js";
import { SubscriptionRegistry } from "../../core/subscriptionRegistry.js";

const AC = CONFIG.ATM;
const runtime = { initialized: false };
function cleanName(name){return String(name||"").replace(/§./g,"").trim().toLowerCase();}
function deny(p,msg){try{p.sendMessage(CONFIG.PREFIX+"§c"+msg);}catch{}}
function isHook(item,name){return item?.typeId===AC.SETUP_HOOK && cleanName(item.nameTag)===cleanName(name);}

// Spatial Cache for fast lookup
// Reduces getDynamicProperty overhead significantly for block type checks
const atmBlockCache = new Map();

export class ATMProtection {
    static initialize(){ 
        if(runtime.initialized)return; 
        runtime.initialized=true; 
        this.#registerSetup(); 
        this.#registerInteraction(); 
        this.#registerBreak(); 
        this.#registerPiston(); 
        this.#registerHopperGuard(); // Phase 7.3 (v0.21.2) (CT4)
        Logger.startup("ATMProtection","ATM physical events initialized (Cached + Hopper Guard)"); 
    }
    
    static shutdown(){ 
        SubscriptionRegistry.disposePrefix("ATMProtection.");
        runtime.initialized=false; 
        atmBlockCache.clear();
    }

    // Fast local lookup
    static #fastCheck(block) {
        if(!block) return null;
        if(block.typeId !== AC.CHEST_BLOCK && block.typeId !== AC.ATM_BLOCK && block.typeId !== AC.SOURCE_BLOCK && !(AC.ATM_BLOCK_VARIANTS || []).includes(block.typeId)) return null;
        
        return {
            isATM: ATMService.isATM(block),
            isSource: ATMService.isSource(block)
        };
    }

    static #registerSetup(){
        try{ 
            BedrockCompat.subscribe("block.interact.after", "ATMProtection.setup", e=>{ 
                const {block,itemStack,player}=e; 
                if(!block||(![AC.CHEST_BLOCK, ...(AC.ATM_BLOCK_VARIANTS || [])].includes(block.typeId))||!itemStack)return; 
                if(!(player instanceof Player))return; 
                
                if(isHook(itemStack,AC.HOOK_ATM_NAME)){
                    system.run(()=>{
                        const res=ATMService.setAsATM(block,player);
                        player.sendMessage(CONFIG.PREFIX+res.message);
                    });
                } else if(isHook(itemStack,AC.HOOK_SOURCE_NAME)){
                    system.run(()=>{
                        const res=ATMService.setAsSource(block,player);
                        player.sendMessage(CONFIG.PREFIX+res.message);
                    });
                } 
            }); 
        }catch(error){Logger.warn("ATMProtection","setup interact unavailable",error);}
    }

    static #registerInteraction(){
        try{ 
            BedrockCompat.subscribe("block.interact.before", "ATMProtection.interaction", e=>{ 
                const {block,itemStack,player}=e; 
                if(!block||!(player instanceof Player))return; 
                
                const type = this.#fastCheck(block);
                if(!type) return;

                if(type.isATM){
                    e.cancel = true;
                    const access = AccessCardService.authorize(player, `atm:${ATMService.getATMFromBlock(block)?.code || "unknown"}`);
                    if (!access.valid) { deny(player, access.message); return; }
                    system.run(() => ATMUI.open(player, block));
                    return;
                } 
                
                // Source interaction has two modes:
                // 1) Setting hook + ATM permission => open local source settings UI.
                // 2) Source owner or ATM admin without setting hook => allow normal chest open
                //    so stored ores/resources can be withdrawn/managed.
                // 3) Everyone else => protected.
                if(type.isSource){
                    if(isHook(itemStack,AC.HOOK_SETTING_NAME) && Permissions.canManageATM(player)){
                        e.cancel=true;
                        system.run(()=>ATMAdminUI.sourceManagement(player,block,{fromWorld:true}));
                        return;
                    }
                    const info = ATMService.getSourceFromBlock(block);
                    const canOpenSource = Permissions.canManageATM(player) || info?.source?.ownerId === player.id;
                    if(canOpenSource){
                        // Do not cancel: let Bedrock open the chest normally.
                        return;
                    }
                    e.cancel=true;
                    deny(player,"Source chests are protected. Use an ATM to exchange ores.");
                }
            });
        }catch(error){Logger.warn("ATMProtection","main interact unavailable",error);}
    }

    /**
     * Phase 7.3 (v0.21.2) (CT4): Block hopper placement adjacent to
     * source/ATM chests.
     *
     * Previously, a player could place a hopper directly below or beside
     * a source chest and silently drain every ore that got deposited.
     * The piston handler blocks piston movement of the source block
     * itself but did nothing about hopper pull mechanics.
     *
     * Now: when a player places a hopper, we check all 6 adjacent blocks.
     * If any is an ATM or Source chest, the placement is cancelled.
     */
    static #registerHopperGuard(){
        try{
            BedrockCompat.subscribe("block.place.before", "ATMProtection.hopperGuard", e=>{
                const { block, player } = e;
                if(!block || !(player instanceof Player)) return;
                const placedTypeId = block.typeId;
                if(placedTypeId !== "minecraft:hopper") return;
                // Check all 6 adjacent blocks for ATM/Source chests.
                const offsets = [
                    {x:0,y:1,z:0}, {x:0,y:-1,z:0},
                    {x:1,y:0,z:0}, {x:-1,y:0,z:0},
                    {x:0,y:0,z:1}, {x:0,y:0,z:-1}
                ];
                for(const off of offsets){
                    let neighbor;
                    try{ neighbor = block.offset(off); } catch{ continue; }
                    if(!neighbor) continue;
                    const neighborType = this.#fastCheck(neighbor);
                    if(neighborType?.isATM || neighborType?.isSource){
                        e.cancel = true;
                        deny(player, "Cannot place hopper next to ATM/Source chests.");
                        return;
                    }
                    // Also check if the neighbor block is the base
                    // (emerald/netherite block) of an ATM/Source.
                    if(neighbor.typeId === AC.ATM_BLOCK || neighbor.typeId === AC.SOURCE_BLOCK){
                        const above = neighbor.above?.();
                        if(above){
                            const aboveType = this.#fastCheck(above);
                            if(aboveType?.isATM || aboveType?.isSource){
                                e.cancel = true;
                                deny(player, "Cannot place hopper next to ATM/Source chests.");
                                return;
                            }
                        }
                    }
                }
            });
            if(!BedrockCompat.signal("block.place.before")) BedrockCompat.subscribe("block.place.after","ATMProtection.hopperGuardAfter",e=>{const block=e.block,player=e.player;if(!block||block.typeId!=="minecraft:hopper"||!(player instanceof Player))return;const offsets=[{x:0,y:1,z:0},{x:0,y:-1,z:0},{x:1,y:0,z:0},{x:-1,y:0,z:0},{x:0,y:0,z:1},{x:0,y:0,z:-1}];if(offsets.some(o=>{try{const n=block.offset(o),t=this.#fastCheck(n);return t?.isATM||t?.isSource;}catch{return false;}}))system.run(()=>{try{if(block.typeId==="minecraft:hopper")block.setType("minecraft:air");player.getComponent("minecraft:inventory")?.container?.addItem(new ItemStack("minecraft:hopper",1));deny(player,"Hopper removed and refunded: protected ATM/Source.");}catch(error){Logger.warn("ATMProtection","Hopper compensation failed",error);}});});
        }catch(error){Logger.warn("ATMProtection","hopper guard event unavailable",error);}
    }

    static #registerBreak(){
        try{ 
            BedrockCompat.subscribe("block.break.before", "ATMProtection.break", e=>{ 
                const {block,player}=e; 
                if(!block||!(player instanceof Player))return; 
                
                const type = this.#fastCheck(block);
                let special = type?.isATM || type?.isSource;
                
                let base = false;
                if(!special && (block.typeId===AC.ATM_BLOCK||block.typeId===AC.SOURCE_BLOCK)){
                    try{
                        const above=block.above();
                        if(above) {
                            const aboveType = this.#fastCheck(above);
                            base = aboveType?.isATM || aboveType?.isSource;
                        }
                    }catch{ base = false; }
                } 
                
                if(!special&&!base)return; 
                e.cancel=true; 
                
                if(!Permissions.canManageATM(player)){
                    deny(player,"Only ATM admins can break ATM/Source blocks.");
                    return;
                } 
                if(base){
                    deny(player,"Break the special chest first to remove this ATM/Source safely.");
                    return;
                } 
                
                system.run(()=>{
                    try{
                        const res=ATMService.removeSpecialBlock(block); 
                        try{block.setType("minecraft:air");}catch{} 
                        const below=block.below?.(); 
                        if(below&&(below.typeId===AC.ATM_BLOCK||below.typeId===AC.SOURCE_BLOCK)){
                            try{below.setType("minecraft:air");}catch{}
                        } 
                        player.sendMessage(CONFIG.PREFIX+res.message);
                    }catch(error){
                        Logger.error("ATMProtection","Safe break failed",error);
                        player.sendMessage(CONFIG.PREFIX+"§cATM removal failed.");
                    }
                }); 
            }); 
        }catch(error){Logger.warn("ATMProtection","break protection unavailable",error);}
    }

    static #registerPiston(){
        try{ 
            BedrockCompat.subscribe("piston.activate.before", "ATMProtection.piston", e=>{ 
                try{ 
                    const affected=[]; 
                    const pistonBlock=e.piston?.block||e.block||e.sourceBlock; 
                    const dim=pistonBlock?.dimension||e.dimension; 
                    
                    try{if(e.piston?.getAttachedBlocks)affected.push(...e.piston.getAttachedBlocks());}catch{} 
                    try{if(e.piston?.getAttachedBlocksLocations&&dim?.getBlock){
                        for(const loc of e.piston.getAttachedBlocksLocations()){
                            const b=dim.getBlock(loc);
                            if(b)affected.push(b);
                        }
                    }}catch{} 
                    
                    for(const b of affected){ 
                        const type = this.#fastCheck(b);
                        if(type?.isATM || type?.isSource){
                            e.cancel=true;
                            return;
                        } 
                        if((b.typeId===AC.ATM_BLOCK||b.typeId===AC.SOURCE_BLOCK)){
                            const above=b.above?.(); 
                            if(above) {
                                const aboveType = this.#fastCheck(above);
                                if(aboveType?.isATM || aboveType?.isSource){
                                    e.cancel=true;
                                    return;
                                }
                            }
                        } 
                    } 
                }catch(error){Logger.warn("ATMProtection","piston handler failed",error);} 
            }); 
        }catch(error){Logger.warn("ATMProtection","piston event unavailable",error);}
    }
}

export default ATMProtection;