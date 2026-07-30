// MCity Dashboard V2 - Card-authenticated dimension gate registry.
import { AccessCardService } from "../../core/accessCardService.js";

const gates = new Map();

export class GateService {
    static register(definition) {
        const id = String(definition?.id || "").trim();
        if (!id) return false;
        gates.set(id, { ...definition, id, enabled: definition.enabled !== false, requiredCard: definition.requiredCard !== false });
        return true;
    }
    static definition(id) { return gates.get(String(id || "")) || null; }
    static authorize(player, gateId) {
        const gate = this.definition(gateId);
        if (!gate || !gate.enabled) return { allowed: false, reason: "gate_disabled", message: "§cThis gate is disabled." };
        if (!gate.requiredCard) return { allowed: true, gate };
        const card = AccessCardService.authorize(player, `gate:${gate.id}`);
        return card.valid ? { allowed: true, gate, card } : { allowed: false, gate, ...card };
    }
    static list() { return [...gates.values()].map(gate => ({ ...gate })); }
    static clear() { gates.clear(); }
}

export default GateService;
