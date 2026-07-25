// MCity Dashboard V2 - Backup / Restore Service
// Phase 4 Scalability: Incremental backup support — only stores the diff
// from the most recent full backup, dramatically reducing backup size and
// creation time on large servers.
// Phase 7.5 (v0.22.0): Fixed incremental-default logic (DB3), lastFull
//                     direction (DB4), incrementalCount direction (DB5),
//                     restore validation (DB6), delete cascade (DB9).
// Sharding Phase 5 (v1.9.7): metadata/blob split for backup payloads.
// Phase 6 (v1.5.6): Restore normalized validator output + safer markers.

import { CONFIG } from "../../config.js";
import { Database } from "../../core/database.js";
import { Logger } from "../../core/logger.js";
import { EventBus } from "../../core/eventBus.js";
import { DEFAULT_BACKUP_DB, validateBackupData } from "../../schemas/backupSchema.js";
import { DEFAULT_BACKUP_BLOB_DB, validateBackupBlobData } from "../../schemas/backupBlobSchema.js";
import { AuditService } from "../audit/auditService.js";
import { DisposableRegistry } from "../../core/disposableRegistry.js";

const COLLECTION="backups";
const MAX_BACKUPS=5;
const MAX_INCREMENTAL_PER_FULL=4;  // every 4 incremental backups, force a full one
const EXPORT_CHUNK_SIZE=650;
function blobCollectionName(id){return `backup_blob_${String(id||"").replace(/[^a-zA-Z0-9_]/g,"_").substring(0,80)}`;}
function now(){return Date.now();}
function backupId(){return `bak_${Date.now()}_${Math.floor(Math.random()*1000000)}`;}
function clone(o){return JSON.parse(JSON.stringify(o));}
function estimate(o){try{return JSON.stringify(o).length;}catch{return 0;}}
function bytes(str){ const out=[]; for(let i=0;i<str.length;i++){ let c=str.charCodeAt(i); if(c<0x80)out.push(c); else if(c<0x800)out.push(0xc0|(c>>6),0x80|(c&63)); else out.push(0xe0|(c>>12),0x80|((c>>6)&63),0x80|(c&63)); } return out; }
function fromBytes(bytes){ let out=""; for(let i=0;i<bytes.length;){ const b=bytes[i++]; if(b<0x80)out+=String.fromCharCode(b); else if(b<0xe0){ const b2=bytes[i++]; out+=String.fromCharCode(((b&31)<<6)|(b2&63)); } else { const b2=bytes[i++],b3=bytes[i++]; out+=String.fromCharCode(((b&15)<<12)|((b2&63)<<6)|(b3&63)); } } return out; }
function b64Encode(str){let out="";const b=bytes(str);for(let i=0;i<b.length;i+=3){const a=b[i],c=b[i+1]??0,d=b[i+2]??0,n=(a<<16)|(c<<8)|d,chars="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";out+=chars[(n>>18)&63]+chars[(n>>12)&63]+(i+1<b.length?chars[(n>>6)&63]:"=")+(i+2<b.length?chars[n&63]:"=");}return out;}
function b64Decode(s){const chars="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";s=String(s||"").replace(/[^A-Za-z0-9+/=]/g,"");const out=[];for(let i=0;i<s.length;i+=4){const e1=chars.indexOf(s[i]),e2=chars.indexOf(s[i+1]),e3=s[i+2]==="="?-1:chars.indexOf(s[i+2]),e4=s[i+3]==="="?-1:chars.indexOf(s[i+3]),n=(e1<<18)|(e2<<12)|((e3<0?0:e3)<<6)|(e4<0?0:e4);out.push((n>>16)&255);if(e3>=0)out.push((n>>8)&255);if(e4>=0)out.push(n&255);}return fromBytes(out);}

/**
 * Phase 4: Compute a shallow diff between two collections.
 * Returns { added, modified, removed } for the `players` sub-object
 * (which is the bulk of the money collection). Other fields are compared
 * by reference (full snapshot is stored for non-player fields).
 */
function diffPlayerRecords(oldSnap, newSnap) {
    const oldPlayers = oldSnap?.players || {};
    const newPlayers = newSnap?.players || {};
    const added = {};
    const modified = {};
    const removed = [];
    for (const [id, rec] of Object.entries(newPlayers)) {
        if (!oldPlayers[id]) added[id] = rec;
        else if (JSON.stringify(oldPlayers[id]) !== JSON.stringify(rec)) modified[id] = rec;
    }
    for (const id of Object.keys(oldPlayers)) {
        if (!newPlayers[id]) removed.push(id);
    }
    return { added, modified, removed };
}

