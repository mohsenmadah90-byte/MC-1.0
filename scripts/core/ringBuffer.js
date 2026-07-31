// MCity Dashboard V2 - Ring Buffer
// Phase 2 Performance: O(1) append + bounded memory for high-volume logs.
//
// The original AuditService used `array.push(...).slice(-N)` on every event,
// which allocated a fresh 3000-entry array on every push once the buffer was
// full. This RingBuffer uses a fixed-size circular buffer so append is O(1)
// and toArray() returns a properly ordered snapshot in O(N) without per-push
// allocation.
//
// NOTE: This is intended for in-memory bookkeeping. When persisted via
// JSON.stringify, the buffer serializes to a flat array (oldest-first) which
// remains backward-compatible with readers that just expected an array.

export class RingBuffer {
    constructor(capacity) {
        this.capacity = Math.max(1, Math.floor(Number(capacity) || 1));
        this.buf = new Array(this.capacity);
        this.head = 0;       // next write slot
        this.size = 0;       // current count (≤ capacity)
    }

    /**
     * Append an item. O(1).
     */
    push(item) {
        this.buf[this.head] = item;
        this.head = (this.head + 1) % this.capacity;
        if (this.size < this.capacity) this.size++;
    }

    /**
     * Returns the most recently pushed item, or undefined if empty.
     */
    last() {
        if (this.size === 0) return undefined;
        // The most recent write was at (head - 1 + capacity) % capacity.
        return this.buf[(this.head - 1 + this.capacity) % this.capacity];
    }

    /**
     * Returns the oldest item, or undefined if empty.
     */
    first() {
        if (this.size === 0) return undefined;
        if (this.size < this.capacity) return this.buf[0];
        // Buffer is full: oldest is at head (which is one past the most recent).
        return this.buf[this.head];
    }

    /**
     * Returns a flat array of all items in insertion order (oldest first).
     * O(N) where N = this.size.
     */
    toArray() {
        const out = new Array(this.size);
        if (this.size < this.capacity) {
            // Buffer not yet full: items 0..size-1 are valid in order.
            for (let i = 0; i < this.size; i++) out[i] = this.buf[i];
        } else {
            // Buffer is full: oldest is at head, walk forward from head.
            for (let i = 0; i < this.size; i++) {
                out[i] = this.buf[(this.head + i) % this.capacity];
            }
        }
        return out;
    }

    /**
     * Returns up to `n` most recent items in insertion order (oldest first
     * among the selected slice). O(n).
     */
    lastN(n) {
        const count = Math.min(Math.max(0, Math.floor(n)), this.size);
        const out = new Array(count);
        // The most recent `count` items occupy slots ending just before head.
        for (let i = 0; i < count; i++) {
            const idx = (this.head - count + i + this.capacity) % this.capacity;
            out[i] = this.buf[idx];
        }
        return out;
    }

    /**
     * Returns up to `n` most recent items in reverse order (newest first).
     * Useful for "recent events" UIs.
     */
    recentN(n) {
        const count = Math.min(Math.max(0, Math.floor(n)), this.size);
        const out = new Array(count);
        for (let i = 0; i < count; i++) {
            const idx = (this.head - 1 - i + this.capacity) % this.capacity;
            out[i] = this.buf[idx];
        }
        return out;
    }

    /**
     * Clear all items. O(1).
     */
    clear() {
        this.buf = new Array(this.capacity);
        this.head = 0;
        this.size = 0;
    }

    /**
     * Iterate in insertion order (oldest first). The callback receives
     * (item, index) and may return false to break early.
     */
    forEach(callback) {
        if (typeof callback !== "function") return;
        if (this.size < this.capacity) {
            for (let i = 0; i < this.size; i++) {
                if (callback(this.buf[i], i) === false) return;
            }
        } else {
            for (let i = 0; i < this.size; i++) {
                const idx = (this.head + i) % this.capacity;
                if (callback(this.buf[idx], i) === false) return;
            }
        }
    }

    /**
     * JSON-serializable form: a plain array in insertion order.
     * This makes the RingBuffer a drop-in replacement for an array when
     * persisted via Database.
     */
    toJSON() {
        return this.toArray();
    }

    /**
     * Hydrate a RingBuffer from a plain array (e.g., loaded from DB).
     * Returns a new RingBuffer instance.
     */
    static fromArray(arr, capacity) {
        const rb = new RingBuffer(capacity);
        if (Array.isArray(arr)) {
            for (const item of arr) rb.push(item);
        }
        return rb;
    }

    get length() { return this.size; }
}

export default RingBuffer;
