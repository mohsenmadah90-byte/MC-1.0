// MCity Dashboard V2 - Audit / Health Service
// Phase 2 Performance: Use RingBuffer for O(1) event append instead of
// array.push(...).slice(-N) which allocated a new 3000-entry array every push.
// Phase 4 Scalability: Global rate limit to prevent audit event flooding.
// Phase 5 Polish: Sanitize actor names and messages to prevent §-injection.

import { world } from "@minecraft/server";
import { CONFIG } from "../../config.js";
import { Database } from "../../core/database.js";
import { Logger } from "../../core/logger.js";
import { RingBuffer } from "../../core/ringBuffer.js";
import { DisposableRegistry } from "../../core/disposableRegistry.js";
import { RateLimiter } from "../../core/rateLimiter.js";
import { Sanitizer } from "../../core/sanitizer.js";
import { PlayerRegistry } from "../../core/playerRegistry.js";
import { DEFAULT_AUDIT_DB, validateAuditData } from "../../schemas/auditSchema.js";

const COLLECTION = "audit";
const MAX_EVENTS = 3000;
const MAX_SNAPSHOTS = 100;
function now(){return Date.now();}
function eventId(){return `aud_${Date.now()}_${Math.floor(Math.random()*1000000)}`;}
function safeMeta(meta){try{const j=JSON.stringify(meta||{});return j.length>1000?{truncated:true,preview:j.slice(0,1000)}:JSON.parse(j);}catch{return{};}}

export class AuditService {
    static #initialized=false;
    /**
     * Phase 2 Performance: in-memory RingBuffer mirror of `data.events`.
     * The DB still stores events as a plain array (for JSON serialization),
     * but the live buffer is what we mutate on every record() call to
     * avoid the O(N) slice allocation that the original code did.
     */
    static #eventBuffer = new RingBuffer(MAX_EVENTS);
    static #bufferLoaded = false;

