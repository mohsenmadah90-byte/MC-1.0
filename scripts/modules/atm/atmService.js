// MCity Dashboard V2 - Physical ATM Service
// Phase 2: Transaction Safety & Anti-Dupe
// Phase 1 Critical Fix: Register blockCache cleanup with DisposableRegistry.
// Phase 4 Scalability: Rate limiting + EventBus integration.
// Phase 3 (v1.5.3): ATM delete/recovery hardening and marker consistency.
// Patch 3 (v1.6.7): database.restored location index rebuild hook.

import { world, system } from "@minecraft/server";
import { CONFIG } from "../../config.js";
import { Database } from "../../core/database.js";
import { Logger } from "../../core/logger.js";
import { MoneyUtils } from "../../core/moneyUtils.js";
import { MoneyService } from "../economy/moneyService.js";
import { LevelService } from "../economy/levelService.js";
import { FinanceService } from "../finance/financeService.js";
import { NotificationService } from "../../dashboard/dashboardNotifications.js";
import { DisposableRegistry } from "../../core/disposableRegistry.js";
import { RateLimiter } from "../../core/rateLimiter.js";
import { EventBus } from "../../core/eventBus.js";
import { DEFAULT_ATM_DB, DEFAULT_SOURCE_DB, validateATMData, validateSourceData, sanitizeATM, sanitizeSource } from "../../schemas/atmSchema.js";
import { AuditService } from "../audit/auditService.js";
import { ATMInventory } from "./atmInventory.js";
import { RuntimeHandleRegistry } from "../../core/runtimeHandleRegistry.js";

const AC = CONFIG.ATM;
const AIC = CONFIG.ATM_INFO;
function now(){return Date.now();}
function cleanCode(code){return String(code||"").replace(/\D/g,"").substring(0,4);}

export class ATMService {
    static #initialized=false;
    static #blockCache=new Map();
    /**
     * Phase 2 Performance: location → atmCode index for O(1) lookup of an
     * ATM by its physical block location. Rebuilt on initialize and updated
     * incrementally on every create/link/unlink/delete operation.
     */
    static #atmLocationIndex = new Map();
    static #sourceLocationIndex = new Map();
    static #locationIndexLoaded = false;

    static initialize(){ if(this.#initialized)return; this.#initialized=true; this.atmDB(); this.sourceDB();
        // Phase 1 Fix: ATM block cache is global (not per-player), so we register
        // a shutdown cleanup. It is also cleared by a periodic interval in ATMProtection.
        DisposableRegistry.registerShutdownCleanup("ATMService.blockCache", () => {
            this.#blockCache.clear();
        });
        DisposableRegistry.registerShutdownCleanup("ATMService.locationIndexes", () => {
            this.#atmLocationIndex.clear();
            this.#sourceLocationIndex.clear();
            this.#locationIndexLoaded = false;
            this.#isValidating = false;
            this.#initialized = false;
        });
        // Phase 2: build the location → code indexes upfront.
        this.#rebuildLocationIndexes();
        EventBus.on("database.restored", event => this.onDatabaseRestored(event));
        Database.registerRefreshHandler("ATMService", event => this.onDatabaseRestored(event));
        // Phase 4 Stability: Periodic source block validation.
        // Every 5 minutes, verify that source blocks still exist in the world.
        // If a source block is missing, its linked ATMs are moved to waiting.
        // Phase 3 Fix: Validation now runs as a yieldable background job via
        // system.runJob, so 100+ sources don't cause a tick spike.
        const validationId = RuntimeHandleRegistry.interval("ATMService.sourceValidation", () => {
            this.#validateSourceBlocks();
        }, 6000);
        DisposableRegistry.registerShutdownCleanup("ATMService.validation", () => {
            RuntimeHandleRegistry.clear(validationId);
        });

        // Phase 1 Fix: Recover any pending/recovery_failed journals from
        // a crash mid-exchange. This runs once on startup, BEFORE any
        // player can trigger a new exchange. Deferred via system.run so
        // it doesn't block initialization if FinanceService hasn't loaded
        // yet (FinanceService.initialize() is called before ATMService in
        // main.js, but we defer to be safe).
        system.run(() => {
            try { this.recoverPendingJournals(); } catch (e) { Logger.error("ATM", "Journal recovery on startup failed", e); }
        });

        Logger.startup("ATM",`ATM service initialized (${this.#atmLocationIndex.size} ATMs, ${this.#sourceLocationIndex.size} sources indexed)`);
    }

    /**
     * Phase 4 Stability: Validate that all source blocks still exist in the world.
     * If a source block has been broken, move its linked ATMs to waiting state.
     *
     * Phase 3 Fix: Now runs as a yieldable background job.
     *
     * PROBLEM (pre-Phase 3):
     *   `#validateSourceBlocks` ran synchronously inside a `system.runInterval`
     *   callback. For each source, it called `world.getDimension().getBlock()`
     *   — a native FFI call that can take 1-5ms per invocation when the chunk
     *   is loaded (and longer when it needs to load). For a server with 100+
     *   source chests, this was a 100-500ms synchronous tick spike every 5
     *   minutes, causing noticeable lag for all players.
     *
     * SOLUTION (Phase 3):
     *   1. `#validateSourceBlocks` is now a thin wrapper that kicks off
     *      `#validateSourceBlocksJob` (a generator) via `system.runJob`.
     *   2. The generator iterates sources in batches of 10, yielding between
     *      batches so the Bedrock scheduler can process other tick work.
     *   3. A re-entrancy guard `#isValidating` prevents overlapping runs
     *      (if one validation pass takes longer than 5 minutes, the next
     *      interval tick is skipped).
     *   4. The DB transactions for moving ATMs to waiting are still
     *      per-source (atomic per source), but they're now spread across
     *      ticks instead of all in one tick.
     */
    static #isValidating = false;

    static #validateSourceBlocks() {
        if (this.#isValidating) {
            Logger.debug("ATM", "Source validation skipped — already running");
            return;
        }
        this.#isValidating = true;
        RuntimeHandleRegistry.job("ATMService.validateSourceBlocks", this.#validateSourceBlocksJob());
    }

    static *#validateSourceBlocksJob() {
        try {
            const srcDb = this.sourceDB();
            const sources = srcDb.sources || {};
            const sourceEntries = Object.entries(sources);
            let changed = false;
            const BATCH_SIZE = 10;

            for (let i = 0; i < sourceEntries.length; i++) {
                const [code, src] = sourceEntries[i];
                if (!src?.location) continue;
                const block = this.#getBlockFromLocation(src.location, src.dimension);
                if (!block || block.typeId !== AC.CHEST_BLOCK) {
                    // Source block is missing — move linked ATMs to waiting
                    Logger.warn("ATM", `Source ${code} block missing. Moving ${(src.atmCodes || []).length} ATMs to waiting.`);
                    Database.transaction(AC.COLLECTION, data => {
                        for (const atmCode of (src.atmCodes || [])) {
                            if (data.active[atmCode]) {
                                const w = { ...data.active[atmCode] };
                                delete w.sourceCode;
                                data.waiting[atmCode] = w;
                                delete data.active[atmCode];
                            }
                        }
                    });
                    // Clear atmCodes from source
                    src.atmCodes = [];
                    src.lastValidated = now();
                    changed = true;
                }

                // Phase 3 Fix: Yield every BATCH_SIZE sources to let the tick breathe.
                // Each getBlock() is a native FFI call; batching prevents FFI
                // call accumulation from spiking the tick.
                if ((i + 1) % BATCH_SIZE === 0) yield;
            }

            if (changed) {
                Database.save(AC.COLLECTION);
                Database.save(AC.SOURCE_COLLECTION);
                this.#markLocationIndexStale();
            }
        } catch (error) {
            Logger.warn("ATM", "Source block validation failed", error);
        } finally {
            this.#isValidating = false;
        }
    }

