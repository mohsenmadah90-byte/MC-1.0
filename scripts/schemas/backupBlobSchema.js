// MCity Dashboard V2 - Backup Blob Schema
// v1.9.7: stores full backup payload outside backup metadata collection.

export const DEFAULT_BACKUP_BLOB_DB = {
    schemaVersion: 1,
    version: "1.0.0",
    backup: null,
    createdAt: 0,
    size: 0
};

export function validateBackupBlobData(data, def = DEFAULT_BACKUP_BLOB_DB) {
    const out = JSON.parse(JSON.stringify(def));
    try {
        out.version = data?.version || "1.0.0";
        out.schemaVersion = Math.max(1, Math.floor(Number(data?.schemaVersion) || Number(out.schemaVersion) || 1));
        out.backup = data?.backup && typeof data.backup === "object" && !Array.isArray(data.backup) ? data.backup : null;
        out.createdAt = Number(data?.createdAt) || Number(out.backup?.createdAt) || 0;
        out.size = Math.max(0, Math.floor(Number(data?.size) || 0));
    } catch {
        return JSON.parse(JSON.stringify(def));
    }
    return out;
}

export default { DEFAULT_BACKUP_BLOB_DB, validateBackupBlobData };
