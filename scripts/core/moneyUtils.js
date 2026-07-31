// MCity Dashboard V2 - Money Utility Helpers

export class MoneyUtils {
    static parseFloatToCents(value, allowNegative = false) {
        const n = typeof value === "number" ? value : Number(value);
        if (!Number.isFinite(n)) return { ok: false, error: "Invalid number." };
        if (!allowNegative && n < 0) return { ok: false, error: "Negative amounts are not allowed." };
        const scaled = n * 100;
        const rounded = Math.round(scaled);
        if (Math.abs(scaled - rounded) > 0.01) return { ok: false, error: "Use at most 2 decimals." };
        return { ok: true, cents: rounded };
    }

    static formatCents(totalCents = 0) {
        const centsInt = Math.floor(Number(totalCents) || 0);
        const sign = centsInt < 0 ? "-" : "";
        const abs = Math.abs(centsInt);
        const dollars = Math.floor(abs / 100);
        const cents = abs % 100;
        return `${sign}$${dollars}.${String(cents).padStart(2, "0")}`;
    }
}

export default MoneyUtils;
