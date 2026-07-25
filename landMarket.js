// MCity Dashboard V2 - Land Market Facade

import { LandService } from "./landService.js";

export class LandMarket {
    static listings() { return LandService.listings(); }
    static listForSale(player, claimId, price) { return LandService.listForSale(player, claimId, price); }
    static cancelListing(player, claimId) { return LandService.unlistForSale(player, claimId); }
    static buyListing(player, listingId) {
        const listing = LandService.listings().find(entry => entry.id === listingId);
        if (!listing?.claimId) return { success: false, message: "§cListing not found." };
        return LandService.buyPlayerLand(player, listing.claimId);
    }
}

export default LandMarket;
