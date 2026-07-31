import assert from "node:assert/strict";
import fs from "node:fs";
const service=fs.readFileSync("scripts/core/leaderboardSettingsService.js","utf8"); const ui=fs.readFileSync("scripts/dashboard/dashboardSystem.js","utf8"); const economy=fs.readFileSync("scripts/modules/economy/economyUI.js","utf8");
assert.match(service,/mcity_show_money_leaderboard/); assert.match(service,/mcity_show_level_leaderboard/); assert.match(ui,/Toggle Money Leaderboard/); assert.match(ui,/Toggle Level Leaderboard/); assert.match(economy,/LeaderboardSettingsService\.moneyVisible/); assert.match(economy,/LeaderboardSettingsService\.levelVisible/);
console.log("Leaderboard visibility settings checks passed.");
