export const DEFAULT_CUSTOM_CARD_DB = { schemaVersion: 1, cards: {}, stats: { issued: 0, revoked: 0, lastUpdated: 0 } };

export function validateCustomCardData(data, def = DEFAULT_CUSTOM_CARD_DB) {
    const out = JSON.parse(JSON.stringify(def));
    out.cards = {};
    for (const [id, raw] of Object.entries(data?.cards || {})) {
        if (!raw || typeof raw !== "object") continue;
        out.cards[String(id).slice(0, 96)] = {
            cardId: String(raw.cardId || id).slice(0, 96),
            ownerId: String(raw.ownerId || "").slice(0, 128),
            ownerName: String(raw.ownerName || "").slice(0, 64),
            color: String(raw.color || "").slice(0, 24),
            version: Math.max(1, Math.floor(Number(raw.version) || 1)),
            createdAt: Math.max(0, Number(raw.createdAt) || 0),
            revoked: raw.revoked === true,
            revokedAt: Math.max(0, Number(raw.revokedAt) || 0)
        };
    }
    out.stats = { ...out.stats, ...(data?.stats || {}) };
    out.stats.issued = Object.keys(out.cards).length;
    return out;
}
