import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const read = file => fs.readFileSync(path.join(root, file), "utf8");

const money = read("scripts/modules/economy/moneyService.js");
const payout = read("scripts/modules/finance/financePayoutService.js");
const finance = read("scripts/modules/finance/financeService.js");
const atm = read("scripts/modules/atm/atmService.js");
const contracts = read("scripts/modules/contracts/contractService.js");

// Money must protect integer arithmetic, capacity, and recovery paths.
for (const pattern of [
    /Number\.isSafeInteger/,
    /MAX_MONEY/,
    /Insufficient funds/,
    /Target balance capacity exceeded/,
    /operationId/,
    /OperationJournalService/,
    /rollback/,
    /AuditService\.record\("money\.transfer"/
]) assert.match(money, pattern, `Money safety contract missing: ${pattern}`);

// Payouts require deterministic operations, dedupe, claim locking, reservation,
// settlement checks, and recovery handlers.
for (const pattern of [
    /OperationJournalService\.registerHandler/,
    /PAYOUT_DEDUPE_CONFLICT/,
    /claimLocks/,
    /reservedAmount/,
    /claimOperationId/,
    /settlement/,
    /recover/,
    /MAX_MONEY/
]) assert.match(payout, pattern, `Payout safety contract missing: ${pattern}`);

// Treasury/finance operations must be bounded and transactional.
for (const pattern of [/Database\.transaction/, /MAX_MONEY|MAX_/, /ledger/i, /alreadyApplied/]) {
    assert.match(finance, pattern, `Finance safety contract missing: ${pattern}`);
}

// ATM operations retain journals/recovery, validation and audit; daily limits are intentionally removed.
for (const pattern of [/Database\.transaction/, /AuditService/, /journal|Journal/i, /recovery|recover/i]) {
    assert.match(atm, pattern, `ATM safety contract missing: ${pattern}`);
}
assert.doesNotMatch(atm, /ATMLimits|EXCHANGE_LIMITS/);

// Contracts must enforce per-player limits, transactional state transitions,
// rate limiting, inventory/reward safety and auditability.
for (const pattern of [
    /MAX_ACTIVE_CREATED_PER_PLAYER/,
    /MAX_ACTIVE_ACCEPTED_PER_PLAYER/,
    /Database\.transaction/,
    /RateLimiter/,
    /Contract changed/,
    /AuditService\.record/,
    /status="completed"|status = "completed"/
]) assert.match(contracts, pattern, `Contract safety contract missing: ${pattern}`);

console.log("Money, finance, payout, ATM, and contract safety checks passed.");