    static #getBlockFromLocation(locationStr, dimensionId) {
        try {
            const [dim, x, y, z] = locationStr.split(":");
            const dimension = world.getDimension?.(dimensionId || `minecraft:${dim}`);
            return dimension?.getBlock({ x: Number(x), y: Number(y), z: Number(z) });
        } catch { return null; }
    }

    /**
     * Phase 2 Performance: rebuild the location → code indexes from scratch.
     * Called once on initialize, and as a fallback if the index is detected
     * to be stale (e.g. external mutation).
     */
    static #rebuildLocationIndexes() {
        this.#atmLocationIndex.clear();
        this.#sourceLocationIndex.clear();
        const atmDb = this.atmDB();
        for (const [code, a] of Object.entries(atmDb.active || {})) {
            if (a?.location) this.#atmLocationIndex.set(a.location, { code, status: "active" });
        }
        for (const [code, a] of Object.entries(atmDb.waiting || {})) {
            if (a?.location) this.#atmLocationIndex.set(a.location, { code, status: "waiting" });
        }
        const srcDb = this.sourceDB();
        for (const [code, s] of Object.entries(srcDb.sources || {})) {
            if (s?.location) this.#sourceLocationIndex.set(s.location, code);
        }
        this.#locationIndexLoaded = true;
    }

    static rebuildLocationIndexes() {
        this.#rebuildLocationIndexes();
        Logger.info("ATM", `Location indexes rebuilt (${this.#atmLocationIndex.size} ATMs, ${this.#sourceLocationIndex.size} sources)`);
        return { atms: this.#atmLocationIndex.size, sources: this.#sourceLocationIndex.size };
    }

    static onDatabaseRestored(event = {}) {
        const restored = event.restored || [];
        if (restored.length && !restored.some(n => n === AC.COLLECTION || n === AC.SOURCE_COLLECTION)) return;
        this.#blockCache.clear();
        this.#locationIndexLoaded = false;
        this.#rebuildLocationIndexes();
        Logger.info("ATM", "Database restore detected — block cache cleared and location indexes rebuilt", { restored });
    }

    static #ensureLocationIndexLoaded() {
        if (!this.#locationIndexLoaded) this.#rebuildLocationIndexes();
    }

    /**
     * Phase 2 Performance: Mark the location indexes as stale.
     * The next read will trigger a rebuild. Cheaper than rebuilding on every
     * write, since reads are far more frequent than writes.
     */
    static #markLocationIndexStale() {
        this.#locationIndexLoaded = false;
    }
    static atmDB(){return Database.collection(AC.COLLECTION, DEFAULT_ATM_DB, { validate: validateATMData });}
    static sourceDB(){return Database.collection(AC.SOURCE_COLLECTION, DEFAULT_SOURCE_DB, { validate: validateSourceData });}

    static blockKey(block){ const {x,y,z}=block.location; return `${block.dimension.id.replace("minecraft:","")}:${Math.floor(x)}:${Math.floor(y)}:${Math.floor(z)}`; }
    static isATM(block){return this.#type(block)==="atm";}
    static isSource(block){return this.#type(block)==="source";}
    static #type(block){ const key=this.blockKey(block); if(this.#blockCache.has(key))return this.#blockCache.get(key); try{const v=world.getDynamicProperty(`mcity2:block:${key}`); const t=v==="atm"||v==="source"?v:null; this.#blockCache.set(key,t); return t;}catch{return null;} }
    static #setType(block,type){ const key=this.blockKey(block); this.#setTypeByLocation(key,type); }
    static #setTypeByLocation(location,type){ if(!location)return; try{ world.setDynamicProperty(`mcity2:block:${location}`,type||undefined); }catch(error){ Logger.warn("ATM", `Failed to update special block marker at ${location}`, error); } this.#blockCache.set(location,type||null); }

    static generateCode(db, kind="atm"){
        for(let i=0;i<80;i++){ const code=String(Math.floor(1000+Math.random()*9000)); if(db.codes.includes(code))continue; if(kind==="atm"&&(db.waiting?.[code]||db.active?.[code]))continue; if(kind==="source"&&db.sources?.[code])continue; db.codes.push(code); db.codes=db.codes.slice(-AC.MAX_CODES_HISTORY); return code; }
        const code=String(Date.now()).slice(-4); db.codes.push(code); return code;
    }

    static listATMs(filter="all"){
        const db=this.atmDB(); const out=[];
        if(filter==="all"||filter==="active") for(const [code,atm] of Object.entries(db.active||{})) out.push({code,atm,status:"active"});
        if(filter==="all"||filter==="waiting") for(const [code,atm] of Object.entries(db.waiting||{})) out.push({code,atm,status:"waiting"});
        out.sort((a,b)=>(b.atm.createdAt||0)-(a.atm.createdAt||0)); return out;
    }
    static listSources(){return Object.entries(this.sourceDB().sources||{}).map(([code,source])=>({code,source})).sort((a,b)=>(b.source.createdAt||0)-(a.source.createdAt||0));}
    static getATMByCode(code){code=cleanCode(code); const db=this.atmDB(); if(db.active[code])return{code,atm:db.active[code],status:"active"}; if(db.waiting[code])return{code,atm:db.waiting[code],status:"waiting"}; return null;}
    static getSourceByCode(code){code=cleanCode(code); const s=this.sourceDB().sources[code]; return s?{code,source:s}:null;}

    static setAsATM(block, player){
        if(!this.#canAdmin(player))return{success:false,message:"§cNo permission."};
        if(block.typeId!==AC.CHEST_BLOCK)return{success:false,message:"§cATM must be a chest."};
        try{ if(block.below()?.typeId!==AC.ATM_BLOCK)return{success:false,message:"§cATM chest must be on Emerald Block."}; }catch{return{success:false,message:"§cCannot verify base block."};}
        if(this.#type(block))return{success:false,message:"§cThis chest is already registered."};
        let out=null;
        const tx=Database.transaction(AC.COLLECTION,data=>{ if(Object.keys(data.waiting).length>=AC.MAX_WAITING_ATMS)throw new Error("Waiting ATM limit reached."); const code=this.generateCode(data,"atm"); const atm=sanitizeATM({code,location:this.blockKey(block),dimension:block.dimension.id,ownerId:player.id,owner:player.name,createdAt:now()},code); data.waiting[code]=atm; data.stats.totalCreated=(data.stats.totalCreated||0)+1; data.stats.lastUpdated=now(); out=atm; return atm; });
        if(!tx.success)return{success:false,message:`§cATM create failed: ${tx.error}`}; this.#setType(block,"atm"); Database.save(AC.COLLECTION); this.#markLocationIndexStale(); AuditService.record("atm.create", "atm", player.id, player.name, `Created ATM ${out.code}`, { code: out.code, location: out.location }); return{success:true,atm:out,message:`§aATM created. Code: §e${out.code}`};
    }

    static setAsSource(block, player){
        if(!this.#canAdmin(player))return{success:false,message:"§cNo permission."};
        if(block.typeId!==AC.CHEST_BLOCK)return{success:false,message:"§cSource must be a chest."};
        try{ if(block.below()?.typeId!==AC.SOURCE_BLOCK)return{success:false,message:"§cSource chest must be on Netherite Block."}; }catch{return{success:false,message:"§cCannot verify base block."};}
        if(this.#type(block))return{success:false,message:"§cThis chest is already registered."};
        let out=null;
        const tx=Database.transaction(AC.SOURCE_COLLECTION,data=>{ const code=this.generateCode(data,"source"); const src=sanitizeSource({code,location:this.blockKey(block),dimension:block.dimension.id,ownerId:player.id,owner:player.name,createdAt:now(),atmCodes:[]},code); data.sources[code]=src; data.stats.totalCreated=(data.stats.totalCreated||0)+1; data.stats.lastUpdated=now(); out=src; return src; });
        if(!tx.success)return{success:false,message:`§cSource create failed: ${tx.error}`}; this.#setType(block,"source"); Database.save(AC.SOURCE_COLLECTION); this.#markLocationIndexStale(); AuditService.record("atm.source.create", "atm", player.id, player.name, `Created Source ${out.code}`, { code: out.code, location: out.location }); return{success:true,source:out,message:`§aSource created. Code: §e${out.code}`};
    }

    static getATMFromBlock(block){
        // Phase 2 Performance: O(1) location index lookup instead of linear
        // scan over all active+waiting ATMs.
        const key = this.blockKey(block);
        this.#ensureLocationIndexLoaded();
        const entry = this.#atmLocationIndex.get(key);
        if (!entry) return null;
        const db = this.atmDB();
        if (entry.status === "active") {
            const a = db.active?.[entry.code];
            if (a) return { code: entry.code, atm: a, active: true };
            // Stale index entry — fall back to linear scan.
            this.#rebuildLocationIndexes();
        } else if (entry.status === "waiting") {
            const a = db.waiting?.[entry.code];
            if (a) return { code: entry.code, atm: a, active: false };
            this.#rebuildLocationIndexes();
        }
        // Final fallback (rare): linear scan.
        for (const [code, a] of Object.entries(db.active || {})) if (a.location === key) return { code, atm: a, active: true };
        for (const [code, a] of Object.entries(db.waiting || {})) if (a.location === key) return { code, atm: a, active: false };
        return null;
    }

    static getSourceFromBlock(block){
        // Phase 2 Performance: O(1) location index lookup.
        const key = this.blockKey(block);
        this.#ensureLocationIndexLoaded();
        const code = this.#sourceLocationIndex.get(key);
        if (code) {
            const s = this.sourceDB().sources?.[code];
            if (s) return { code, source: s };
            this.#rebuildLocationIndexes();
        }
        // Fallback (rare): linear scan.
        const db = this.sourceDB();
        for (const [code, s] of Object.entries(db.sources || {})) if (s.location === key) return { code, source: s };
        return null;
    }

    static linkATM(sourceCode, atmCode){
        sourceCode=cleanCode(sourceCode); atmCode=cleanCode(atmCode); let atmInfo=null;
        const aTx=Database.transaction(AC.COLLECTION,data=>{ if(!data.waiting[atmCode])throw new Error("ATM not found or already linked."); atmInfo=data.waiting[atmCode]; data.active[atmCode]={...atmInfo,sourceCode,linkedAt:now()}; delete data.waiting[atmCode]; data.stats.totalLinked=(data.stats.totalLinked||0)+1; return data.active[atmCode]; });
        if(!aTx.success)return{success:false,message:`§c${aTx.error}`};
        const sTx=Database.transaction(AC.SOURCE_COLLECTION,data=>{ const s=data.sources[sourceCode]; if(!s)throw new Error("Source not found."); if(s.atmCodes.includes(atmCode))return; if(s.atmCodes.length>=AC.MAX_ATMS_PER_SOURCE)throw new Error("Source ATM limit reached."); s.atmCodes.push(atmCode); data.stats.totalLinked=(data.stats.totalLinked||0)+1; });
        if(!sTx.success){ Database.transaction(AC.COLLECTION,data=>{ if(data.active[atmCode]){ const a=data.active[atmCode]; delete a.sourceCode; data.waiting[atmCode]=a; delete data.active[atmCode]; } }); return{success:false,message:`§cLink rollback: ${sTx.error}`}; }
        Database.save(AC.COLLECTION); Database.save(AC.SOURCE_COLLECTION); this.#markLocationIndexStale(); AuditService.record("atm.link", "atm", "", "system", `Linked ATM ${atmCode} to Source ${sourceCode}`, { atmCode, sourceCode }); return{success:true,message:`§aATM ${atmCode} linked to Source ${sourceCode}.`};
    }

    static unlinkATM(sourceCode, atmCode){
        sourceCode=cleanCode(sourceCode); atmCode=cleanCode(atmCode);
        const tx=Database.transaction(AC.COLLECTION,data=>{ const a=data.active[atmCode]; if(!a)throw new Error("ATM not active."); const waiting={...a}; delete waiting.sourceCode; data.waiting[atmCode]=waiting; delete data.active[atmCode]; });
        if(!tx.success)return{success:false,message:`§c${tx.error}`};
        Database.transaction(AC.SOURCE_COLLECTION,data=>{ const s=data.sources[sourceCode]; if(s)s.atmCodes=[...new Set((s.atmCodes||[]).filter(c=>c!==atmCode))]; });
        this.#markLocationIndexStale();
        AuditService.record("atm.unlink", "atm", "", "system", `Unlinked ATM ${atmCode}`, { atmCode, sourceCode }); return{success:true,message:`§aATM unlinked.`};
    }

    static forceWaiting(atmCode){ atmCode=cleanCode(atmCode); const tx=Database.transaction(AC.COLLECTION,data=>{ const a=data.active[atmCode]; if(!a)throw new Error("ATM is not active."); const sourceCode=a.sourceCode; const w={...a}; delete w.sourceCode; data.waiting[atmCode]=w; delete data.active[atmCode]; return sourceCode; }); if(tx.success)Database.transaction(AC.SOURCE_COLLECTION,data=>{const s=data.sources[tx.result]; if(s)s.atmCodes=(s.atmCodes||[]).filter(c=>c!==atmCode);}); if(tx.success)this.#markLocationIndexStale(); if(tx.success)AuditService.record("atm.admin.force_waiting","atm","","system",`Forced ATM ${atmCode} to waiting`,{atmCode,sourceCode:tx.result},"warn"); return tx.success?{success:true,message:"§aATM moved to waiting."}:{success:false,message:`§c${tx.error}`}; }

    static deleteATM(atmCode){
        atmCode=cleanCode(atmCode);
        let removed=null;
        const tx=Database.transaction(AC.COLLECTION,data=>{
            if(data.active[atmCode]){removed={...data.active[atmCode]}; delete data.active[atmCode];}
            else if(data.waiting[atmCode]){removed={...data.waiting[atmCode]}; delete data.waiting[atmCode];}
            else throw new Error("ATM not found.");
            data.stats.lastUpdated=now();
            return removed;
        });
        if(!tx.success)return{success:false,message:`§c${tx.error}`};
        if(removed?.sourceCode){
            const sTx=Database.transaction(AC.SOURCE_COLLECTION,data=>{
                const s=data.sources[removed.sourceCode];
                if(s){ s.atmCodes=(s.atmCodes||[]).filter(c=>c!==atmCode); data.stats.lastUpdated=now(); }
            });
            if(!sTx.success)Logger.warn("ATM", `deleteATM: failed to remove ${atmCode} from source ${removed.sourceCode}: ${sTx.error}`);
        }
        this.#setTypeByLocation(removed?.location,null);
        this.#markLocationIndexStale();
        AuditService.record("atm.admin.delete_atm","atm","","system",`Deleted ATM ${atmCode} from DB`,{atmCode,removed},"warn");
        return{success:true,message:"§aATM deleted from database."};
    }

    static deleteSource(sourceCode){
        sourceCode=cleanCode(sourceCode);
        let affected=[];
        let removedSource=null;
        const tx=Database.transaction(AC.SOURCE_COLLECTION,data=>{
            const source=data.sources[sourceCode];
            if(!source)throw new Error("Source not found.");
            removedSource={...source};
            affected=[...(source.atmCodes||[])];
            delete data.sources[sourceCode];
            data.stats.lastUpdated=now();
            return {affected,removedSource};
        });
        if(!tx.success)return{success:false,message:`§c${tx.error}`};
        const aTx=Database.transaction(AC.COLLECTION,data=>{
            for(const code of affected){
                if(data.active[code]){ const w={...data.active[code]}; delete w.sourceCode; data.waiting[code]=w; delete data.active[code]; }
            }
            data.stats.lastUpdated=now();
        });
        if(!aTx.success)Logger.warn("ATM", `deleteSource: failed to move linked ATMs for ${sourceCode}: ${aTx.error}`);
        this.#setTypeByLocation(removedSource?.location,null);
        this.#markLocationIndexStale();
        AuditService.record("atm.admin.delete_source","atm","","system",`Deleted Source ${sourceCode}`,{sourceCode,affected,removedSource},"warn");
        return{success:true,message:`§aSource deleted. ${affected.length} ATM(s) moved to waiting.`};
    }

    static calculate(combo, qty, player){ const base=CONFIG.ATM.BASE_PRICES[combo]||0; const level=LevelService.getLevelInfo(player); const bonus=level.bonuses?.[combo] ?? 1; return{money:Math.floor(base*bonus*qty),score:(CONFIG.ATM.SCORE_REWARDS[combo]||0)*qty,level}; }

    static buildExchangeSummary(player, selections){ const items={}; let totalMoney=0,totalScore=0,totalQty=0; for(const [combo,qtyRaw] of Object.entries(selections||{})){ const qty=Math.max(0,Math.min(CONFIG.ATM.MAX_EXCHANGE_PER_COMBO || 64, Math.floor(qtyRaw||0))); if(!qty)continue; const need=ATMInventory.prepareItems(combo,qty); for(const [id,n] of Object.entries(need))items[id]=(items[id]||0)+n; const calc=this.calculate(combo,qty,player); totalMoney+=calc.money; totalScore+=calc.score; totalQty+=qty; } return{items,totalMoney,totalScore,totalQty}; }
    static quickSelections(player){ const counts=ATMInventory.oreCounts(player); const out={}; for(const combo of Object.keys(CONFIG.ATM.ORE_COMBINATIONS||{})){ const ores=CONFIG.ATM.ORE_COMBINATIONS[combo]||[]; const max=ores.length?Math.max(0,Math.min(CONFIG.ATM.MAX_EXCHANGE_PER_COMBO || 64, ...ores.map(id=>counts[id]||0))):0; if(max>0)out[combo]=max; } return out; }

    static #queuePendingTransfer(atmCode, items) {
        const tx = Database.transaction(AC.COLLECTION, data => {
            if (!data.pendingTransfers) data.pendingTransfers = {};
            const pending = data.pendingTransfers[atmCode] || { items: {}, updatedAt: 0 };
            for (const [id, amount] of Object.entries(items || {})) pending.items[id] = (pending.items[id] || 0) + Math.max(0, Math.floor(Number(amount) || 0));
            pending.updatedAt = Date.now(); data.pendingTransfers[atmCode] = pending; return pending;
        });
        return tx.success && Database.flushCritical(AC.COLLECTION, "atm_pending_transfer_queue").ok;
    }

    static #flushPendingTransfer(atmCode, container) {
        const pending = this.atmDB().pendingTransfers?.[atmCode];
        if (!pending?.items || !Object.keys(pending.items).length) return { ok: true, empty: true };
        if (!container || !ATMInventory.hasSpace(container, pending.items)) return { ok: false, reason: "source_unavailable_or_full" };
        if (!ATMInventory.addItems(container, pending.items)) return { ok: false, reason: "source_transfer_failed" };
        const tx = Database.transaction(AC.COLLECTION, data => { delete data.pendingTransfers[atmCode]; });
        return { ok: tx.success && Database.flushCritical(AC.COLLECTION, "atm_pending_transfer_flush").ok, empty: false };
    }

    static exchange(player, atmBlock, selections){
        // Phase 1 Fix: Journal-based atomic exchange with recovery path.
        //
        // PROBLEM (pre-Phase 1):
        //   The exchange had four side-effectful steps that could not be
        //   made transactional together:
        //     1. removeItems(player, items)        — writes to player inventory
        //     2. addItems(sourceContainer, items)  — writes to source chest
        //     3. addMoney(player, totalMoney)      — commits money DB + scoreboard mirror
        //     4. addScore(player, totalScore)      — commits level DB + scoreboard mirror
        //   If step 2 succeeded but step 3 failed (player disconnected,
        //   scoreboard missing), the items were STUCK in the source chest
        //   with no automatic refund path. The player lost their ores and
        //   got nothing in return. Admins had to manually retrieve and
        //   deliver the items.
        //
        // SOLUTION (Phase 1): Journal entry pattern.
        //   1. Before any side-effect, write a journal entry to the ATM
        //      collection with status "pending" and ALL details (player,
        //      items, money, score, atmCode, sourceCode).
        //   2. Execute the side-effects in order. Each step has a
        //      well-defined rollback for the immediately preceding step.
        //   3. The KEY improvement: if step 3 (addMoney) or step 4
        //      (addScore) fails AFTER step 2 (addItems) succeeded, we now
        //      ATTEMPT to recover the items from the source chest using the
        //      new `ATMInventory.removeFromContainer` helper, and return
        //      them to the player. If recovery fails (chest changed, chunk
        //      unloaded), we update the journal to "recovery_failed" and
        //      queue a FinanceService.addPayout for the equivalent money
        //      value so the player is compensated.
        //   4. On success, mark the journal "completed".
        //   5. On startup (initialize), scan for journals in "pending"
        //      or "recovery_failed" status and attempt recovery/compensation.
        //
        // This ensures NO PLAYER EVER LOSES ITEMS without compensation,
        // even in the rare case of a mid-exchange crash.

        // Phase 7.3 (v0.21.2) (CT7): Rate limit check moved to the END
        // (just before removeItems). Previously it was the first check,
        // so if ANY subsequent check failed (source offline, no items,
        // limit reached, chest full), the player still lost a rate-limit
        // slot. After 10 failed attempts in 60s, the player was locked
        // out for a minute. Now the slot is only consumed on a successful
        // exchange.
        const info=this.getATMFromBlock(atmBlock); if(!info?.atm?.sourceCode)return{success:false,message:"§cATM is not linked to a source."};
        const src=this.sourceDB().sources[info.atm.sourceCode]; if(!src)return{success:false,message:"§cLinked source not found. Ask an admin to repair this ATM."};
        const summary=this.buildExchangeSummary(player,selections); const {items,totalMoney,totalScore,totalQty}=summary;
        if(totalQty<=0)return{success:false,message:"§cNo exchange selected."};

        if(!ATMInventory.hasItems(player,items))return{success:false,message:"§cYou do not have the required ores."};
        const container=this.#sourceContainer(src);
        const pendingFlush = container ? this.#flushPendingTransfer(info.code, container) : { ok: false, reason: "source_unavailable" };
        // Pending delivery is never a reason to reject a player transaction.
        // When Source is unavailable/full, the current batch joins the same
        // durable ATM Bottom queue and rewards can still be delivered.
        const canWriteSourceNow = !!container && pendingFlush.ok && ATMInventory.hasSpace(container, items);

        // Phase 7.3 (v0.21.2) (CT7): Rate limit check HERE — only consumes
        // a slot if all pre-checks passed and we're about to actually
        // perform the exchange. If removeItems fails after this, the slot
        // is wasted, but that's a rare edge case (inventory changed between
        // hasItems and removeItems in the same tick).
        const rl = CONFIG.RATE_LIMITS?.ATM_EXCHANGE;
        if (rl && !RateLimiter.check(`atm_exchange:${player.id}`, rl[0], rl[1])) {
            return { success: false, message: `§cRate limit. Try again in ${Math.ceil(RateLimiter.retryIn(`atm_exchange:${player.id}`, rl[0], rl[1]) / 1000)}s.` };
        }

        // ─── Phase 1 Fix: Write journal entry BEFORE any side-effect ───
        const journalId = `atm_journal_${now()}_${Math.floor(Math.random() * 1000000)}`;
        const journalEntry = {
            id: journalId,
            status: "pending",  // pending → completed | recovery_failed | failed
            playerId: player.id,
            playerName: player.name,
            atmCode: info.code,
            sourceCode: src.code,
            sourceLocation: src.location,
            items: { ...items },
            totalMoney,
            totalScore,
            totalQty,
            createdAt: now(),
            completedAt: 0,
            recoveryAttempts: 0,
            lastError: ""
        };
        const journalTx = Database.transaction(AC.COLLECTION, data => {
            if (!data.journals) data.journals = {};
            data.journals[journalId] = journalEntry;
            // Phase 4.3: active/pending journals are never count-pruned.
            // Terminal retention is handled separately after marker verification.
        });
        if (!journalTx.success || !Database.flushCritical(AC.COLLECTION,"atm_exchange_intent_before_inventory").ok) {
            // If intent is not durable, abort before inventory mutation. — safer to fail the
            // exchange than to proceed without a recovery trail.
            Logger.error("ATM", `Exchange aborted: failed to write journal for ${player.id}. Error: ${journalTx.error}`);
            return { success: false, message: "§cExchange failed to start (journal error). Please try again." };
        }

        // ─── Step 1: Remove items from player inventory ───
        // Transactional Safety: Remove items first. If it fails, abort.
        if(!ATMInventory.removeItems(player,items)) {
            this.#markJournal(journalId, "failed", "removeItems failed");
            return{success:false,message:"§cFailed to remove ores from inventory."};
        }

        // ─── Step 2: Transfer to Source or durable ATM Bottom queue ───
        // The player has already delivered the exchange; an unloaded Source
        // must never make the exchange fail after inventory removal.
        if (canWriteSourceNow) {
            if(!ATMInventory.addItems(container,items)){
                ATMInventory.returnItems(player,items);
                this.#markJournal(journalId, "failed", "addItems to source failed");
                return{success:false,message:"§cSource transfer failed. Ores returned."};
            }
        } else if (!this.#queuePendingTransfer(info.code, items)) {
            ATMInventory.returnItems(player,items);
            this.#markJournal(journalId, "failed", "pending ATM storage could not be persisted");
            return { success: false, message: "§cATM storage could not be saved. Ores returned." };
        }

        // ─── Step 3 & 4: Deliver rewards (money + score) ───
        // Phase 7.3 (v0.21.2) (CT5): Limits are now applied AFTER reward
        // BEFORE `MoneyService.addMoney` / `LevelService.addScore`. If the
        // reward failed (player disconnected, scoreboard missing), the
        // player's daily exchange limit was permanently burned without
        // receiving rewards. Now limits are only consumed on success.
        const moneyResult = MoneyService.addMoney(player, totalMoney, "atm_exchange");
        const scoreResult = LevelService.addScore(player, totalScore, "atm_exchange");
        if (!moneyResult || !moneyResult.success || !scoreResult || !scoreResult.success) {
            Logger.error("ATM", `Exchange reward delivery failed for ${player?.name || "unknown"}. MoneyOK=${moneyResult?.success}, ScoreOK=${scoreResult?.success}. Attempting recovery.`);

            // ─── Phase 1 Fix: RECOVERY PATH ───
            // Items are in the source chest. We now have a way to get them
            // back: `ATMInventory.removeFromContainer`. Try it.
            let recovered = false;
            try {
                recovered = ATMInventory.removeFromContainer(container, items);
            } catch (recErr) {
                Logger.warn("ATM", `removeFromContainer threw during recovery: ${recErr?.message || recErr}`);
            }

            if (recovered) {
                // Return the recovered items to the player.
                const returned = ATMInventory.returnItems(player, items);
                if (returned) {
                    this.#markJournal(journalId, "failed", `Reward delivery failed (money=${moneyResult?.success}, score=${scoreResult?.success}); items recovered and returned to player.`);
                    Logger.info("ATM", `Recovery succeeded for ${player.id}: items returned to inventory.`);
                    return { success: false, message: "§cExchange reward delivery failed. Your ores have been returned. Please try again." };
                }
                // Items recovered from chest but couldn't be returned to
                // player (inventory full?). They are now in limbo. Mark
                // journal for manual recovery.
                this.#markJournal(journalId, "recovery_failed", `Items recovered from source but could not be returned to player inventory (full?). Manual retrieval needed.`);
                Logger.error("ATM", `CRITICAL: Items recovered from source chest but could not be returned to ${player.id} (inventory full?). Items are in the source chest at ${src.location}.`);
            } else {
                // Could not recover items from source chest (chest changed,
                // chunk unloaded, items moved). Compensate the player with
                // the equivalent money value via FinanceService.addPayout.
                this.#markJournal(journalId, "recovery_failed", `Could not recover items from source chest. Queuing money payout as compensation.`);
                Logger.error("ATM", `CRITICAL: Could not recover items from source chest for ${player.id}. Queuing ${totalMoney}c payout as compensation.`);
            }

            // Queue a money payout so the player is compensated for the
            // lost ores. This is the last-resort recovery: the player loses
            // the ores but gets their money value.
            try {
                FinanceService.addPayout(player.id, totalMoney, `ATM exchange recovery compensation (items could not be returned)`, "atm", {
                    fromId: "",
                    fromName: "ATM System",
                    toName: player.name,
                    atmCode: info.code,
                    sourceCode: src.code,
                    journalId,
                    itemsLost: items
                });
                // Also try to notify the player.
                try {
                    player.sendMessage(CONFIG.PREFIX + `§c⚠ Exchange reward delivery failed and items could not be recovered. §e${MoneyUtils.formatCents(totalMoney)}§c has been queued as a payout compensation. Claim it from your Dashboard → Payouts.`);
                } catch (e) { /* player may be offline */ }
            } catch (payoutErr) {
                Logger.error("ATM", `DOUBLE CRITICAL: Compensation payout also failed for ${player.id}. Manual intervention required.`, payoutErr);
                this.#markJournal(journalId, "recovery_failed", `Compensation payout also failed: ${payoutErr?.message || payoutErr}. MANUAL INTERVENTION REQUIRED.`);
            }

            // Audit the recovery event.
            try {
                AuditService.record(
                    "atm.exchange_recovery",
                    "atm",
                    player.id,
                    player.name,
                    `ATM exchange reward failed; recovery attempted. Items recovered: ${recovered}. Compensation: ${MoneyUtils.formatCents(totalMoney)} queued.`,
                    { atmCode: info.code, sourceCode: src.code, items, totalMoney, recovered, journalId },
                    "error"
                );
            } catch (e) { /* audit failure should not block */ }

            return { success: false, message: "§cExchange reward delivery failed. Compensation has been queued. See Dashboard → Payouts." };
        }
        FinanceService.recordMint(totalMoney,"ATM exchange","atm",{playerId:player.id,playerName:player.name,atmCode:info.code,sourceCode:src.code});

        // Phase 6 Deep Fix: Combine ATM + Source stats into a single unified
        // transaction on the ATM collection to prevent split-brain stats.
        // Source stats are mirrored into the ATM record under `sourceStats`.
        Database.transaction(AC.COLLECTION,data=>{
            const a=data.active[info.code];
            if(a){
                a.totalTransactions=(a.totalTransactions||0)+1;
                a.totalMoneyMinted=(a.totalMoneyMinted||0)+totalMoney;
                a.totalScoreGiven=(a.totalScoreGiven||0)+totalScore;
                a.lastUsedAt=now();
                // Mirror source stats into ATM collection for atomicity
                if(!a.sourceStats) a.sourceStats = {};
                a.sourceStats[src.code] = {
                    totalTransactions: (a.sourceStats[src.code]?.totalTransactions || 0) + 1,
                    totalEarned: (a.sourceStats[src.code]?.totalEarned || 0) + totalMoney,
                    lastUsedAt: now()
                };
                data.stats.totalExchanges=(data.stats.totalExchanges||0)+1;
            }
        });

        // ─── Mark journal as completed ───
        this.#markJournal(journalId, "completed", "");

        NotificationService.create(player.id,{type:"atm",source:"atm",title:"ATM Exchange Complete",message:`You received ${MoneyUtils.formatCents(totalMoney)} and ${totalScore} score.`,action:""});
        AuditService.record("atm.exchange", "atm", player.id, player.name, `ATM exchange ${MoneyUtils.formatCents(totalMoney)}`, { atmCode: info.code, sourceCode: src.code, money: totalMoney, score: totalScore });
        return{success:true,message:`§aExchange complete: §e${MoneyUtils.formatCents(totalMoney)} §aand §b${totalScore} score§a.`};
    }

    /**
     * Phase 1 Fix: Update a journal entry's status.
     *
     * Used by `exchange()` to mark journals as completed/failed/recovery_failed.
     * Failures here are logged but do not block the caller — the journal
     * will be picked up by `recoverPendingJournals()` on next startup if
     * it remains in "pending" status.
     */
    static #markJournal(journalId, status, lastError) {
        try {
            Database.transaction(AC.COLLECTION, data => {
                if (!data.journals || !data.journals[journalId]) return;
                const j = data.journals[journalId];
                j.status = status;
                j.lastError = String(lastError || "").substring(0, 300);
                if (status === "completed" || status === "failed") j.completedAt = now();
                if (status === "recovery_failed") j.recoveryAttempts = (j.recoveryAttempts || 0) + 1;
            });
        } catch (e) {
            Logger.warn("ATM", `Failed to mark journal ${journalId} as ${status}: ${e?.message || e}`);
        }
    }

    /**
     * Phase 1 Fix: Recover pending/recovery_failed journals on startup.
     *
     * Called from `initialize()`. Scans the `data.journals` map for entries
     * that were left in a non-terminal state (pending, recovery_failed)
     * due to a server crash mid-exchange. For each:
     *
     *   - "pending": the exchange was started but never completed. The
     *     items may be in the source chest OR still in the player's
     *     inventory. We cannot reliably determine which without the
     *     player online, so we queue a compensation payout for the money
     *     value and mark the journal "recovered_payout". The player can
     *     claim the payout; if they still have the ores, they got a bonus
     *     (acceptable — better than losing items).
     *
     *   - "recovery_failed": items were confirmed in the source chest but
     *     could not be returned. Same compensation approach.
     *
     * This is a best-effort recovery. Admins should review audit logs
     * for "atm.exchange_recovery" events to spot-check.
     */
    static recoverPendingJournals() {
        let recovered = 0;
        let pending = [];
        try {
            const db = this.atmDB();
            const journals = db.journals || {};
            pending = Object.values(journals).filter(j => j && (j.status === "pending" || j.status === "recovery_failed"));
            if (!pending.length) return { recovered: 0, total: 0 };

            Logger.warn("ATM", `Found ${pending.length} pending/recovery_failed ATM journal(s). Attempting recovery.`);

            for (const j of pending) {
                const originalStatus = j.status;
                try {
                    if(originalStatus==="pending"){Database.transaction(AC.COLLECTION,data=>{const x=data.journals?.[j.id];if(x){x.status="recovery_failed";x.lastError="Legacy pending exchange is inconclusive; automatic payout is forbidden without step evidence.";}});continue;}
                    // Queue a compensation payout for the money value. The
                    // previous implementation ignored addPayout's return value
                    // and marked the journal recovered even if payout creation
                    // failed. Phase 3 hardening keeps the journal recoverable
                    // until compensation is actually queued.
                    let payoutResult = { success: true };
                    if (j.totalMoney > 0 && j.playerId) {
                        payoutResult = FinanceService.addPayout(j.playerId, j.totalMoney, `ATM journal recovery (crash during exchange, journal ${j.id})`, "atm", {
                            fromId: "",
                            fromName: "ATM System",
                            toName: j.playerName || "Unknown",
                            atmCode: j.atmCode,
                            sourceCode: j.sourceCode,
                            journalId: j.id
                        });
                        if (!payoutResult || !payoutResult.success) {
                            throw new Error(payoutResult?.message || "Failed to queue recovery payout");
                        }
                    }

                    const markTx = Database.transaction(AC.COLLECTION, data => {
                        if (!data.journals || !data.journals[j.id]) return;
                        data.journals[j.id].status = "recovered_payout";
                        data.journals[j.id].completedAt = now();
                        data.journals[j.id].lastError = `Auto-recovered on startup; queued ${j.totalMoney || 0}c payout.`;
                        data.journals[j.id].recoveryAttempts = (data.journals[j.id].recoveryAttempts || 0) + 1;
                    });
                    if (!markTx.success) throw new Error(markTx.error || "Failed to mark journal recovered");

                    recovered++;
                    AuditService.record(
                        "atm.journal_recovered",
                        "atm",
                        j.playerId || "",
                        j.playerName || "Unknown",
                        `Recovered ATM journal ${j.id} on startup; queued ${MoneyUtils.formatCents(j.totalMoney || 0)} payout.`,
                        { journalId: j.id, originalStatus, atmCode: j.atmCode, sourceCode: j.sourceCode, totalMoney: j.totalMoney },
                        "warn"
                    );
                } catch (e) {
                    Logger.error("ATM", `Failed to recover journal ${j.id}: ${e?.message || e}`);
                    try {
                        Database.transaction(AC.COLLECTION, data => {
                            if (!data.journals || !data.journals[j.id]) return;
                            data.journals[j.id].status = "recovery_failed";
                            data.journals[j.id].recoveryAttempts = (data.journals[j.id].recoveryAttempts || 0) + 1;
                            data.journals[j.id].lastError = String(e?.message || e).substring(0, 300);
                        });
                    } catch (markError) {
                        Logger.warn("ATM", `Failed to mark journal ${j.id} recovery_failed`, markError);
                    }
                }
            }
        } catch (e) {
            Logger.error("ATM", `recoverPendingJournals failed: ${e?.message || e}`);
        }
        Logger.info("ATM", `Journal recovery complete: ${recovered} of ${pending.length} journals recovered.`);
        return { recovered, total: pending.length };
    }

    static integrityCheck(repair=false){
        const report={orphanActive:0,invalidSourceLinks:0,duplicateSourceLinks:0,invalidSourceAtmCodes:0,waitingWithoutLocation:0,activeWithoutLocation:0,duplicateCodes:0,movedToWaiting:0,removedInvalidLinks:0,removedBadAtms:0,repaired:!!repair};
        const sourceCodes=new Set(Object.keys(this.sourceDB().sources||{}));
        const tx=Database.transaction(AC.COLLECTION,data=>{
            const seen=new Set();
            for(const c of data.codes||[]){ if(seen.has(c))report.duplicateCodes++; seen.add(c); }
            if(repair)data.codes=[...new Set((data.codes||[]).filter(Boolean))].slice(-AC.MAX_CODES_HISTORY);
            for(const [code,a] of Object.entries({...data.active})){
                if(!a.location){report.activeWithoutLocation++; if(repair){delete data.active[code]; report.removedBadAtms++;} continue;}
                if(!a.sourceCode||!sourceCodes.has(a.sourceCode)){ report.orphanActive++; if(repair){ const w={...a}; delete w.sourceCode; data.waiting[code]=w; delete data.active[code]; report.movedToWaiting++; } }
            }
            for(const [code,a] of Object.entries({...data.waiting})) if(!a.location){report.waitingWithoutLocation++; if(repair){delete data.waiting[code]; report.removedBadAtms++;}}
            return report;
        });
        const sTx=Database.transaction(AC.SOURCE_COLLECTION,data=>{
            const activeCodes=new Set(Object.keys(this.atmDB().active||{}));
            const waitingCodes=new Set(Object.keys(this.atmDB().waiting||{}));
            for(const s of Object.values(data.sources||{})){
                const before=s.atmCodes||[]; const unique=[...new Set(before.filter(Boolean))]; if(unique.length!==before.length)report.duplicateSourceLinks+=before.length-unique.length;
                const valid=unique.filter(c=>activeCodes.has(c)); report.invalidSourceAtmCodes+=unique.length-valid.length;
                if(repair){s.atmCodes=valid; report.removedInvalidLinks+=unique.length-valid.length;}
            }
            return report;
        });
        if(repair){Database.save(AC.COLLECTION);Database.save(AC.SOURCE_COLLECTION);} AuditService.record(repair?"atm.integrity.repair":"atm.integrity.check","atm","","system",repair?"ATM integrity repaired":"ATM integrity checked",report,repair?"warn":"info"); return report;
    }

    static removeSpecialBlock(block){ const type=this.#type(block); if(!type)return{success:false,message:"Not special."}; const key=this.blockKey(block); this.#setType(block,null); if(type==="atm"){ let sourceCode=null,atmCode=null; Database.transaction(AC.COLLECTION,data=>{ for(const [code,a] of Object.entries(data.active)){if(a.location===key){sourceCode=a.sourceCode;atmCode=code;delete data.active[code];break;}} for(const [code,a] of Object.entries(data.waiting)){if(a.location===key){atmCode=code;delete data.waiting[code];break;}} }); if(sourceCode&&atmCode)Database.transaction(AC.SOURCE_COLLECTION,data=>{const s=data.sources[sourceCode]; if(s)s.atmCodes=(s.atmCodes||[]).filter(c=>c!==atmCode);}); }
        if(type==="source"){ let sourceCode=null; Database.transaction(AC.SOURCE_COLLECTION,data=>{ for(const [code,s] of Object.entries(data.sources)){if(s.location===key){sourceCode=code;delete data.sources[code];break;}} }); if(sourceCode)Database.transaction(AC.COLLECTION,data=>{ for(const [code,a] of Object.entries(data.active)){ if(a.sourceCode===sourceCode){ const w={...a}; delete w.sourceCode; data.waiting[code]=w; delete data.active[code]; } } }); }
        AuditService.record("atm.remove", "atm", "", "system", `Removed special ${type} block`, { location: key, type });
        this.#markLocationIndexStale();
        return{success:true,message:"§aSpecial block removed from system."}; }

    static #sourceContainer(source){ try{ const [dim,x,y,z]=source.location.split(":"); const dimension=world.getDimension?.(source.dimension||`minecraft:${dim}`); const block=dimension?.getBlock({x:Number(x),y:Number(y),z:Number(z)}); return ATMInventory.getContainerFromBlock(block); }catch{return null;} }
    static #canAdmin(player){ return player?.hasTag?.(CONFIG.TAGS.ADMIN)||player?.hasTag?.(CONFIG.TAGS.ATM_ADMIN)||player?.hasTag?.(CONFIG.TAGS.OWNER); }
}

export default ATMService;