// MCity Dashboard V2 - Input Sanitizer
// Phase 5 Polish: Strip §-color codes and dangerous characters from user
// input to prevent impersonation, message spoofing, and visual injection.
//
// Bedrock Minecraft uses § (section sign) for color/formatting codes. A
// malicious player who names themselves "§l§c[ADMIN]§r BadActor" can fool
// other players into thinking an admin sent them a message. This module
// strips those codes and normalizes player-supplied strings everywhere
// they appear in audit logs, notifications, market orders, contracts, etc.
//
// Usage:
//   const clean = Sanitizer.stripColorCodes(player.name);  // "§l§c[ADMIN]" -> "[ADMIN]"
//   const safe = Sanitizer.sanitizeName(player.name);       // length-capped, alphanumeric+space
//   const safeText = Sanitizer.sanitizeText(input, 240);    // for free-text fields

export class Sanitizer {
    /**
     * Regex matching all Bedrock § color/format codes (§0-9, §a-f, §g-r, §k-o).
     * Global flag is REQUIRED for `.replace()` calls (stripColorCodes, normalize,
     * sanitizeMessage) so all matches are replaced in one pass.
     */
    static #COLOR_CODE_RE = /§[0-9a-fgklmnorA-FGKLMNOR]/g;

    /**
     * Phase 1 Fix: Non-global variant used ONLY by `hasColorCodes()`.
     *
     * Why a separate regex? JavaScript's `RegExp.prototype.test()` on a
     * global regex advances `lastIndex` after each match. Consecutive
     * calls on the SAME string return alternating `true`/`false`:
     *
     *   const re = /§c/g;
     *   re.test("§cHi");  // true, lastIndex=2
     *   re.test("§cHi");  // false (starts at index 2, no match)
     *   re.test("§cHi");  // true (lastIndex reset to 0 on no-match)
     *
     * `hasColorCodes()` is a pure detection function and must be
     * idempotent. A non-global regex has no `lastIndex` state, so every
     * call behaves identically. This is the standard, footgun-free fix.
     */
    static #COLOR_CODE_DETECT_RE = /§[0-9a-fgklmnorA-FGKLMNOR]/;

    /** Regex matching non-printable control characters (excluding newline/tab). */
    static #CONTROL_CHAR_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

    /**
     * Strip all § color/format codes from a string. Useful before logging
     * or displaying player-supplied text where formatting is unwanted.
     */
    static stripColorCodes(str) {
        if (str == null) return "";
        return String(str).replace(this.#COLOR_CODE_RE, "");
    }

    /**
     * Normalize a string for safe display: strip color codes, collapse
     * whitespace, and trim. Does NOT truncate — caller is responsible
     * for length capping if needed.
     */
    static normalize(str) {
        if (str == null) return "";
        let s = String(str);
        s = s.replace(this.#COLOR_CODE_RE, "");
        s = s.replace(this.#CONTROL_CHAR_RE, "");
        s = s.replace(/\s+/g, " ").trim();
        return s;
    }

    /**
     * Sanitize a player name (or other short identifier). Strips color
     * codes, limits to `maxLen` characters (default 32), and keeps only
     * printable characters. Empty input returns "Unknown".
     */
    static sanitizeName(str, maxLen = 32) {
        const s = this.normalize(str);
        if (!s) return "Unknown";
        // Allow letters, digits, spaces, underscores, hyphens, and dots.
        // The hyphen is placed at the END of the character class so it is
        // treated as a literal. Escaping it as backslash-hyphen is rejected
        // by QuickJS (Bedrock's JS runtime) as an invalid escape sequence.
        const filtered = s.replace(/[^\p{L}\p{N} _.-]/gu, "");
        const result = filtered.substring(0, maxLen).trim();
        return result || "Unknown";
    }

    /**
     * Sanitize a free-text field (e.g., contract title, backup label).
     * Strips color codes and control characters, collapses whitespace,
     * and truncates to `maxLen`. Empty input returns "".
     */
    static sanitizeText(str, maxLen = 240) {
        const s = this.normalize(str);
        return s.substring(0, maxLen);
    }

    /**
     * Sanitize a numeric string. Returns the digits-only version, or
     * an empty string if no digits. Useful for ATM codes that should
     * be 4 digits.
     */
    static sanitizeDigits(str, maxLen = 16) {
        if (str == null) return "";
        return String(str).replace(/\D/g, "").substring(0, maxLen);
    }

    /**
     * Escape a string for safe inclusion in JSON. Useful when
     * constructing JSON strings from user input.
     */
    static escapeJson(str) {
        if (str == null) return "";
        return String(str).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t");
    }

    /**
     * Sanitize a chat message. Strips color codes (so the sender cannot
     * spoof system colors), but preserves newlines and basic punctuation.
     * Truncates to `maxLen` (default 260, matching the notification
     * message cap).
     */
    static sanitizeMessage(str, maxLen = 260) {
        if (str == null) return "";
        let s = String(str);
        s = s.replace(this.#COLOR_CODE_RE, "");
        s = s.replace(this.#CONTROL_CHAR_RE, "");
        // Collapse 3+ newlines into 2 (preserve paragraph breaks)
        s = s.replace(/\n{3,}/g, "\n\n");
        return s.substring(0, maxLen);
    }

    /**
     * Sanitize an arbitrary key/identifier (e.g., contract category, market
     * item id). Lowercase, alphanumeric + underscore only.
     */
    static sanitizeKey(str, maxLen = 64) {
        if (str == null) return "";
        return String(str).toLowerCase().replace(/[^a-z0-9_]/g, "").substring(0, maxLen);
    }

    /**
     * Truncate a string to `maxLen` characters, appending "..." if it
     * was truncated. Color codes are NOT stripped here — the caller
     * decides whether to strip first.
     */
    static truncate(str, maxLen = 80) {
        if (str == null) return "";
        const s = String(str);
        if (s.length <= maxLen) return s;
        return s.substring(0, Math.max(1, maxLen - 3)) + "...";
    }

    /**
     * Detect if a string contains color codes. Useful for audit: log a
     * warning when a player-supplied string had color codes (which were
     * then stripped).
     *
     * Phase 1 Fix: Uses `#COLOR_CODE_DETECT_RE` (non-global) instead of
     * `#COLOR_CODE_RE` (global). See the comment on that field for why
     * a global regex breaks `.test()` idempotency.
     */
    static hasColorCodes(str) {
        if (str == null) return false;
        return this.#COLOR_CODE_DETECT_RE.test(String(str));
    }
}

export default Sanitizer;
