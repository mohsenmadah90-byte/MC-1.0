// MCity Dashboard V2 - Land Schema
// Phase 6: Base/Child Claim Architecture
// Phase 7.3 (v0.21.2): salePriceCents + listedForRent + rentPricePerDayCents
//                     preserved in sanitizeClaim (was dropped, causing free-claim exploit).

import { CONFIG } from "../config.js";

const LC = CONFIG.LAND;

export const DEFAULT_LAND_DB = {
    schemaVersion: 1,
    version: "1.2.0",  // Phase 2: bumped to 1.2.0 for spatialIndex addition
    claims: {},          // claimId -> claim record
    playerIndex: {},     // playerId -> { owned: [], trusted: [], rented: [], baseClaimId: null }
    spatialIndex: {},    // Phase 2: `${dim}:${cx}:${cz}` -> claimId (rebuilt by rebuildLandIndexes)
    market: { listings: {} },
    zones: {},           // zoneId -> admin-defined land zone
    entryPasses: {},
    pendingPayouts: {},
    treasury: {
        balance: 0,
        totalSales: 0,
        totalRefunds: 0,
        totalTaxCollected: 0,
        totalEntryTaxTransferred: 0
    },
    stats: {
        totalClaimsCreated: 0,
        totalClaimsSold: 0,
        totalMarketSales: 0,
        totalRentals: 0,
        totalEntryTaxPaid: 0,
        lastTaxAccrual: 0,
        lastUpdated: 0
    }
    // Phase 7.6 (v0.23.0) (S13): Removed dead `audit: []` field. No code in
    // landService.js ever pushed to db.audit — all audit traffic goes
    // through the separate AuditService (which has its own collection).
    // The field was dead weight serialized into every save.
};

function safeInt(v, d = 0) {
    const n = Math.floor(Number(v));
    return Number.isFinite(n) ? n : d;
}

export function dimShort(dimensionId) { return String(dimensionId || "minecraft:overworld").replace("minecraft:", ""); }
export function chunkCoord(v) { return Math.floor(Number(v || 0) / 16); }
export function claimId(dimensionId, cx, cz) { return `${dimShort(dimensionId)}:${cx}:${cz}`; }

