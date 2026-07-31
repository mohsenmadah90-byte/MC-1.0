# Finance Ledger Migration Fix

The Bedrock log showed `finance_ledger_migration` batches taking 80–108ms against an 8ms budget. Dynamic-property serialization and durable canonical-ledger writes made the previous batch size of 50 too large.

## Change

- Reduced `CONFIG.FINANCE.LEDGER_MIGRATION_BATCH_SIZE` from 50 to 5.
- Added a hard cap of 5 entries in `FinanceLedgerService.#processLegacyMigration`, including already-persisted tasks created with the old payload.
- Preserved transaction, cursor durability, migration batch keys, checksums and domain flushes.

The next Aternos log must be checked for actual batch duration and completion time. If individual batches remain high, the next safe step is a maintenance-window migration or resumable flush cadence; the domain flush must not be removed without a durable cursor protocol.
