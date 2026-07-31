// MCity Dashboard V2 - Contract Admin UI Foundation
// Phase 7 (v1.5.7): Permission re-checks after admin forms.
// New Changes Phase 1 (v1.8.2): Server contracts use ItemPickerUI.

import { ActionFormData, ModalFormData, MessageFormData } from "@minecraft/server-ui";
import { UI } from "../../core/uiTheme.js";
import { CONFIG } from "../../config.js";
import { MoneyUtils } from "../../core/moneyUtils.js";
import { ItemPickerUI } from "../../core/itemPickerUI.js";
import { Permissions } from "../../core/permissions.js";
import { Database } from "../../core/database.js";
import { sanitizeContract, contractId, rebuildContractIndexes } from "../../schemas/contractSchema.js";
import { ContractService } from "./contractService.js";

const CC=CONFIG.CONTRACTS;
function can(player){return Permissions.canManageContracts(player);}
function lost(player){if(can(player))return false; try{player.sendMessage(CONFIG.PREFIX+"§cPermission changed. Action cancelled.");}catch{} return true;}

export class ContractAdminUI {
    static async open(player){
        if(!can(player))return;
        const all=ContractService.all();
        const form=new ActionFormData().title(UI.title(UI.ICON.contract,"Contract Admin")).body(UI.body(`§7Contracts: §f${all.length}`,`§7Active Server: §a${ContractService.activeServer().length}`,`§7Player Active: §b${ContractService.activePlayer().length}`))
            .button("§aCreate Server Contract").button("§eFinalize / Expire Check").button("§fRebuild Indexes").button(UI.BACK);
        const r=await form.show(player); if(lost(player))return; if (r.canceled) return; if (r.selection===3) return this.#back(player);
        if(r.selection===0)return this.createServer(player);
        if(r.selection===1){const n=ContractService.finalizeExpired?.()||0;player.sendMessage(CONFIG.PREFIX+`§aContracts checked: ${n}`);return this.open(player);}
        if(r.selection===2){Database.transaction(CC.COLLECTION,data=>rebuildContractIndexes(data));Database.save(CC.COLLECTION,true);player.sendMessage(CONFIG.PREFIX+"§aContract indexes rebuilt.");return this.open(player);}
    }
    static async createServer(player){
        const cats=Object.keys(CC.CATEGORIES);
        const resets=["once","daily","weekly"];
        if(!can(player))return;

        const setup=await new ModalFormData()
            .title("§aCreate Server Contract - Setup")
            .textField("Title", "Server needs carrots", { defaultValue: "Server needs carrots" })
            .dropdown("Category",cats.map(id=>CC.CATEGORIES[id].name))
            .dropdown("Reset",resets)
            .show(player);
        if(lost(player))return;
        if(setup.canceled)return;

        const selectedItem=await ItemPickerUI.pick(player,{mode:"contract",title:"Select Server Contract Item",pageSize:CC.ITEMS_PER_PAGE||8});
        if(lost(player))return;
        if(!selectedItem){player.sendMessage(CONFIG.PREFIX+"§eServer contract creation cancelled: no item selected.");return this.open(player);}

        const details=await new ModalFormData()
            .title("§aCreate Server Contract - Details")
            .slider(`Amount Required (${selectedItem.name})`,1,2048,{valueStep:1,defaultValue:128})
            .textField("Reward ($)", "1000.00", { defaultValue: "1000.00" })
            .slider("Reward Score",0,100,{valueStep:1,defaultValue:10})
            .show(player);
        if(lost(player))return;
        if(details.canceled)return;

        const reward=MoneyUtils.parseFloatToCents(details.formValues[1],false);
        if(!reward.ok){player.sendMessage(CONFIG.PREFIX+"§cInvalid reward.");return this.open(player);}
        const amount=Math.max(1,Math.floor(Number(details.formValues[0])||1));
        const rewardScore=Math.max(0,Math.floor(Number(details.formValues[2])||0));
        const reset=resets[Math.max(0,Math.floor(Number(setup.formValues[2])||0))]||"once";
        const category=cats[Math.max(0,Math.floor(Number(setup.formValues[1])||0))]||"other";

        const conf=await new MessageFormData()
            .title("§6Confirm Server Contract")
            .body(
                `Item: §e${selectedItem.name}
`+
                `ID: §8${selectedItem.id}
`+
                `Amount: §f${amount}
`+
                `Category: §f${CC.CATEGORIES[category]?.name||category}
`+
                `Reset: §f${reset}
`+
                `Reward: §a${MoneyUtils.formatCents(reward.cents)}
`+
                `Reward Score: §b${rewardScore}

Create server contract?`
            )
            .button1("§cCancel")
            .button2("§aCreate")
            .show(player);
        if(lost(player))return;
        if(conf.canceled)return;
        if(conf.selection!==1)return this.open(player);

        const id=contractId("srv");
        const expiresAt=Date.now()+(reset==="weekly"?7:1)*24*60*60*1000;
        const c=sanitizeContract({id,type:"server_market_supply",creatorId:"server",creatorName:"Server",status:"active",title:setup.formValues[0]||`Server needs ${selectedItem.name}`,category,itemId:selectedItem.id,amountRequired:amount,rewardCents:reward.cents,rewardScore,resetMode:reset,createdAt:Date.now(),expiresAt});
        const tx=Database.transaction(CC.COLLECTION,data=>{data.contracts[id]=c;data.stats.totalContractsCreated=(data.stats.totalContractsCreated||0)+1;rebuildContractIndexes(data);return c;});
        if(tx.success)Database.save(CC.COLLECTION,true);
        player.sendMessage(CONFIG.PREFIX+(tx.success?"§aServer contract created.":`§cCreate failed: ${tx.error}`));
        return this.open(player);
    }
    static #back(player){return import("../../dashboard/dashboardSystem.js").then(m=>m.DashboardSystem.open(player));}
}

export default ContractAdminUI;
