// MCity Dashboard V2 - Dynamic Market Pricing

import { CONFIG } from "../../config.js";

const MC = CONFIG.MARKET;
const HISTORY_LIMIT = MC.PRICE.HISTORY_LIMIT;

function clamp(v, min, max) { return Math.min(Math.max(v, min), max); }
function now() { return Date.now(); }

export class MarketPricing {
    static calculate(item) {
        if (!MC.PRICE.DYNAMIC_ENABLED) return { buyPrice: item.baseBuyPrice, sellPrice: item.baseSellPrice, multiplier: 1 };
        const stock = Math.max(0, item.stock || 0);
        const target = Math.max(1, item.targetStock || 1);
        const pressure = (target - stock) / target;
        const raw = 1 + pressure * MC.PRICE.ELASTICITY;
        const multiplier = clamp(raw, MC.PRICE.MIN_MULTIPLIER, MC.PRICE.MAX_MULTIPLIER);
        const buyPrice = clamp(Math.floor((item.baseBuyPrice || 0) * multiplier), item.minPrice || 0, item.maxPrice || Number.MAX_SAFE_INTEGER);
        const sellPrice = Math.max(0, Math.floor((item.baseSellPrice || 0) * multiplier));
        return { buyPrice, sellPrice, multiplier };
    }

    static updateItem(item, pushHistory = false) {
        const old = item.buyPrice || item.baseBuyPrice || 0;
        const calc = this.calculate(item);
        const maxChange = MC.PRICE.MAX_CHANGE_PER_UPDATE;
        if (old > 0 && maxChange > 0) {
            const low = Math.floor(old * (1 - maxChange));
            const high = Math.ceil(old * (1 + maxChange));
            item.buyPrice = clamp(calc.buyPrice, low, high);
            item.sellPrice = Math.max(0, Math.floor(calc.sellPrice * (item.buyPrice / Math.max(1, calc.buyPrice))));
        } else {
            item.buyPrice = calc.buyPrice;
            item.sellPrice = calc.sellPrice;
        }
        if (pushHistory) this.pushHistory(item);
        return item;
    }

    static pushHistory(item) {
        if (!Array.isArray(item.priceHistory)) item.priceHistory = [];
        item.priceHistory.push({ time: now(), buy: item.buyPrice || 0, sell: item.sellPrice || 0, stock: item.stock || 0 });
        item.priceHistory = item.priceHistory.slice(-HISTORY_LIMIT);
        this.update24h(item);
    }

    static update24h(item) {
        const h = Array.isArray(item.priceHistory) ? item.priceHistory : [];
        if (!h.length) return;
        const latest = h[h.length - 1];
        const dayAgo = now() - 24 * 60 * 60 * 1000;
        const old = h.find(x => x.time >= dayAgo) || h[0];
        const prices = h.filter(x => x.time >= dayAgo).map(x => x.buy || 0);
        item.high24h = prices.length ? Math.max(...prices) : latest.buy;
        item.low24h = prices.length ? Math.min(...prices) : latest.buy;
        item.priceChange24h = old.buy ? ((latest.buy - old.buy) / old.buy) * 100 : 0;
    }

    static trendText(item) {
        const c = Number(item.priceChange24h || 0);
        if (c > 0.5) return `§a +${c.toFixed(1)}%`;
        if (c < -0.5) return `§c▼ ${c.toFixed(1)}%`;
        return "§e■ Stable";
    }
}

export default MarketPricing;
