import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const required = [
    "manifest.json",
    "scripts/main.js",
    "scripts/config.js",
    "scripts/core/database.js",
    "scripts/core/runtimeHandleRegistry.js"
];
for (const file of required) {
    if (!fs.existsSync(path.join(root, file))) throw new Error(`Missing production file: ${file}`);
}
const rootJavaScript = fs.readdirSync(root).filter(file => file.endsWith(".js") && file !== "eslint.config.js");
if (rootJavaScript.length) throw new Error(`Runtime JavaScript files must be under scripts/: ${rootJavaScript.join(", ")}`);
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
if (manifest.modules?.[0]?.entry !== "scripts/main.js") throw new Error("Production entry is not scripts/main.js");
if (manifest.header?.version?.join(".") !== manifest.modules?.[0]?.version?.join(".")) throw new Error("Manifest header/module versions differ");
console.log("Production preflight passed.");