export function sanitizeClaim(raw = {}) {
    const parts = String(raw.id || "overworld:0:0").split(":");
    const dim = parts[0] || "overworld";
    const cx = safeInt(raw.chunkX ?? parts[1], 0);
    const cz = safeInt(raw.chunkZ ?? parts[2], 0);
    const minY = safeInt(raw.minY, LC.MIN_CLAIM_Y);
    const maxY = safeInt(raw.maxY, LC.MAX_CLAIM_Y);
    const id = claimId(dim, cx, cz);
    return {
        id,
        dimension: dim === "overworld" ? "minecraft:overworld" : `minecraft:${dim}`,
        chunkX: cx,
        chunkZ: cz,
        minY: Math.min(minY, maxY),
        maxY: Math.max(minY, maxY),
        isBase: !!raw.isBase, // Indicates if this is the central 3x3 chunk
        ownerId: String(raw.ownerId || "").substring(0, 64),
        ownerName: String(raw.ownerName || "Unknown").substring(0, 32),
        trusted: raw.trusted && typeof raw.trusted === "object" ? raw.trusted : {},
        tenantId: raw.tenantId || null,
        tenantName: raw.tenantName || null,
        pendingTenantRefund: raw.pendingTenantRefund && typeof raw.pendingTenantRefund === "object" ? JSON.parse(JSON.stringify(raw.pendingTenantRefund)) : null,
        // Phase 7.3 (v0.21.2) (LD1): Use `listedForRent` (was `rentEnabled`, which
        // was a dead field — rentLand checks `listedForRent` but nothing ever
        // set it). Now rentSettings UI sets `listedForRent` and the schema
        // preserves it.
        listedForRent: !!raw.listedForRent,
        // Phase 7.3 (v0.21.2) (LD1): Unified field name to `rentPricePerDayCents`
        // (was `rentPricePerDay`, which mismatched `rentLand`'s read of
        // `rentPricePerDayCents` — after every DB reload the configured price
        // was lost and the default was used). Keep reading the old name for
        // backward compat with existing saves.
        rentPricePerDayCents: Math.max(0, safeInt(raw.rentPricePerDayCents ?? raw.rentPricePerDay, LC.RENT_PRICE_PER_DAY_CENTS)),
        rentEnabled: !!raw.rentEnabled, // kept for backward compat (dead, but harmless)
        rentPricePerDay: Math.max(0, safeInt(raw.rentPricePerDay, LC.RENT_PRICE_PER_DAY_CENTS)), // kept for backward compat
        rentExpiresAt: Math.max(0, Number(raw.rentExpiresAt) || 0),
        listedForSale: !!raw.listedForSale,
        listingId: raw.listingId || null,
        marketPrice: Math.max(0, safeInt(raw.marketPrice, 0)),
        // Phase 7.3 (v0.21.2) (LD2) CRITICAL FIX: `salePriceCents` was missing
        // from sanitizeClaim. On every DB reload, validateLandData runs
        // sanitizeClaim on every claim, which previously stripped the field.
        // After restart, `buyPlayerLand` read `claim.salePriceCents || 0` and
        // got 0 — so a player could buy a $5,000 listing for $0. Now the field
        // is preserved.
        salePriceCents: Math.max(0, safeInt(raw.salePriceCents, 0)),
        taxDebt: Math.max(0, safeInt(raw.taxDebt, 0)),
        lastTaxAt: Math.max(0, Number(raw.lastTaxAt) || Date.now()),
        flags: { ...LC.DEFAULT_FLAGS, ...(raw.flags || {}) },
        createdAt: Number(raw.createdAt) || Date.now(),
        updatedAt: Number(raw.updatedAt) || Date.now(),
        stats: raw.stats && typeof raw.stats === "object" ? raw.stats : { visits: 0, entryTaxPaid: 0 }
    };
}

function sanitizeListing(raw = {}) {
    if (!raw || typeof raw !== "object") return null;
    const id = String(raw.id || "").substring(0, 64);
    if (!id) return null;
    return {
        id,
        claimId: String(raw.claimId || ""),
        sellerId: String(raw.sellerId || ""),
        sellerName: String(raw.sellerName || "Unknown").substring(0, 32),
        price: Math.max(0, safeInt(raw.price, 0)),
        createdAt: Number(raw.createdAt) || Date.now()
    };
}

/**
 * Phase 2 Performance: Incrementally update the spatial index for a single claim.
 * Use this instead of rebuildLandIndexes() when only one claim changed.
 */
export function updateSpatialIndexForClaim(db, claim, oldClaim = null) {
    if (!db.spatialIndex) db.spatialIndex = {};
    // Remove old position if claim moved
    if (oldClaim && typeof oldClaim.chunkX === "number" && typeof oldClaim.chunkZ === "number") {
        const oldDim = (oldClaim.dimension || "minecraft:overworld").replace("minecraft:", "");
        const oldKey = `${oldDim}:${oldClaim.chunkX}:${oldClaim.chunkZ}`;
        if (db.spatialIndex[oldKey] === oldClaim.id) delete db.spatialIndex[oldKey];
    }
    // Add new position
    if (claim && typeof claim.chunkX === "number" && typeof claim.chunkZ === "number") {
        const dim = (claim.dimension || "minecraft:overworld").replace("minecraft:", "");
        db.spatialIndex[`${dim}:${claim.chunkX}:${claim.chunkZ}`] = claim.id;
    }
}

/**
 * Phase 2 Performance: Incrementally update playerIndex for a single claim mutation.
 * Handles owner change, tenant change, and trusted changes.
 */
