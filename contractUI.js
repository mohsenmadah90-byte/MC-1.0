// MCity Dashboard V2 - Contracts UI
// UX Phase 6 (v1.7.5): Contract creation uses searchable item picker wizard.

import { ActionFormData, ModalFormData, MessageFormData } from "@minecraft/server-ui";
import { UI } from "../../uiTheme.js";
import { CONFIG } from "../../config.js";
import { MoneyUtils } from "../../core/moneyUtils.js";
import { ItemPickerUI } from "../../core/itemPickerUI.js";
import { ItemCatalog } from "../../core/itemCatalog.js";
import { ContractInventory } from "./contractInventory.js";
import { ContractReputation } from "./contractReputation.js";
import { ContractService } from "./contractService.js";

const CC = CONFIG.CONTRACTS;
function backDashboard(player){return import("../../dashboard/dashboardSystem.js").then(m=>m.DashboardSystem.open(player));}
function progress(c){return `${c.amountSubmitted||0}/${c.amountRequired||0}`;}
function reward(c){return Math.max(c.rewardCents||0,c.escrowCents||0);}
function catLabel(id){const c=CC.CATEGORIES[id]||CC.CATEGORIES.other; return `${c.color}${c.icon} ${c.name}`;}
function catalogItem(id){return ItemCatalog.get(id);}
function contractItemName(id){return catalogItem(id)?.name || String(id || "").split(":").pop() || id;}
function contractItemIcon(id){return catalogItem(id)?.icon || "";}
function buttonWithIcon(form,label,icon){try{icon?form.button(label,icon):form.button(label);}catch{form.button(label);}}

export class ContractUI {
    static initialize(){ContractService.initialize();}
    static summary(player){const s=ContractService.stats(player);return s.created||s.accepted||s.mailbox?`§7Contracts: §f${s.created} created §8| §b${s.accepted} accepted §8| §e${s.mailbox} deliveries`:null;}
    static badge(player){const s=ContractService.stats(player);const p=[];if(s.accepted)p.push(`${s.accepted} accepted`);if(s.mailbox)p.push(`${s.mailbox} deliveries`);return p.join(" | ");}

    static async open(player){
        const s=ContractService.stats(player);
        const form=new ActionFormData().title(UI.title(UI.ICON.contract,"Contracts","Contract Board"))
            .body(UI.body(`§7Created: §f${s.created}`,`§7Accepted: §b${s.accepted}`,`§7Deliveries: §e${s.mailbox}`,`§7Reputation: §a${s.rep}`))
            .button("§aServer Contracts")
            .button("§fPlayer Contracts")
            .button("§fCreate Contract")
            .button("§eMy Contracts")
            .button("§fDeliveries / Mailbox")
            .button("§fReputation")
            .button("§fTop Contractors")
            .button("§fHelp")
            .button(UI.BACK);
        const r=await form.show(player); if (r.canceled) return; if (r.selection===8) return backDashboard(player);
        if(r.selection===0)return this.list(player,"server",0);
        if(r.selection===1)return this.list(player,"player",0);
        if(r.selection===2)return this.create(player);
        if(r.selection===3)return this.my(player);
        if(r.selection===4)return this.mailbox(player);
        if(r.selection===5)return this.reputation(player);
        if(r.selection===6)return this.top(player,0);
        if(r.selection===7)return this.help(player);
    }

    static async list(player,kind,page=0){
        const arr=kind==="server"?ContractService.activeServer():ContractService.activePlayer().filter(c=>c.creatorId!==player.id || c.type!=="player_contribution");
        const per=CC.ITEMS_PER_PAGE||8,total=Math.max(1,Math.ceil(arr.length/per));page=Math.max(0,Math.min(page,total-1));const slice=arr.slice(page*per,page*per+per);
        const form=new ActionFormData().title(UI.title(UI.ICON.contract,kind==="server"?"Server Contracts":"Player Contracts")).body(UI.body(`§7Contracts: §f${arr.length}`,`§7Page: §f${page+1}/${total}`)); const actions=[];
        for(const c of slice){buttonWithIcon(form, `${c.status==="accepted"?"§e":"§a"}${c.title}\n§b${contractItemName(c.itemId)} ${progress(c)} §e| §e${MoneyUtils.formatCents(reward(c))}\n${catLabel(c.category)}`, contractItemIcon(c.itemId));actions.push({type:"contract",id:c.id});}
        if(page<total-1){form.button(UI.NEXT);actions.push({type:"next"});} if(page>0){form.button(UI.PREV);actions.push({type:"prev"});} form.button(UI.BACK);actions.push({type:"back"});
        const r=await form.show(player); if (r.canceled) return; const a=actions[r.selection]; if(!a||a.type==="back")return this.open(player); if(a.type==="next")return this.list(player,kind,page+1); if(a.type==="prev")return this.list(player,kind,page-1); return this.details(player,a.id,kind,page);
    }

