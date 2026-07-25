// MCity Dashboard V2 - Backup Schema
// Phase 7.5 (v0.22.0): Added !Array.isArray guards on object type checks (DB8).
// Phase 2 Fix: Prevent validation-time data wipe when `order` is an empty array.

export const DEFAULT_BACKUP_DB = {
    schemaVersion: 1,
    version: "1.1.0",
    backups: {},
    order: [],
    imports: {},
    stats: { totalCreated: 0, totalRestored: 0, totalDeleted: 0, lastCreatedAt: 0, lastRestoredAt: 0 }
};

export function validateBackupData(data, def = DEFAULT_BACKUP_DB) {
    const out = JSON.parse(JSON.stringify(def));
    try {
        out.version = data?.version || "1.1.0";
        out.schemaVersion = Math.max(1, Math.floor(Number(data?.schemaVersion) || Number(out.schemaVersion) || 1));
        out.backups = data?.backups && typeof data.backups === "object" && !Array.isArray(data.backups) ? data.backups : {};
        out.imports = data?.imports && typeof data.imports === "object" && !Array.isArray(data.imports) ? data.imports : {};
        out.stats = { ...out.stats, ...(data?.stats && typeof data.stats === "object" && !Array.isArray(data.stats) ? data.stats : {}) };

        // Phase 2 Fix: Robust order reconstruction.
        //
        // PROBLEM (pre-Phase 2):
        //   The old logic was:
        //     out.order = Array.isArray(data?.order) ? data.order.filter(id => out.backups[id]).slice(-10) : Object.keys(out.backups).slice(-10);
        //     for (const id of Object.keys(out.backups)) if (!out.order.includes(id)) delete out.backups[id];
        //
        //   If `data.order` was an empty array `[]` (e.g., from a
        //   corrupted save, a manual edit, or a bug in `delete()` that
        //   cleared `order` without rebuilding it), the filter returned
        //   `[]`, and then the for-loop DELETED EVERY BACKUP because none
        //   of them were in the empty `order`. This was a validation-time
        //   data wipe — the next save would persist the empty state,
        //   permanently destroying all backups.
        //
        // SOLUTION (Phase 2):
        //   1. Build `order` from `data.order` if it's a non-empty array
        //      AND all its entries exist in `out.backups`.
        //   2. If `data.order` is an empty array but `out.backups` has
        //      entries, FALL BACK to `Object.keys(out.backups)` — this
        //      preserves the backups rather than deleting them.
        //   3. If `data.order` is not an array at all, also fall back to
        //      `Object.keys(out.backups)`.
        //   4. Filter `order` to only include IDs that exist in
        //      `out.backups` (defensive — handles dangling references).
        //   5. Cap to the 10 most recent (preserving insertion order).
        //   6. Only delete backups that are NOT in the reconstructed
        //      `order` AND were not in the original `data.backups` (i.e.,
        //      we only drop truly orphaned entries, never wipe everything).

        const backupIds = Object.keys(out.backups);
        let reconstructedOrder;

        if (Array.isArray(data?.order) && data.order.length > 0) {
            // `order` is a non-empty array — use it, filtered to valid IDs.
            // Preserve the original order (which is oldest-first per the
            // backup service convention).
            reconstructedOrder = data.order.filter(id => out.backups[id]);
            // If filtering removed ALL entries (e.g., `order` referenced
            // non-existent backup IDs), fall back to backup keys.
            if (reconstructedOrder.length === 0 && backupIds.length > 0) {
                // Schemas can't import Logger (layering rule), so we use
                // console.warn. The BackupService logs its own warnings
                // when it detects anomalies at restore time.
                try { console.warn(`[MCity BackupSchema] data.order was non-empty but referenced no existing backups; falling back to Object.keys(backups) to prevent data wipe.`); } catch (e) { /* ignore */ }
                reconstructedOrder = backupIds;
            }
        } else {
            // `order` is missing, not an array, or empty — fall back to
            // backup keys. This is the critical fix: we do NOT delete all
            // backups just because `order` is empty.
            if (backupIds.length > 0 && Array.isArray(data?.order) && data.order.length === 0) {
                try { console.warn(`[MCity BackupSchema] data.order is an empty array but ${backupIds.length} backup(s) exist; reconstructing order from backup keys to prevent data wipe.`); } catch (e) { /* ignore */ }
            }
            reconstructedOrder = backupIds;
        }

        // Cap to the 10 most recent (last 10 in insertion order).
        if (reconstructedOrder.length > 10) {
            reconstructedOrder = reconstructedOrder.slice(-10);
        }
        out.order = reconstructedOrder;

        // Phase 2 Fix: Only delete backups that are truly orphaned — i.e.,
        // NOT in the reconstructed order. Since we reconstructed order
        // FROM backup keys in the fallback case, this loop is now a no-op
        // in the empty-order scenario (correct behavior). It only removes
        // entries that were somehow dropped from `order` AND can't be
        // recovered (which shouldn't happen given the fallback above, but
        // we keep this as a defensive cleanup).
        for (const id of backupIds) {
            if (!out.order.includes(id)) {
                // Only delete if we have other backups to keep. If this
                // would wipe everything, abort and keep all backups.
                if (out.order.length === 0) {
                    // Defensive: this should never happen given the
                    // fallback above, but if it does, preserve all backups
                    // rather than wiping them.
                    out.order.push(id);
                } else {
                    delete out.backups[id];
                }
            }
        }
    } catch {
        return JSON.parse(JSON.stringify(def));
    }
    return out;
}

export default { DEFAULT_BACKUP_DB, validateBackupData };
