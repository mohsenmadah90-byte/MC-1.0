import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const read = relative => fs.readFileSync(path.join(root, relative), "utf8");
const exists = relative => fs.existsSync(path.join(root, relative));

assert.equal(exists("manifest.json"), true, "manifest.json is missing");
assert.equal(exists("scripts/main.js"), true, "scripts/main.js is missing");
assert.equal(exists("scripts/core/runtimeHandleRegistry.js"), true, "runtime registry is missing");
assert.equal(exists("scripts/core/subscriptionRegistry.js"), true, "subscription registry is missing");
assert.equal(exists("scripts/core/bedrockCompat.js"), true, "BedrockCompat is missing");

const manifest = JSON.parse(read("manifest.json"));
assert.equal(manifest.modules?.[0]?.entry, "scripts/main.js", "manifest entry is incorrect");
assert.equal(manifest.modules?.[0]?.type, "script", "manifest script module is missing");

const runtime = read("scripts/core/runtimeHandleRegistry.js");
assert.match(runtime, /static timeout\s*\(/, "tracked timeout API is missing");
assert.match(runtime, /system\.runTimeout\(/, "timeout must be created through Script API");
assert.match(runtime, /static shutdown\s*\(/, "runtime shutdown is missing");
assert.match(runtime, /system\.clearRun\(/, "interval/timeout cleanup is missing");
assert.match(runtime, /system\.clearJob\(/, "job cleanup is missing");

const subscriptions = read("scripts/core/subscriptionRegistry.js");
assert.match(subscriptions, /signal\.subscribe\(/, "subscription registration is missing");
assert.match(subscriptions, /signal\.unsubscribe\(/, "subscription cleanup is missing");
assert.match(subscriptions, /disposePrefix\(/, "scoped subscription cleanup is missing");

const compat = read("scripts/core/bedrockCompat.js");
for (const feature of [
    '"system.shutdown"',
    '"world.load"',
    '"player.spawn.after"',
    '"player.leave.after"'
]) assert.match(compat, new RegExp(feature.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `${feature} is not declared`);
assert.match(compat, /static signal\s*\(/, "feature signal resolver is missing");
assert.match(compat, /static report\s*\(/, "compatibility report is missing");

const main = read("scripts/main.js");
assert.match(main, /SubscriptionRegistry\.initialize\(\)/, "subscription registry is not initialized");
assert.match(main, /RuntimeHandleRegistry\.initialize\(\)/, "runtime registry is not initialized");
assert.match(main, /BedrockCompat\.subscribe\("system\.shutdown"/, "shutdown subscription is missing");
assert.match(main, /RuntimeHandleRegistry\.timeout\("Main\.playerWelcome"/, "main timeout is not tracked");
assert.match(main, /RuntimeHandleRegistry\.shutdown\(\)/, "runtime shutdown is not called");

const allJs = [];
function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".js")) allJs.push(full);
    }
}
walk(path.join(root, "scripts"));
for (const file of allJs) {
    const relative = path.relative(root, file);
    if (relative === "scripts/core/runtimeHandleRegistry.js") continue;
    const source = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(
        source,
        /system\.run(?:Interval|Timeout|Job)\(/g,
        `${relative} contains an untracked runtime scheduling call`
    );
}

console.log(`Runtime lifecycle smoke checks passed for ${allJs.length} JavaScript files.`);