    static async details(player,id,kind="player",page=0){
        const c=ContractService.db().contracts[id]; if(!c)return this.open(player);
        const have=ContractInventory.count(player,c.itemId);
        const body=UI.body(`§7Title: §f${c.title}`,`§7Type: §f${c.type}`,`§7Category: ${catLabel(c.category)}`,`§7Item: §e${contractItemName(c.itemId)} §8(${c.itemId})`,`§7Progress: §f${progress(c)}`,`§7Reward: §e${MoneyUtils.formatCents(reward(c))}`,`§7Status: §f${c.status}`,`§7You have: §f${have}`,c.creatorName?`§7Creator: §f${c.creatorName}`:"");
        const form=new ActionFormData().title(UI.title(UI.ICON.contract,"Contract Details")).body(body); const actions=[];
        if(c.type==="server_market_supply"&&c.status==="active"){form.button("§aSubmit Items");actions.push("submit");}
        if(c.type==="player_supply"&&c.status==="open"&&c.creatorId!==player.id){form.button("§fAccept Contract");actions.push("accept");}
        if(c.type==="player_supply"&&c.status==="accepted"&&c.acceptedBy===player.id){form.button("§aSubmit Items");actions.push("submit");}
        if(c.type==="player_contribution"&&c.status==="open"&&c.creatorId!==player.id){form.button("§aContribute Items");actions.push("submit");}
        // Phase 7.4 (v0.21.3) (CT2): Cancel button for open player contracts
        // created by this player (or admins). Accepted contracts cannot be
        // cancelled — they must wait for expiry.
        if((c.type==="player_supply"||c.type==="player_contribution")&&c.status==="open"&&(c.creatorId===player.id||player.hasTag?.(CONFIG.TAGS.ADMIN)||player.hasTag?.(CONFIG.TAGS.OWNER)||player.hasTag?.(CONFIG.TAGS.CONTRACT_ADMIN))){
            form.button("§cCancel Contract");actions.push("cancel");
        }
        form.button(UI.BACK);actions.push("back");
        const r=await form.show(player); if (r.canceled) return; if (actions[r.selection]==="back") return this.list(player,kind,page);
        const a=actions[r.selection]; if(a==="accept"){const res=ContractService.accept(player,c.id);player.sendMessage(CONFIG.PREFIX+res.message);return this.open(player);} if(a==="submit")return this.submit(player,c.id,kind,page);
        // Phase 7.4 (v0.21.3) (CT2): Handle cancel action with confirmation.
        if(a==="cancel"){
            const conf=await new MessageFormData().title("§cCancel Contract").body(`§7Cancel "${c.title}"?\n\n§eRefund: §a${MoneyUtils.formatCents(Math.max(0,(c.escrowCents||0)-(c.paidOutCents||0)))}\n\n§cThis cannot be undone.`).button1("§cConfirm Cancel").button2("§aKeep Contract").show(player);
            if(!conf.canceled&&conf.selection===0){
                const res=ContractService.cancelContract(player,c.id);
                player.sendMessage(CONFIG.PREFIX+res.message);
            }
            return this.open(player);
        }
    }

    static async submit(player,id,kind,page){
        const c=ContractService.db().contracts[id]; if(!c)return this.open(player); const have=ContractInventory.count(player,c.itemId); const remaining=Math.max(0,c.amountRequired-c.amountSubmitted); const max=Math.min(have,remaining);
        if(max<=0){player.sendMessage(CONFIG.PREFIX+`§cYou do not have required ${c.itemId}.`);return this.details(player,id,kind,page);}
        const r=await new ModalFormData().title("§aSubmit Items").slider(`Amount to submit (Have ${have})`, 1, Math.max(1, max),{valueStep:1,defaultValue:max}).show(player); if (r.canceled) return;
        const res=ContractService.submit(player,id,Math.floor(r.formValues[0])); player.sendMessage(CONFIG.PREFIX+res.message); return this.open(player);
    }

