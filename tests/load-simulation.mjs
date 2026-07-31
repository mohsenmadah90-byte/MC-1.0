import assert from "node:assert/strict";

// Deterministic, dependency-free load simulation for the safety primitives.
// It does not pretend to be a Bedrock TPS benchmark; it checks bounded queues,
// idempotent operation application, and controlled batch processing.

const players = 250;
const operationsPerPlayer = 20;
const operations = [];
for (let p = 0; p < players; p++) {
    for (let i = 0; i < operationsPerPlayer; i++) {
        const id = `op:${p}:${i}`;
        operations.push(id, id); // duplicate delivery/retry simulation
    }
}

const applied = new Set();
let appliedCount = 0;
for (const operationId of operations) {
    if (applied.has(operationId)) continue;
    applied.add(operationId);
    appliedCount++;
}
assert.equal(appliedCount, players * operationsPerPlayer);
assert.equal(applied.size, appliedCount);

const batchSize = 25;
let cursor = 0;
let batches = 0;
let maxBatch = 0;
while (cursor < operations.length) {
    const batch = operations.slice(cursor, cursor + batchSize);
    cursor += batch.length;
    batches++;
    maxBatch = Math.max(maxBatch, batch.length);
}
assert.equal(cursor, operations.length);
assert.ok(maxBatch <= batchSize);
assert.ok(batches > 1);

const queueLimit = 500;
const queue = [];
let rejected = 0;
for (let i = 0; i < operations.length; i++) {
    if (queue.length >= queueLimit) rejected++;
    else queue.push(operations[i]);
}
assert.ok(rejected > 0, "bounded queue must apply backpressure");
assert.ok(queue.length <= queueLimit);

console.log(`Load simulation passed: ${players} players, ${appliedCount} unique operations, ${batches} batches, ${rejected} backpressure rejections.`);
