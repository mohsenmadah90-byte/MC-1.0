// MCity Dashboard V2 - Item Helpers

export class ItemUtils {
    static cleanName(name) {
        return String(name || "").replace(/§./g, "").trim().toLowerCase();
    }

    static isNamedItem(item, typeId, cleanRequiredName) {
        return item?.typeId === typeId && this.cleanName(item.nameTag) === this.cleanName(cleanRequiredName);
    }

    static countItem(container, typeId, name = null) {
        if (!container) return 0;
        let count = 0;
        for (let i = 0; i < container.size; i++) {
            const item = container.getItem(i);
            if (!item || item.typeId !== typeId) continue;
            if (name !== null && this.cleanName(item.nameTag) !== this.cleanName(name)) continue;
            count += item.amount || 0;
        }
        return count;
    }

    static hasItem(container, typeId, name = null) {
        return this.countItem(container, typeId, name) > 0;
    }
}

export default ItemUtils;
