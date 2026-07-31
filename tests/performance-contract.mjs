import assert from "node:assert/strict";
import { BoundedCache } from "../scripts/core/boundedCache.js";

const cache = new BoundedCache({ maxEntries: 2, ttlMs: 100 });
cache.set("a", 1, 0);
assert.equal(cache.get("a", 50), 1);
assert.equal(cache.get("missing", 50), undefined);
assert.equal(cache.get("a", 101), undefined, "expired entries must not be returned");
cache.set("a", 1, 0);
cache.set("b", 2, 0);
cache.set("c", 3, 0);
assert.equal(cache.get("a", 1), undefined, "oldest entry must be evicted at capacity");
assert.equal(cache.get("b", 1), 2);
assert.equal(cache.get("c", 1), 3);
const stats = cache.stats();
assert.equal(stats.maxEntries, 2);
assert.ok(stats.hits >= 2);
assert.ok(stats.misses >= 2);

console.log("Bounded TTL cache and eviction checks passed.");