export class BackupService {
    static #initialized=false;
    static initialize(){ if(this.#initialized)return; this.#initialized=true; this.db(); DisposableRegistry.registerShutdownCleanup("BackupService.lifecycle",()=>{this.#initialized=false;}); Logger.startup("Backup","Backup service initialized (incremental-aware)"); }
    static db(){ return Database.collection(COLLECTION, DEFAULT_BACKUP_DB, { validate: validateBackupData }); }

    /**
     * Phase 4: Create a backup. Automatically chooses between full and
     * incremental based on how many incremental backups have been made
     * since the last full one.
     *
     * Pass { forceFull: true } to force a full backup.
     * Pass { incremental: true } to force an incremental (will fail if no
     *   previous full backup exists).
     */
    static create(label="manual", actor="system", collections=null, options={}){
        const names=collections?.length?collections:Database.listCollections().filter(n=>n!==COLLECTION);
        const db = this.db();
        // Phase 7.5 (v0.22.0) (DB4): `db.order` is oldest-first (push appends).
        // We need the MOST RECENT full backup, not the oldest. Walk from
        // the end of the array backwards.
        const orderedBackups = (db.order || []).map(id => db.backups[id]).filter(Boolean);
        let lastFull = null;
        for (let i = orderedBackups.length - 1; i >= 0; i--) {
            if (orderedBackups[i].type === "full" || !orderedBackups[i].type) {
                lastFull = this.get(orderedBackups[i].id) || orderedBackups[i];
                break;
            }
        }
        // Phase 7.5 (v0.22.0) (DB5): Count incrementals BACKWARDS from the
        // most recent until we hit a full (or run out). This gives the
        // correct chain length since the last full.
        let incrementalCount = 0;
        for (let i = orderedBackups.length - 1; i >= 0; i--) {
            if (orderedBackups[i].type === "incremental") incrementalCount++;
            else break;  // hit a full (or legacy) — stop counting
        }

        // Phase 7.5 (v0.22.0) (DB3) CRITICAL FIX: The old condition was
        // `&& !options.incremental === false` which is equivalent to
        // `&& options.incremental` (truthy). With default `options = {}`,
        // this evaluates to `false`, so `useIncremental` was ALWAYS false.
        // The JSDoc promised "auto chooses incremental" but every backup
        // was full unless the caller explicitly passed `{ incremental: true }`.
        //
        // The fix: `&& options.incremental !== false`. Now incremental is
        // the DEFAULT when a previous full backup exists and the chain
        // cap hasn't been reached. Pass `{ incremental: false }` to force
        // full; pass `{ forceFull: true }` to force full.
        let useIncremental = !options.forceFull
            && lastFull
            && incrementalCount < MAX_INCREMENTAL_PER_FULL
            && options.incremental !== false;

        if (options.incremental === true && !lastFull) {
            Logger.warn("Backup", "Incremental requested but no full backup exists; falling back to full");
            useIncremental = false;
        }

        const snapshot={};
        const sizes={};
        const diffs={};
        let totalSize=0;

        for(const name of names){
            try {
                const data=Database.collection(name,{});
                if (useIncremental && lastFull?.collections?.[name]) {
                    // Phase 4: store only the diff for player records.
                    const diff = diffPlayerRecords(lastFull.collections[name], data);
                    diffs[name] = diff;
                    // Store the non-player fields as a full snapshot (they're small).
                    const metaOnly = { ...data, players: undefined };
                    snapshot[name] = metaOnly;
                    sizes[name] = estimate(metaOnly) + estimate(diff);
                } else {
                    snapshot[name]=clone(data);
                    sizes[name]=estimate(snapshot[name]);
                }
                totalSize+=sizes[name];
            } catch(error) {
                Logger.warn("Backup",`Snapshot failed for ${name}`,error);
            }
        }

        const id=backupId();
        const backup={
            id,
            label:String(label||"manual").substring(0,40),
            createdAt:now(),
            createdBy:String(actor||"system").substring(0,32),
            collections:snapshot,
            collectionNames:Object.keys(snapshot),
            sizes,
            totalSize,
            projectVersion:CONFIG.VERSION,
            type: useIncremental ? "incremental" : "full",
            parentBackupId: useIncremental ? lastFull.id : null,
            diffs: useIncremental ? diffs : null
        };

        const blobName = blobCollectionName(id);
        const blobData = { version: "1.0.0", backup, createdAt: backup.createdAt, size: totalSize };
        Database.collection(blobName, DEFAULT_BACKUP_BLOB_DB, { validate: validateBackupBlobData });
        const blobSaved = Database.reset(blobName, blobData);
        if (!blobSaved) return { success:false, error:"Failed to store backup blob." };

        const meta = { ...backup, collections: {}, diffs: null, storage: "blob_collection", blobCollection: blobName, blobSize: totalSize };
        const evicted=[];
        const tx=Database.transaction(COLLECTION,data=>{
            data.backups[id]=meta;
            data.order.push(id);
            while(data.order.length>MAX_BACKUPS){
                const old=data.order.shift();
                if (data.backups[old]?.blobCollection) evicted.push(data.backups[old].blobCollection);
                delete data.backups[old];
            }
            data.stats.totalCreated=(data.stats.totalCreated||0)+1;
            data.stats.lastCreatedAt=backup.createdAt;
            return meta;
        });
        if(tx.success){
            for (const col of evicted) try { Database.drop(col); } catch {}
            AuditService.record("backup.create","backup","",actor,`Backup ${id} created (${backup.type})`,{id,totalSize,type:backup.type,collections:backup.collectionNames,storage:"blob"});
        } else {
            try { Database.drop(blobName); } catch {}
        }
        return tx.success?{success:true,backup:this.get(id) || backup}:{success:false,error:tx.error};
    }

    /**
     * Phase 4: Restore a backup. If the backup is incremental, walks the
     * chain back to the most recent full backup and applies diffs in order.
     *
     * Phase 7.5 (v0.22.0) (DB6): Restore now validates the reconstructed
     * data by calling the collection's validator before committing. This
     * prevents a malformed/legacy backup from corrupting the live state.
     * Since `Database.reset` doesn't run the validator, we validate here.
     */
    static restore(id,actor="system",collections=null){
        const backup=this.get(id);
        if(!backup)return{success:false,message:"Backup not found",restored:[],failed:[]};
        const names=(collections?.length?collections:backup.collectionNames).filter(n=>backup.collections[n]);
        const restored=[],failed=[];

        // Phase 7.6 (v0.23.0) (S12): Atomic restore gate. Check for an
        // in-progress restore marker. If found, refuse to start a new
        // restore (the admin must resolve the incomplete one first).
        // This prevents two overlapping restores from corrupting state.
        const db = this.db();
        if (db.restoreInProgress) {
            const msg = `Restore already in progress (started ${new Date(db.restoreInProgress.startedAt).toLocaleString()}, collections: ${db.restoreInProgress.collections?.join(", ") || "?"}). Refusing to start a new restore.`;
            Logger.error("Backup", msg);
            AuditService.record("backup.restore.blocked", "backup", "", actor, msg, { existingRestore: db.restoreInProgress }, "error");
            return { success: false, message: msg, restored: [], failed: [] };
        }

        // Set the restore-in-progress marker BEFORE touching any collection.
        // If the server crashes during restore, the next startup will see
        // this marker and an admin can investigate.
        Database.transaction(COLLECTION, data => {
            data.restoreInProgress = {
                backupId: id,
                startedAt: now(),
                startedBy: actor,
                collections: names
            };
        });

        // Auto-create a backup before restore (always full).
        this.create(`auto_before_restore_${id}`,actor,names,{forceFull:true});

        if (backup.type === "incremental") {
            // Walk the chain: collect all incremental backups from base to this one.
            const chain = [];
            let current = backup;
            while (current) {
                chain.unshift(current);
                if (current.type === "full" || !current.parentBackupId) break;
                current = this.get(current.parentBackupId);
            }
            // Validate chain
            if (!chain[0] || chain[0].type !== "full") {
                Database.transaction(COLLECTION, data => { delete data.restoreInProgress; });
                AuditService.record("backup.restore.failed", "backup", "", actor, "Cannot restore: backup chain broken (missing full base)", { id, names }, "error");
                return { success: false, message: "Cannot restore: backup chain broken (missing full base)", restored: [], failed: names };
            }
            // Apply each backup in order.
            for (const name of names) {
                try {
                    // Start with the full base snapshot.
                    const fullBase = chain[0].collections[name];
                    if (!fullBase) { failed.push(name); continue; }
                    let reconstructed = clone(fullBase);
                    // If the full base had no `players` field, restore it as empty.
                    if (!reconstructed.players) reconstructed.players = {};
                    // Apply each incremental diff.
                    for (let i = 1; i < chain.length; i++) {
                        const diff = chain[i].diffs?.[name];
                        if (!diff) continue;
                        for (const pid of diff.removed) delete reconstructed.players[pid];
                        for (const [pid, rec] of Object.entries({...diff.added, ...diff.modified})) {
                            reconstructed.players[pid] = rec;
                        }
                        // Phase 6 (v1.5.6): Apply non-player fields stored in
                        // the incremental snapshot. Previous restore only
                        // applied player diffs, so stats/flags/treasury-like
                        // fields could roll back to the full base state.
                        const metaSnapshot = chain[i].collections?.[name];
                        if (metaSnapshot && typeof metaSnapshot === "object") {
                            for (const [k, v] of Object.entries(metaSnapshot)) {
                                if (k !== "players" && v !== undefined) reconstructed[k] = clone(v);
                            }
                        }
                    }
                    // Phase 6 (v1.5.6): Validate and commit the NORMALIZED
                    // validator output, not the raw backup payload.
                    const normalized = this.#validateBeforeReset(name, reconstructed);
                    if (normalized) {
                        if (Database.reset(name, normalized)) restored.push(name);
                        else failed.push(name);
                    } else {
                        Logger.error("Backup", `Restore validation failed for ${name} — skipping to prevent corruption.`);
                        failed.push(name);
                    }
                } catch(error){
                    Logger.error("Backup",`Restore failed for ${name}`,error);
                    failed.push(name);
                }
            }
        } else {
            // Full backup — straightforward restore.
            for(const name of names){
                try{
                    const data = clone(backup.collections[name]);
                    // Phase 6 (v1.5.6): Validate and commit the NORMALIZED
                    // validator output, not the raw backup payload.
                    const normalized = this.#validateBeforeReset(name, data);
                    if (normalized) {
                        if (Database.reset(name, normalized)) restored.push(name);
                        else failed.push(name);
                    } else {
                        Logger.error("Backup", `Restore validation failed for ${name} — skipping to prevent corruption.`);
                        failed.push(name);
                    }
                } catch(error){
                    Logger.error("Backup",`Restore failed for ${name}`,error);
                    failed.push(name);
                }
            }
        }

        Database.transaction(COLLECTION,data=>{
            data.stats.totalRestored=(data.stats.totalRestored||0)+1;
            data.stats.lastRestoredAt=now();
            // Phase 7.6 (v0.23.0) (S12): Clear the restore-in-progress marker.
            delete data.restoreInProgress;
        });
        AuditService.record("backup.restore","backup","",actor,`Backup ${id} restored`,{id,restored,failed,type:backup.type},failed.length?"warn":"info");
        // Patch 3 (v1.6.7): notify runtime services so in-memory caches,
        // scoreboards and indexes can rebuild after DB state changes.
        try { EventBus.emit("database.restored", { backupId: id, restored, failed, type: backup.type, actor, at: now() }); }
        catch (e) { Logger.warn("Backup", "database.restored event emit failed", e); }
        return{success:failed.length===0,restored,failed};
    }

    /**
     * Phase 2 Fix: Real validator for backup restore.
     *
     * PROBLEM (pre-Phase 2):
     *   `Database.reset(name, data)` BYPASSES the collection's registered
     *   validator. The old `#validateBeforeReset` only checked
     *   `typeof data === "object" && !Array.isArray(data)` — a stub that
     *   the code's own comment admitted was incomplete:
     *
     *     "A full validator would require knowing the schema, which is
     *      registered by each service. For now, we reject obviously-bad
     *      shapes (null, array, primitive)."
     *
     *   This meant a malformed/legacy backup with the right top-level
     *   shape but wrong field types (e.g., `players` as a string,
     *   `balance` as a negative number, missing required sub-objects)
     *   would be written to the live DB via `Database.reset`, corrupting
     *   state. The next `Database.transaction` call would then run the
     *   real validator, which might "self-heal" by replacing corrupted
     *   data with defaults — silently destroying player progress.
     *
     * SOLUTION (Phase 2):
     *   1. `Database.getCollectionMeta(name)` (new public method) exposes
     *      the collection's registered validator + default data.
     *   2. This helper now runs the REAL validator on the reconstructed
     *      data before calling `Database.reset`.
     *   3. If the validator throws or returns a non-object, we reject the
     *      restore for that collection and log a detailed error.
     *   4. Collections without a registered validator (e.g., the backup
     *      collection itself, or collections created with `collection(name,{})`)
     *      fall back to the structural check, but with a warning logged.
     *
     * Returns normalized data if validation passes, null if it fails.
     */
    static #validateBeforeReset(name, data) {
        try {
            // Step 1: Basic structural sanity check (reject null/array/primitive).
            if (!data || typeof data !== "object" || Array.isArray(data)) {
                Logger.error("Backup", `Restore validation: ${name} data is not a plain object — rejecting.`);
                return null;
            }

            // Step 2: Get the collection's registered validator.
            const meta = Database.getCollectionMeta(name);
            if (!meta) {
                // Collection not registered yet — this happens if the
                // service hasn't been initialized. We can't validate, so
                // we allow the restore but log a warning. The collection
                // will be created on first access with its default data,
                // and the restored data will be the starting point.
                Logger.warn("Backup", `Restore validation: collection '${name}' not registered yet — skipping schema validation (structural check only).`);
                return data;
            }

            if (!meta.validator) {
                // Collection registered without a validator (e.g., via
                // `Database.collection(name, {})`). Structural check is
                // the best we can do.
                Logger.warn("Backup", `Restore validation: collection '${name}' has no validator — structural check only.`);
                return data;
            }

            // Step 3: Run the real validator on the reconstructed data.
            // The validator signature is `validate(data, defaultData)`
            // and returns a normalized data object (or throws on failure).
            const defaultData = meta.defaultData || {};
            let validated;
            try {
                validated = meta.validator(data, defaultData);
            } catch (validatorError) {
                Logger.error("Backup", `Restore validation: validator threw for '${name}': ${validatorError?.message || validatorError} — rejecting restore.`);
                return null;
            }

            // Step 4: Validate the validator's output.
            if (!validated || typeof validated !== "object" || Array.isArray(validated)) {
                Logger.error("Backup", `Restore validation: validator for '${name}' returned non-object — rejecting restore.`);
                return null;
            }

            // Step 5: Heuristic check — ensure the validated data has at
            // least one recognizable field from the default data. This
            // catches cases where a backup from a completely different
            // schema (e.g., a money backup restored into the land
            // collection) passes the validator but is semantically wrong.
            // We check that the validated data shares at least one top-
            // level key with the default data.
            const defaultKeys = Object.keys(defaultData);
            const validatedKeys = Object.keys(validated);
            if (defaultKeys.length > 0 && validatedKeys.length > 0) {
                const hasOverlap = defaultKeys.some(k => Object.prototype.hasOwnProperty.call(validated, k));
                if (!hasOverlap) {
                    Logger.error("Backup", `Restore validation: validated data for '${name}' shares no top-level keys with the default schema (expected: ${defaultKeys.join(", ")}, got: ${validatedKeys.join(", ")}) — rejecting restore as likely wrong-collection backup.`);
                    return null;
                }
            }

            return validated;
        } catch (e) {
            Logger.error("Backup", `Restore validation error for '${name}': ${e?.message || e}`);
            return null;
        }
    }

    static list(){
        const db=this.db();
        return (db.order||[]).map(id=>db.backups[id]).filter(Boolean).reverse();
    }

    static get(id){
        const meta=this.db().backups[id]||null;
        if(!meta)return null;
        if(meta.storage==="blob_collection"&&meta.blobCollection){
            try{
                const blob=Database.collection(meta.blobCollection,DEFAULT_BACKUP_BLOB_DB,{validate:validateBackupBlobData});
                if(blob?.backup)return blob.backup;
            }catch(error){Logger.error("Backup",`Failed to hydrate backup blob ${meta.blobCollection}`,error);}
        }
        return meta;
    }

    static getMeta(id){return this.db().backups[id]||null;}

    /**
     * Phase 7.6 (v0.23.0) (S12): Clear a stuck restore-in-progress marker.
     * Called by an admin after investigating a crashed restore.
     */
    static clearRestoreMarker(actor="system"){
        const tx=Database.transaction(COLLECTION,data=>{
            const was = data.restoreInProgress;
            delete data.restoreInProgress;
            return was;
        });
        if(tx.success && tx.result){
            AuditService.record("backup.restore_marker_cleared","backup","",actor,`Cleared stuck restore marker`,{was:tx.result},"warn");
            Logger.warn("Backup", `Restore marker cleared by ${actor}. Was: ${JSON.stringify(tx.result)}`);
        }
        return tx.success ? { success: true, message: "Restore marker cleared." } : { success: false, error: tx.error };
    }

    /**
     * Phase 7.6 (v0.23.0) (S12): Check if a restore is in progress.
     */
    static isRestoreInProgress(){
        return this.db().restoreInProgress || null;
    }
    static delete(id,actor="system"){
        // Phase 7.5 (v0.22.0) (DB9): Before deleting, check for incremental
        // children that reference this backup as their parent. If found,
        // cascade-delete them (or refuse with a clear message).
        const db = this.db();
        const children = [];
        for (const [bid, b] of Object.entries(db.backups || {})) {
            if (b?.parentBackupId === id) children.push(bid);
        }
        const blobCollectionsToDrop = [id, ...children].map(bid => db.backups?.[bid]?.blobCollection).filter(Boolean);
        const tx=Database.transaction(COLLECTION,data=>{
            if(!data.backups[id])throw new Error("Backup not found");
            delete data.backups[id];
            data.order=data.order.filter(x=>x!==id);
            // Phase 7.5 (v0.22.0) (DB9): Cascade-delete orphaned children.
            for (const childId of children) {
                if (data.backups[childId]) {
                    delete data.backups[childId];
                    data.order = data.order.filter(x => x !== childId);
                }
            }
            data.stats.totalDeleted=(data.stats.totalDeleted||0)+1+children.length;
        });
        if(tx.success){
            for(const blob of blobCollectionsToDrop) try{Database.drop(blob);}catch{}
            AuditService.record("backup.delete","backup","",actor,`Backup ${id} deleted${children.length?` (and ${children.length} incremental children)`:""}`,{id,children});
        }
        return{success:tx.success,error:tx.error,deletedChildren:children};
    }

    static stats(){
        const list=this.list();
        return{
            count:list.length,
            max:MAX_BACKUPS,
            totalSize:list.reduce((a,b)=>a+(b.totalSize||0),0),
            latest:list[0]||null,
            // Phase 4: breakdown by type
            fullCount:list.filter(b=>b.type==="full"||!b.type).length,
            incrementalCount:list.filter(b=>b.type==="incremental").length
        };
    }

    static exportTextChunks(id){
        const b=this.get(id);
        if(!b)return{success:false,message:"Backup not found"};
        const payload=JSON.stringify({format:"MCITY_DASHBOARD_V2_BACKUP",backup:b});
        const enc=b64Encode(payload);
        const chunks=[];
        const total=Math.ceil(enc.length/EXPORT_CHUNK_SIZE);
        for(let i=0;i<total;i++)chunks.push(`MCITYB:${id}:${i+1}/${total}:${enc.slice(i*EXPORT_CHUNK_SIZE,(i+1)*EXPORT_CHUNK_SIZE)}`);
        return{success:true,id,total,chunks};
    }

    static importTextChunk(text,actor="system"){
        try{
            const parts=String(text).split(":");
            if(parts[0]!=="MCITYB")throw new Error("Invalid prefix");
            const importId=parts[1], [idxS,totalS]=parts[2].split("/"), chunk=parts.slice(3).join(":");
            const idx=Number(idxS),total=Number(totalS);
            const tx=Database.transaction(COLLECTION,data=>{
                if(!data.imports[importId])data.imports[importId]={parts:{},total,createdAt:now(),actor};
                data.imports[importId].parts[idx]=chunk;
                const got=Object.keys(data.imports[importId].parts).length;
                if(got<total)return{complete:false,received:got,total};
                let enc="";
                for(let i=1;i<=total;i++)enc+=data.imports[importId].parts[i];
                const decoded=JSON.parse(b64Decode(enc));
                if(decoded.format!=="MCITY_DASHBOARD_V2_BACKUP"||!decoded.backup)throw new Error("Invalid payload");
                const b=decoded.backup;
                data.backups[b.id]=b;
                data.order=data.order.filter(x=>x!==b.id);
                data.order.push(b.id);
                while(data.order.length>MAX_BACKUPS){const old=data.order.shift();delete data.backups[old];}
                delete data.imports[importId];
                return{complete:true,backupId:b.id};
            });
            return tx.success?{success:true,...tx.result}:{success:false,message:tx.error};
        }catch(error){
            return{success:false,message:error.message||String(error)};
        }
    }
}

export default BackupService;
