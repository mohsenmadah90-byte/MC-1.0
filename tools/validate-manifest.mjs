import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const module = manifest.modules?.find(entry => entry.type === "script");
if (!module) throw new Error("Manifest has no script module");
if (module.entry !== "scripts/main.js") throw new Error(`Unexpected script entry: ${module.entry}`);
if (!fs.existsSync(path.join(root, module.entry))) throw new Error(`Missing manifest entry file: ${module.entry}`);
if (!Array.isArray(manifest.header?.version) || manifest.header.version.length !== 3) throw new Error("Invalid header version");
if (!Array.isArray(module.version) || module.version.length !== 3) throw new Error("Invalid script module version");
if (!manifest.dependencies?.some(dep => dep.module_name === "@minecraft/server")) throw new Error("Missing @minecraft/server dependency");
if (!manifest.dependencies?.some(dep => dep.module_name === "@minecraft/server-ui")) throw new Error("Missing @minecraft/server-ui dependency");
console.log(`Manifest validation passed: ${module.entry}`);
