import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const scripts = path.join(root, "scripts");
const importPattern = /(?:from\s+|import\s*\()\s*["']([^"']+)["']/g;
const files = [];
function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".js")) files.push(full);
    }
}
walk(scripts);
const errors = [];
for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(importPattern)) {
        const specifier = match[1];
        if (!specifier.startsWith(".")) continue;
        const base = path.resolve(path.dirname(file), specifier);
        if (![base, `${base}.js`, `${base}.json`].some(candidate => fs.existsSync(candidate))) {
            errors.push(`${path.relative(root, file)} -> ${specifier}`);
        }
    }
}
if (errors.length) {
    console.error(`Unresolved relative imports (${errors.length}):`);
    for (const error of errors) console.error(`- ${error}`);
    process.exit(1);
}
console.log(`Import validation passed for ${files.length} JavaScript files.`);