    static initialize(){
        if(this.#initialized)return;
        this.#initialized=true;
        this.db();
        // Phase 2: hydrate the ring buffer from the loaded DB array.
        if (!this.#bufferLoaded) {
            const db = this.db();
            this.#eventBuffer = RingBuffer.fromArray(db.events || [], MAX_EVENTS);
            this.#bufferLoaded = true;
        }
        // Register cleanup so a reload rehydrates from a fresh DB snapshot.
        DisposableRegistry.registerShutdownCleanup("AuditService.eventBuffer", () => {
            this.#eventBuffer = new RingBuffer(MAX_EVENTS);
            this.#bufferLoaded = false;
            this.#initialized = false;
        });
        Logger.startup("Audit","Audit service initialized");
    }
    static db(){ return Database.collection(COLLECTION, DEFAULT_AUDIT_DB, { validate: validateAuditData }); }

    static record(type, source="system", actorId="", actorName="", message="", meta={}, severity="info"){
        // Phase 4: Global rate limit to prevent audit event flooding.
        const rl = CONFIG.RATE_LIMITS?.AUDIT_GLOBAL;
        if (rl && !RateLimiter.check("audit_global", rl[0], rl[1])) {
            return null;  // silently drop
        }
        // Phase 5: Sanitize all user-controllable fields.
        const event={ id:eventId(), time:now(),
            type: Sanitizer.sanitizeKey(type, 80),
            source: Sanitizer.sanitizeKey(source, 64),
            severity: Sanitizer.sanitizeKey(severity, 20),
            actorId: Sanitizer.sanitizeText(actorId, 64),
            actorName: Sanitizer.sanitizeName(actorName, 32),
            message: Sanitizer.sanitizeMessage(message, 240),
            meta: safeMeta(meta)
        };
        // Phase 2: ensure buffer is hydrated (initialize may not have run yet
        // if a record() sneaks in early via another module's init).
        if (!this.#bufferLoaded) {
            const db = this.db();
            this.#eventBuffer = RingBuffer.fromArray(db.events || [], MAX_EVENTS);
            this.#bufferLoaded = true;
        }
        // O(1) push into the ring buffer.
        this.#eventBuffer.push(event);
        // Phase 7.6 (v0.23.0) (S10): Use appendArray fast-path instead of
        // Database.transaction. The old code cloned the entire audit DB
        // (3000+ events, 100-300KB) on every record() call. At 500/sec
        // that's 50-150MB/sec of allocation. appendArray writes directly
        // to the raw data without cloning, reducing overhead ~100×.
        // Trade-off: not atomic (crash between append and save may lose
        // the event), but audit is best-effort, not financial.
        const appended = Database.appendArray(COLLECTION, "events", event, (raw) => {
            // Counter updates (in-place, no clone).
            if (!raw.counters) raw.counters = {};
            raw.counters[event.type] = (raw.counters[event.type] || 0) + 1;
            if (!raw.sourceCounters) raw.sourceCounters = {};
            raw.sourceCounters[event.source] = (raw.sourceCounters[event.source] || 0) + 1;
            if (!raw.severityCounters) raw.severityCounters = {};
            raw.severityCounters[event.severity] = (raw.severityCounters[event.severity] || 0) + 1;
            if (!raw.stats) raw.stats = { totalEvents: 0, lastEventAt: 0, lastHealthAt: 0 };
            raw.stats.totalEvents = (raw.stats.totalEvents || 0) + 1;
            raw.stats.lastEventAt = event.time;
        });
        return appended ? event : null;
    }

    static recent(limit=20, filter=null){
        // Phase 2: read from the in-memory ring buffer (O(limit)) instead of
        // cloning the entire db.events array and slicing it.
        // Phase 7.7 (v1.0.0): Expand the search window iteratively when
        // filtering, so sparse filters (e.g., "backup.delete" when 99% of
        // events are "money.transfer") can find older matches. The old code
        // over-fetched by a fixed 5× which was too small for sparse filters.
        const max = Math.max(1, Math.min(100, limit));
        if (!filter) {
            const slice = this.#bufferLoaded
                ? this.#eventBuffer.recentN(max)
                : (this.db().events || []).slice(-max).reverse();
            return slice.slice(0, max);
        }
        // Filtering: expand the window until we have `max` matches or
        // exhaust the buffer.
        const filterLower = String(filter).toLowerCase();
        const out = [];
        let windowSize = max * 2;  // start with 2× and double until enough
        const bufferSize = this.#bufferLoaded ? this.#eventBuffer.size : (this.db().events || []).length;
        while (out.length < max && windowSize <= bufferSize) {
            const slice = this.#bufferLoaded
                ? this.#eventBuffer.recentN(windowSize)
                : (this.db().events || []).slice(-windowSize).reverse();
            out.length = 0;
            for (const e of slice) {
                if (!e) continue;
                if (String(e.type || "").toLowerCase().includes(filterLower)
                    || String(e.source || "").toLowerCase().includes(filterLower)
                    || String(e.actorName || "").toLowerCase().includes(filterLower)) {
                    out.push(e);
                    if (out.length >= max) break;
                }
            }
            if (out.length >= max) break;
            windowSize *= 2;
        }
        return out.slice(0, max);
    }

    static stats(){
        const db=this.db();
        const storedCount = this.#bufferLoaded ? this.#eventBuffer.size : (db.events || []).length;
        return {
            totalEvents: db.stats.totalEvents || 0,
            storedEvents: storedCount,
            counters: db.counters || {},
            sourceCounters: db.sourceCounters || {},
            severityCounters: db.severityCounters || {},
            healthSnapshots: (db.healthSnapshots || []).length,
            lastEventAt: db.stats.lastEventAt || 0,
            lastHealthAt: db.stats.lastHealthAt || 0
        };
    }

    static createHealthSnapshot(reason="manual"){
        const collections=Database.listCollections();
        const collectionStats={};
        for(const name of collections){ const st=Database.stats(name); if(st)collectionStats[name]={size:st.size,itemCount:st.itemCount,dirty:st.dirty,lastSave:st.lastSave}; }
        // Phase 6 Deep Fix: Use PlayerRegistry.onlineMap().size to avoid
        // allocating a new array on every health snapshot.
        const snap={ time:now(), reason, onlinePlayers:PlayerRegistry.onlineMap().size, collections:collectionStats };
        const tx=Database.transaction(COLLECTION,data=>{ if(!Array.isArray(data.healthSnapshots))data.healthSnapshots=[]; data.healthSnapshots.push(snap); data.healthSnapshots=data.healthSnapshots.slice(-MAX_SNAPSHOTS); data.stats.lastHealthAt=snap.time; return snap; });
        return tx.success?tx.result:snap;
    }

    static formatStats(){
        const s=this.stats();
        const top=Object.entries(s.counters).sort((a,b)=>b[1]-a[1]).slice(0,8).map(([k,v])=>`§7${k}: §f${v}`).join("\n");
        return `§6§lAudit Stats\n§bTotal: §f${s.totalEvents} §8| §7Stored: §f${s.storedEvents}\n§bHealth Snapshots: §f${s.healthSnapshots}\n\n§6Top Events:\n${top||"§8None"}`;
    }
}

export default AuditService;
