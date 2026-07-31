import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const read = file => fs.readFileSync(path.join(root, file), "utf8");

const database = read("scripts/core/database.js");
const migrations = read("scripts/core/migrations.js");
const backup = read("scripts/modules/backup/backupService.js");

// Database persistence contracts.
for (const pattern of [
    /static transaction\s*\(/,
    /static flushCritical\s*\(/,
    /static verifyAllStorage\s*\(/,
    /static recoverQuarantine\s*\(/,
    /#checksum\s*\(/,
    /#writeString(?:Sync|Job)\s*\(/,
    /revision/,
    /chunked/,
    /checksum/
]) assert.match(database, pattern, `Database contract missing: ${pattern}`);

// A write must verify the persisted payload and metadata before reporting success.
assert.match(database, /Post-write checksum verification failed/);
assert.match(database, /Post-write revision mismatch/);
assert.match(database, /Checksum mismatch/);
assert.match(database, /Missing chunk/);

// Migration contracts: clone-before-mutate, bounded chain, and failure report.
assert.match(migrations, /const candidate = clone\(source\)/);
assert.match(migrations, /MIGRATION_LOOP/);
assert.match(migrations, /MIGRATION_PATH_MISSING/);
assert.match(migrations, /source preserved/);
assert.match(migrations, /sourceChecksum/);
assert.match(migrations, /outputChecksum/);

// Backup contracts: incremental parent chain, pre-restore marker, validation,
// and restore event/audit. These guard against accidental removal of safety gates.
assert.match(backup, /type: useIncremental \? "incremental" : "full"/);
assert.match(backup, /parentBackupId/);
assert.match(backup, /restoreInProgress/);
assert.match(backup, /auto_before_restore/);
assert.match(backup, /#validateBeforeReset/);
assert.match(backup, /database\.restored/);
assert.match(backup, /backup\.restore/);

console.log("Database, migration, and backup contract checks passed.");