    static async create(player){
        // UX Phase 6: multi-step wizard. Players no longer type raw item IDs;
        // they choose from the searchable item catalog.
        const cats=Object.keys(CC.CATEGORIES); const types=["Single Worker","Multi Contributor"];
        const setup=await new ModalFormData().title("§6Create Contract - Setup")
            .textField("Title", "Need glass")
            .dropdown("Contract Type",types)
            .dropdown("Category",cats.map(id=>CC.CATEGORIES[id].name),{defaultValueIndex:Math.max(0,cats.indexOf("player_request"))})
            .show(player);
        if (setup.canceled) return;

        const selectedItem = await ItemPickerUI.pick(player, { mode: "contract", title: "Select Contract Item", pageSize: CC.ITEMS_PER_PAGE || 8 });
        if(!selectedItem){ player.sendMessage(CONFIG.PREFIX+"§eContract creation cancelled: no item selected."); return this.open(player); }

        const details=await new ModalFormData().title("§6Create Contract - Details")
            .slider(`Amount Required (${selectedItem.name})`,1,1024,{valueStep:1,defaultValue:64})
            .textField("Reward ($)", "1000.00")
            .slider("Deadline Hours",1,72,{valueStep:1,defaultValue:24})
            .textField("Description", "optional")
            .show(player);
        if (details.canceled) return;

        const reward=MoneyUtils.parseFloatToCents(details.formValues[1],false); 
        if(!reward.ok){player.sendMessage(CONFIG.PREFIX+"§cInvalid reward.");return this.open(player);} 
        const fee=Math.floor(reward.cents*CC.PLAYER_CONTRACT_FEE_RATE);
        const amount=Math.max(1,Math.floor(details.formValues[0]));
        const hours=Math.max(1,Math.floor(details.formValues[2]));
        const conf=await new MessageFormData().title("§6Confirm Contract").body(
            `Item: §e${selectedItem.name}\n`+
            `ID: §8${selectedItem.id}\n`+
            `Amount: §f${amount}\n`+
            `Type: §f${types[setup.formValues[1]]}\n`+
            `Category: §f${CC.CATEGORIES[cats[setup.formValues[2]]]?.name || cats[setup.formValues[2]]}\n`+
            `Reward Escrow: §a${MoneyUtils.formatCents(reward.cents)}\n`+
            `Creation Fee: §e${MoneyUtils.formatCents(fee)}\n`+
            `Total: §c${MoneyUtils.formatCents(reward.cents+fee)}\n\nCreate contract?`
        ).button1("§cCancel").button2("§aCreate").show(player);
        if (conf.canceled) return; if (conf.selection!==1) return this.open(player);
        const res=ContractService.createPlayerContract(player,{
            title:setup.formValues[0],
            multiWorker:setup.formValues[1]===1,
            category:cats[setup.formValues[2]],
            itemId:selectedItem.id,
            amountRequired:amount,
            rewardCents:reward.cents,
            timeLimitSeconds:hours*3600,
            description:details.formValues[3]
        }); 
        player.sendMessage(CONFIG.PREFIX+res.message); 
        return this.open(player);
    }

    static async my(player){
        const created=ContractService.myCreated(player), accepted=ContractService.myAccepted(player); const arr=[...created,...accepted];
        const form=new ActionFormData().title(UI.title(UI.ICON.contract,"My Contracts")).body(UI.body(`§7Created: §f${created.length}`,`§7Accepted: §b${accepted.length}`)); const actions=[];
        for(const c of arr.slice(0,30)){buttonWithIcon(form, `${c.creatorId===player.id?"§aCreated":"§bAccepted"} ${c.title}\n§b${contractItemName(c.itemId)} §e| §f${c.status} §e| §f${progress(c)}`, contractItemIcon(c.itemId));actions.push(c.id);} form.button(UI.BACK);actions.push("back");
        const r=await form.show(player); if (r.canceled) return; if (actions[r.selection]==="back") return this.open(player); return this.details(player,actions[r.selection],"my",0);
    }