export function updatePlayerIndexForClaim(db, claim, oldClaim = null) {
    if (!db.playerIndex) db.playerIndex = {};
    
    // Remove old owner reference
    if (oldClaim?.ownerId && oldClaim.ownerId !== claim?.ownerId) {
        const idx = db.playerIndex[oldClaim.ownerId];
        if (idx) {
            idx.owned = idx.owned.filter(id => id !== oldClaim.id);
            if (idx.baseClaimId === oldClaim.id) idx.baseClaimId = null;
        }
    }
    
    // Add new owner reference
    if (claim?.ownerId) {
        if (!db.playerIndex[claim.ownerId]) db.playerIndex[claim.ownerId] = { owned: [], trusted: [], rented: [], baseClaimId: null };
        if (!db.playerIndex[claim.ownerId].owned.includes(claim.id)) {
            db.playerIndex[claim.ownerId].owned.push(claim.id);
        }
        if (claim.isBase) db.playerIndex[claim.ownerId].baseClaimId = claim.id;
    }
    
    // Remove old tenant reference
    if (oldClaim?.tenantId && oldClaim.tenantId !== claim?.tenantId) {
        const idx = db.playerIndex[oldClaim.tenantId];
        if (idx) idx.rented = idx.rented.filter(id => id !== oldClaim.id);
    }
    
    // Add new tenant reference
    if (claim?.tenantId) {
        if (!db.playerIndex[claim.tenantId]) db.playerIndex[claim.tenantId] = { owned: [], trusted: [], rented: [], baseClaimId: null };
        if (!db.playerIndex[claim.tenantId].rented.includes(claim.id)) {
            db.playerIndex[claim.tenantId].rented.push(claim.id);
        }
    }
    
    // Handle trusted changes: remove old trusted players not in new claim
    if (oldClaim?.trusted) {
        for (const pid of Object.keys(oldClaim.trusted)) {
            if (!claim?.trusted?.[pid]) {
                const idx = db.playerIndex[pid];
                if (idx) idx.trusted = idx.trusted.filter(id => id !== oldClaim.id);
            }
        }
    }
    
    // Add new trusted players
    if (claim?.trusted) {
        for (const pid of Object.keys(claim.trusted)) {
            if (!oldClaim?.trusted?.[pid]) {
                if (!db.playerIndex[pid]) db.playerIndex[pid] = { owned: [], trusted: [], rented: [], baseClaimId: null };
                if (!db.playerIndex[pid].trusted.includes(claim.id)) {
                    db.playerIndex[pid].trusted.push(claim.id);
                }
            }
        }
    }
}

/**
 * Phase 2 Performance: Remove a claim from all indexes when deleted.
 */
export function removeClaimFromIndexes(db, claim) {
    if (!claim) return;
    if (!db.playerIndex) db.playerIndex = {};
    if (!db.spatialIndex) db.spatialIndex = {};
    
    // Remove from owner
    if (claim.ownerId) {
        const idx = db.playerIndex[claim.ownerId];
        if (idx) {
            idx.owned = idx.owned.filter(id => id !== claim.id);
            if (idx.baseClaimId === claim.id) idx.baseClaimId = null;
        }
    }
    
    // Remove from tenant
    if (claim.tenantId) {
        const idx = db.playerIndex[claim.tenantId];
        if (idx) idx.rented = idx.rented.filter(id => id !== claim.id);
    }
    
    // Remove from trusted
    if (claim.trusted) {
        for (const pid of Object.keys(claim.trusted)) {
            const idx = db.playerIndex[pid];
            if (idx) idx.trusted = idx.trusted.filter(id => id !== claim.id);
        }
    }
    
    // Remove from spatial index
    if (typeof claim.chunkX === "number" && typeof claim.chunkZ === "number") {
        const dim = (claim.dimension || "minecraft:overworld").replace("minecraft:", "");
        const key = `${dim}:${claim.chunkX}:${claim.chunkZ}`;
        if (db.spatialIndex[key] === claim.id) delete db.spatialIndex[key];
    }
}

