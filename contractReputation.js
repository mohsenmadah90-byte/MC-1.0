// MCity Dashboard V2 - Contract Reputation Helpers

export class ContractReputation {
    static ensure(data, playerId, name = "Unknown") {
        if (!data.playerStats[playerId]) data.playerStats[playerId] = { playerId, name, reputation: 0, contractsCreated: 0, contractsAccepted: 0, contractsCompleted: 0, contributions: 0, itemsSubmitted: 0, totalEarnedCents: 0, totalSpentCents: 0, updatedAt: Date.now() };
        data.playerStats[playerId].name = name || data.playerStats[playerId].name;
        data.playerStats[playerId].updatedAt = Date.now();
        return data.playerStats[playerId];
    }
    static add(data, playerId, name, rep, patch = {}) {
        const s = this.ensure(data, playerId, name);
        s.reputation = Math.max(0, (s.reputation || 0) + Math.floor(rep || 0));
        for (const [k, v] of Object.entries(patch || {})) s[k] = (s[k] || 0) + v;
        s.updatedAt = Date.now();
        return s;
    }
    static rank(stats) {
        const r = stats?.reputation || 0;
        if (r >= 1000) return "§cLegend";
        if (r >= 500) return "§6Master";
        if (r >= 200) return "§bExpert";
        if (r >= 75) return "§aTrusted";
        return "§7Newcomer";
    }
}

export default ContractReputation;