    static async mailbox(player){
        const list=ContractService.mailbox(player); const form=new ActionFormData().title(UI.title("§2","Contract Deliveries")).body(UI.body(`§7Entries: §f${list.length}`)); const actions=[]; if(list.length){form.button("§aClaim All Deliveries");actions.push({type:"claim"});}
        for(const e of list.slice(0,20)){form.button(`§e${e.amount}x ${e.itemId}
§7From ${e.fromName||"-"}`);actions.push({type:"view",entry:e});} form.button(UI.BACK);actions.push({type:"back"});
        const r=await form.show(player); const a=actions[r.selection]; if (r.canceled) return; if (!a||a.type==="back") return this.open(player); if(a.type==="claim"){const res=ContractService.claimMailbox(player);player.sendMessage(CONFIG.PREFIX+`§aClaimed deliveries. Items: ${res.items}, remaining entries: ${res.remaining}.`);return this.open(player);} if(a.type==="view")return this.mailboxDetails(player,a.entry); return this.mailbox(player);
    }

    static async mailboxDetails(player, entry){
        await new ActionFormData().title(UI.title("§2","Delivery Details")).body(UI.body(
            UI.kv("Item", `${entry.amount}x ${entry.itemId}`, "§e"),
            UI.kv("From", entry.fromName || "-"),
            UI.kv("Contract", entry.contractId || "-"),
            UI.kv("Created", entry.createdAt ? new Date(entry.createdAt).toLocaleString() : "Unknown")
        )).button(UI.BACK).show(player);
        return this.mailbox(player);
    }

    static async reputation(player){const s=ContractService.db().playerStats[player.id]||{reputation:0}; await new ActionFormData().title(UI.title("§d","Contract Reputation")).body(UI.body(`§7Rank: ${ContractReputation.rank(s)}`,`§7Reputation: §a${s.reputation||0}`,`§7Completed: §f${s.contractsCompleted||0}`,`§7Items Submitted: §f${s.itemsSubmitted||0}`,`§7Earned: §a${MoneyUtils.formatCents(s.totalEarnedCents||0)}`)).button(UI.BACK).show(player); return this.open(player);}
    static async top(player,page=0){const arr=ContractService.topReputation(100); const per=10,total=Math.max(1,Math.ceil(arr.length/per));page=Math.max(0,Math.min(page,total-1));const slice=arr.slice(page*per,page*per+per); const form=new ActionFormData().title(UI.title("§b","Top Contractors")).body(UI.body(`§7Page: §f${page+1}/${total}`)); const actions=[]; for(let i=0;i<slice.length;i++){const st=slice[i];form.button(`§e#${page*per+i+1} §f${st.name}
${ContractReputation.rank(st)} §a${st.reputation}`);actions.push({type:"view",stats:st,rank:page*per+i+1});} if(page<total-1){form.button(UI.NEXT);actions.push({type:"next"});} if(page>0){form.button(UI.PREV);actions.push({type:"prev"});} form.button(UI.BACK);actions.push({type:"back"}); const r=await form.show(player); const a=actions[r.selection]; if (r.canceled) return; if (!a||a.type==="back") return this.open(player); if(a.type==="next")return this.top(player,page+1); if(a.type==="prev")return this.top(player,page-1); if(a.type==="view")return this.topDetails(player,a.stats,a.rank,page); return this.top(player,page);}
    static async topDetails(player, s, rank, page=0){await new ActionFormData().title(`§e#${rank} ${s.name}`).body(UI.body(`§7Rank: ${ContractReputation.rank(s)}`,`§7Reputation: §a${s.reputation||0}`,`§7Created: §f${s.contractsCreated||0}`,`§7Accepted: §b${s.contractsAccepted||0}`,`§7Completed: §f${s.contractsCompleted||0}`,`§7Items Submitted: §f${s.itemsSubmitted||0}`,`§7Earned: §a${MoneyUtils.formatCents(s.totalEarnedCents||0)}`)).button(UI.BACK).show(player); return this.top(player,page);}
    static async help(player){await new ActionFormData().title(UI.title("?","Contracts Help")).body(UI.body("§6Contract Board","§7Server contracts reward players for supplying requested items.","§7Player contracts use escrow so workers get paid when completed.","§7Deliveries and rewards are handled through Dashboard mailboxes and payouts.")).button(UI.BACK).show(player); return this.open(player);}
}

export default ContractUI;