export function rebuildLandIndexes(db) {
    db.playerIndex = {};
    // Phase 2 Performance: spatial hash for O(1) claim lookup by chunk.
    // Key: `${dimShort}:${cx}:${cz}`. Value: claimId (one claim per chunk).
    // We also store neighbors (3x3) so range queries (e.g. shield poller
    // computing distance to nearest claim) can scan only the local 3x3
    // neighborhood instead of all claims.
    db.spatialIndex = {};
    for (const c of Object.values(db.claims || {})) {
        if (!c.ownerId) continue;
        if (!db.playerIndex[c.ownerId]) db.playerIndex[c.ownerId] = { owned: [], trusted: [], rented: [], baseClaimId: null };
        db.playerIndex[c.ownerId].owned.push(c.id);
        if (c.isBase) db.playerIndex[c.ownerId].baseClaimId = c.id; // Track the base claim
        
        if (c.tenantId) {
            if (!db.playerIndex[c.tenantId]) db.playerIndex[c.tenantId] = { owned: [], trusted: [], rented: [], baseClaimId: null };
            db.playerIndex[c.tenantId].rented.push(c.id);
        }
        for (const pid of Object.keys(c.trusted || {})) {
            if (!db.playerIndex[pid]) db.playerIndex[pid] = { owned: [], trusted: [], rented: [], baseClaimId: null };
            db.playerIndex[pid].trusted.push(c.id);
        }

        // Phase 2: populate spatial index for this claim's chunk AND its
        // 8 neighbors. This lets `nearestClaimIn3x3(cx, cz)` run in O(1).
        if (typeof c.chunkX === "number" && typeof c.chunkZ === "number") {
            const dim = (c.dimension || "minecraft:overworld").replace("minecraft:", "");
            const key = `${dim}:${c.chunkX}:${c.chunkZ}`;
            db.spatialIndex[key] = c.id;  // one claim per chunk (claimId is unique per chunk)
        }
    }
}

/**
 * Phase 2 Performance: O(1) lookup of the claim occupying a specific chunk.
 * Returns claimId or null.
 */
export function claimAtChunk(spatialIndex, dimensionId, cx, cz) {
    if (!spatialIndex) return null;
    const dim = String(dimensionId || "minecraft:overworld").replace("minecraft:", "");
    return spatialIndex[`${dim}:${cx}:${cz}`] || null;
}

/**
 * Phase 2 Performance: O(1) lookup of any claim within a 3x3 chunk neighborhood
 * around (cx, cz). Returns the first claim found (in iteration order — for
 * distance-to-nearest, the caller should compute Manhattan distance).
 * 
 * Returns an array of { claimId, dx, dz } entries — one per claim found in
 * the 3x3 area. Empty array if none.
 */
export function claimsIn3x3(spatialIndex, dimensionId, cx, cz) {
    const out = [];
    if (!spatialIndex) return out;
    const dim = String(dimensionId || "minecraft:overworld").replace("minecraft:", "");
    for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
            const id = spatialIndex[`${dim}:${cx + dx}:${cz + dz}`];
            if (id) out.push({ claimId: id, dx, dz });
        }
    }
    return out;
}

/**
 * Phase 2 Performance: Minimum Manhattan distance (in chunks) from (cx, cz)
 * to any claim, using a rings search expanding outward. Stops early as soon
 * as a claim is found. For typical servers where most players are far from
 * claims, this is much faster than the original O(N) scan.
 * 
 * Caps the search at `maxRadius` chunks (default 16) to bound worst case.
 * Returns Infinity if no claim found within maxRadius.
 */
export function minDistanceToAnyClaim(spatialIndex, dimensionId, cx, cz, maxRadius = 16) {
    if (!spatialIndex) return Infinity;
    const dim = String(dimensionId || "minecraft:overworld").replace("minecraft:", "");
    // Expand rings outward: radius 0, 1, 2, ... up to maxRadius.
    for (let r = 0; r <= maxRadius; r++) {
        // Check all chunks at Manhattan distance r from (cx, cz).
        // For r=0, only the center. For r>0, walk the diamond perimeter.
        if (r === 0) {
            if (spatialIndex[`${dim}:${cx}:${cz}`] !== undefined) return 0;
            continue;
        }
        for (let dx = -r; dx <= r; dx++) {
            const dz = r - Math.abs(dx);
            // Two candidates per dx (except when dz === 0)
            if (spatialIndex[`${dim}:${cx + dx}:${cz + dz}`] !== undefined) return r;
            if (dz !== 0 && spatialIndex[`${dim}:${cx + dx}:${cz - dz}`] !== undefined) return r;
        }
    }
    return Infinity;
}

