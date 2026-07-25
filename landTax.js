// MCity Dashboard V2 - Land Tax Helpers
// Phase 3: Performance & Event-Driven Redesign (Yielding tax loop)
// Phase 1 Critical Fix: Deferred notifications + atomicity-safe mutation
// New Changes Phase 5 (v1.8.6): Configurable tax period + diagnostics helpers.

import { CONFIG } from "../../config.js";

const LC = CONFIG.LAND;
const DAY_MS = 24 * 60 * 60 * 1000;

export class LandTax {
    static periodMs() { return Math.max(1, Number(LC.TAX_PERIOD_HOURS || 24)) * 60 * 60 * 1000; }
    static taxPerPeriodCents() { return Math.max(0, Math.floor((LC.TAX_PER_CHUNK_PER_DAY_CENTS || 0) * (this.periodMs() / DAY_MS))); }
    static graceUntil(claim, time = Date.now()) { return (claim?.createdAt || time) + ((LC.TAX_GRACE_DAYS || 0) * DAY_MS); }

    static taxInfo(claim, time = Date.now()) {
        if (!claim) return { taxable: false, reason: "missing" };
        const periodMs = this.periodMs();
        const lastTaxAt = Number(claim.lastTaxAt) || Number(claim.createdAt) || time;
        const graceUntil = this.graceUntil(claim, time);
        const effectiveFrom = Math.max(lastTaxAt, graceUntil);
        const nextTaxAt = effectiveFrom + periodMs;
        const periodsReady = Math.max(0, Math.floor((time - effectiveFrom) / periodMs));
        return {
            taxable: periodsReady > 0,
            periodMs,
            periodHours: periodMs / (60 * 60 * 1000),
            taxPerPeriodCents: this.taxPerPeriodCents(),
            taxPerDayCents: LC.TAX_PER_CHUNK_PER_DAY_CENTS || 0,
            graceUntil,
            inGrace: time < graceUntil,
            graceRemainingMs: Math.max(0, graceUntil - time),
            lastTaxAt,
            nextTaxAt,
            nextTaxInMs: Math.max(0, nextTaxAt - time),
            periodsReady
        };
    }

    static accrueClaim(claim, time = Date.now(), options = {}) {
        if (!claim || !claim.ownerId) return 0;
        if (!claim.lastTaxAt) claim.lastTaxAt = time;
        const periodMs = this.periodMs();
        let periods = 0;

        if (options.forcePeriods && options.forcePeriods > 0) {
            periods = Math.max(0, Math.floor(Number(options.forcePeriods) || 0));
        } else {
            const age = time - claim.lastTaxAt;
            if (age < periodMs) return 0;
            periods = Math.floor(age / periodMs);
            if (periods <= 0) return 0;
        }

        const graceUntil = this.graceUntil(claim, time);
        let taxablePeriods = periods;
        if (!options.ignoreGrace && claim.lastTaxAt < graceUntil) {
            const taxableFrom = Math.max(claim.lastTaxAt, graceUntil);
            taxablePeriods = Math.max(0, Math.floor((time - taxableFrom) / periodMs));
        }

        const amount = Math.max(0, taxablePeriods * this.taxPerPeriodCents());
        if (amount > 0) claim.taxDebt = (claim.taxDebt || 0) + amount;

        // For forced admin simulation, do not push lastTaxAt into the future.
        if (options.forcePeriods && options.forcePeriods > 0) claim.lastTaxAt = time;
        else claim.lastTaxAt += periods * periodMs;
        claim.updatedAt = time;
        return amount;
    }

    static processBatch(dbData, task, limit = 25) {
        const cursorKey = String(task?.cursor?.key || "");
        const snapshotTime = Number(task?.payload?.snapshotTime) || Date.now();
        const options = task?.payload?.options || {};
        const ids = Object.keys(dbData.claims || {}).sort().filter(id => id > cursorKey).slice(0, Math.max(1, limit));
        if (!ids.length) {
            dbData.stats.lastTaxAccrual = snapshotTime;
            return { done: true, cursor: { key: cursorKey }, processed: 0, changed: 0, amount: 0, effects: [] };
        }
        let changed = 0, amount = 0;
        const effects = [];
        for (const id of ids) {
            const claim = dbData.claims[id];
            const added = this.accrueClaim(claim, snapshotTime, options);
            if (added > 0) {
                changed++;
                amount += added;
                effects.push({ playerId: claim.ownerId, claimId: claim.id, amount: added });
            }
        }
        const nextKey = ids[ids.length - 1];
        const hasMore = Object.keys(dbData.claims || {}).some(id => id > nextKey);
        if (!hasMore) dbData.stats.lastTaxAccrual = snapshotTime;
        return { done: !hasMore, cursor: { key: nextKey }, processed: ids.length, changed, amount, effects };
    }

}

export default LandTax;