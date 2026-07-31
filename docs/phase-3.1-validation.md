# Phase 3.1 Database, Migration and Backup Validation

## Automated validation

- Database/migration/backup contract checks passed.
- Runtime lifecycle smoke checks passed for 108 JavaScript files.
- All relative imports resolve.
- All JavaScript files pass `node --check`.
- `manifest.json` passes JSON validation.

## Verified Database contracts

- Transactions and critical flush are present.
- Revision tracking is present.
- Chunk metadata and chunk reconstruction are present.
- Checksums are verified on read and after write.
- Post-write revision and payload verification are present.
- Storage verification and quarantine recovery are present.
- Oversized payload protection is present in the save worker.

## Verified Migration contracts

- Migration operates on a clone of source data.
- Migration chains are bounded to prevent loops.
- Missing migration paths return a structured failure.
- Source checksum and output checksum are recorded.
- Failed migrations preserve the source data.

## Verified Backup contracts

- Full/incremental backup distinction is present.
- Incremental backups track a parent backup.
- Restore creates an automatic pre-restore backup.
- Restore uses an in-progress marker to prevent overlapping restores.
- Restored data is validated before `Database.reset`.
- Restore emits audit records and a database-restored event.

## Bedrock-only follow-up

A live Bedrock world is still required to test Dynamic Property limits, write interruption, world restart, real backup/restore, and corruption recovery. These cannot be proven by Node static checks alone.