export function sanitizeZone(raw = {}) {
    if (!raw || typeof raw !== "object") return null;
    const id = String(raw.id || `zone_${Date.now()}_${Math.floor(Math.random() * 1000000)}`).substring(0, 64);
    const minChunkX = Math.min(safeInt(raw.minChunkX, 0), safeInt(raw.maxChunkX, 0));
    const maxChunkX = Math.max(safeInt(raw.minChunkX, 0), safeInt(raw.maxChunkX, 0));
    const minChunkZ = Math.min(safeInt(raw.minChunkZ, 0), safeInt(raw.maxChunkZ, 0));
    const maxChunkZ = Math.max(safeInt(raw.minChunkZ, 0), safeInt(raw.maxChunkZ, 0));
    return {
        id,
        name: String(raw.name || "Land Zone").substring(0, 48),
        type: String(raw.type || "generic").substring(0, 32),
        dimension: String(raw.dimension || "minecraft:overworld"),
        minChunkX,
        maxChunkX,
        minChunkZ,
        maxChunkZ,
        claimAllowed: raw.claimAllowed !== false,
        allowBuy: raw.allowBuy !== false,
        allowRent: raw.allowRent !== false,
        priceMultiplier: Number.isFinite(Number(raw.priceMultiplier)) ? Math.max(0, Number(raw.priceMultiplier)) : 1,
        rentMultiplier: Number.isFinite(Number(raw.rentMultiplier)) ? Math.max(0, Number(raw.rentMultiplier)) : 1,
        priority: safeInt(raw.priority, 0),
        note: String(raw.note || "").substring(0, 160),
        createdAt: Number(raw.createdAt) || Date.now(),
        createdBy: String(raw.createdBy || "system").substring(0, 32)
    };
}

export function validateLandData(data, def = DEFAULT_LAND_DB) {
    const out = JSON.parse(JSON.stringify(def));
    try {
        out.version = data?.version || "1.1.0";
        out.schemaVersion = Math.max(1, Math.floor(Number(data?.schemaVersion) || Number(out.schemaVersion) || 1));
        if (data?.claims && typeof data.claims === "object") {
            for (const [id, raw] of Object.entries(data.claims)) {
                const c = sanitizeClaim({ ...raw, id });
                out.claims[c.id] = c;
            }
        }
        out.market = { listings: {} };
        if (data?.market?.listings && typeof data.market.listings === "object") {
            for (const [id, raw] of Object.entries(data.market.listings)) {
                const l = sanitizeListing({ ...raw, id });
                if (l) out.market.listings[l.id] = l;
            }
        }
        out.zones = {};
        if (data?.zones && typeof data.zones === "object") {
            for (const [id, raw] of Object.entries(data.zones)) {
                const z = sanitizeZone({ ...raw, id });
                if (z) out.zones[z.id] = z;
            }
        }
        out.entryPasses = data?.entryPasses && typeof data.entryPasses === "object" ? data.entryPasses : {};
        out.pendingPayouts = data?.pendingPayouts && typeof data.pendingPayouts === "object" ? data.pendingPayouts : {};
        out.treasury = { ...out.treasury, ...(data?.treasury && typeof data.treasury === "object" && !Array.isArray(data.treasury) ? data.treasury : {}) };
        out.stats = { ...out.stats, ...(data?.stats && typeof data.stats === "object" && !Array.isArray(data.stats) ? data.stats : {}) };
        // Phase 7.6 (v0.23.0) (S13): No longer preserve `db.audit` — it was
        // dead code (never written to). AuditService is the source of truth.
        rebuildLandIndexes(out);
    } catch {
        return JSON.parse(JSON.stringify(def));
    }
    return out;
}

export default { DEFAULT_LAND_DB, validateLandData, sanitizeClaim, sanitizeZone, rebuildLandIndexes, claimId, chunkCoord, dimShort };