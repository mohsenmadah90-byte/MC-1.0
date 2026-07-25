// MCity Dashboard V2 - Contract Service
// Phase 4: Offline Synchronization & Queue Processing
// Phase 1 Critical Fix: Use O(1) PlayerRegistry lookup instead of linear scan.
// Phase 7.4 (v0.21.3): Escrow refund on expiry (CT1), cancelContract (CT2),
//                     incremental index maintenance (S8),
//                     reputation to completion (S9).
// Phase 4 (v1.5.4): Submit race safety + server reset completion fix.
// Hotfix 3 (v1.6.3): Reward delivery uses recoverable financial journals.

import { Player } from "@minecraft/server";
import { CONFIG } from "../../config.js";
import { Database } from "../../core/database.js";
import { Logger } from "../../core/logger.js";
import { MoneyUtils } from "../../core/moneyUtils.js";
import { MoneyService } from "../economy/moneyService.js";
import { LevelService } from "../economy/levelService.js";
import { FinanceService } from "../finance/financeService.js";
import { FinancialJournalService } from "../finance/financialJournalService.js";
import { NotificationService } from "../../dashboard/dashboardNotifications.js";
import { PlayerRegistry } from "../../core/playerRegistry.js";
import { DisposableRegistry } from "../../core/disposableRegistry.js";
import { ItemSettingsService } from "../../core/itemSettingsService.js";
import { DEFAULT_CONTRACT_DB, validateContractData, sanitizeContract, rebuildContractIndexes, addToContractIndex, removeFromContractIndex, normalizeItemId, contractId } from "../../schemas/contractSchema.js";
import { DEFAULT_CONTRACT_MAILBOX_SHARD_DB, validateContractMailboxShardData } from "../../schemas/contractShardSchema.js";
import { AuditService } from "../audit/auditService.js";
import { ContractInventory } from "./contractInventory.js";
import { ContractReputation } from "./contractReputation.js";
import { ContractShardService } from "./contractShardService.js";
import { BatchTaskService } from "../../core/batchTaskService.js";
import { RateLimiter } from "../../core/rateLimiter.js";

const CC = CONFIG.CONTRACTS;
const COLLECTION = CC.COLLECTION;
const DAY_MS = 24 * 60 * 60 * 1000;
function now(){return Date.now();}
function rewardObligationId(prefix="rw"){return `${prefix}_${Date.now()}_${Math.floor(Math.random()*1000000)}`;}
// Phase 1 Fix: O(1) lookup via PlayerRegistry.
function playerById(id){
    if(!id) return null;
    return PlayerRegistry.findOnlineById(id);
}

export class ContractService {
    static #initialized=false;
    
    static initialize(){ 
        if(this.#initialized)return; 
        this.#initialized=true; 
        const db=this.db(); 
        this.seedDefaults(db);
        BatchTaskService.register("contract_gc", {
            process: task => this.#processGCBatch(task),
            afterCommit: effects => this.#afterGCBatch(effects)
        });
        DisposableRegistry.registerShutdownCleanup("ContractService.lifecycle", () => {
            this.#initialized = false;
        });
        Logger.startup("Contracts","Contract service initialized"); 
    }
    
    static db(){ return Database.collection(COLLECTION, DEFAULT_CONTRACT_DB, { validate: validateContractData }); }

    static seedDefaults(db=this.db()){
        if(db.seeded || !CC.SERVER_CONTRACTS_ENABLED)return false;
        for(const raw of CC.DEFAULT_SERVER_CONTRACTS||[]){
            const id=contractId("srv");
            const c=sanitizeContract({ id, type:"server_market_supply", creatorId:"server", creatorName:"Server", status:"active", createdAt:now(), expiresAt:now()+DAY_MS, ...raw });
            db.contracts[id]=c;
        }
        db.seeded=true; db.stats.lastUpdated=now(); rebuildContractIndexes(db); Database.save(COLLECTION,true); return true;
    }

    static all(){return Object.values(this.db().contracts||{}).sort((a,b)=>(b.createdAt||0)-(a.createdAt||0));}
    static activeServer(){return this.all().filter(c=>c.type==="server_market_supply"&&c.status==="active");}
    static activePlayer(){return this.all().filter(c=>(c.type==="player_supply"&&(c.status==="open"||c.status==="accepted"))||(c.type==="player_contribution"&&c.status==="open"));}
    static myCreated(player){const db=this.db();return (db.playerIndex[player.id]?.created||[]).map(id=>db.contracts[id]).filter(Boolean);}
    static myAccepted(player){const db=this.db();return (db.playerIndex[player.id]?.accepted||[]).map(id=>db.contracts[id]).filter(Boolean);}

    static createPlayerContract(player, params){
        const db=this.db(); const active=this.myCreated(player).filter(c=>c.status==="open"||c.status==="accepted").length;
        if(active>=CC.MAX_ACTIVE_CREATED_PER_PLAYER)return{success:false,message:`§cCreated contract limit reached (${active}/${CC.MAX_ACTIVE_CREATED_PER_PLAYER}).`};
        // Phase 4.2: complete validation before any debit.
        const itemId=normalizeItemId(params.itemId);
        if(!ItemSettingsService.isContractable(itemId))return{success:false,message:"§cThis item is disabled for new contracts."};
        const amountRequired=Math.floor(Number(params.amountRequired));
        const reward=Math.floor(Number(params.rewardCents));
        const expireDays=Math.floor(Number(params.expireDays||CC.DEFAULT_EXPIRE_DAYS));
        if(!Number.isSafeInteger(amountRequired)||amountRequired<=0||!Number.isSafeInteger(reward)||reward<=0||expireDays<1||expireDays>30)return{success:false,message:"§cInvalid contract amount, reward or expiry."};
        const fee=Math.floor(reward*CC.PLAYER_CONTRACT_FEE_RATE); const total=reward+fee;
        if(!Number.isSafeInteger(total))return{success:false,message:"§cContract escrow exceeds safe range."};
        const rl=CONFIG.RATE_LIMITS?.CONTRACT_CREATE;if(rl&&!RateLimiter.check(`contract_create:${player.id}`,rl[0],rl[1]))return{success:false,message:"§cContract creation rate limit reached."};
        
        // Phase 7 (v0.21.0): Use atomic debit instead of addMoney(-total).
        if(MoneyService.getBalance(player) < total) return {success:false,message:`§cNeed ${MoneyUtils.formatCents(total)}.`};
        const deduction = MoneyService.debit(player, total, "contract_create_escrow");
        if(!deduction.success) {
            return{success:false,message:`§c${deduction.message || "Failed to deduct escrow."}`};
        }
        
        const id=contractId("ply");
        const c=sanitizeContract({ id, type:params.multiWorker?"player_contribution":"player_supply", category:params.category||"player_request", title:params.title||`Need ${itemId}`, description:params.description||"", itemId, amountRequired, escrowCents:reward, paidOutCents:0, feeCents:fee, creatorId:player.id, creatorName:player.name, status:"open", timeLimitSeconds:params.timeLimitSeconds||86400, expiresAt:now()+expireDays*DAY_MS });
        
        const tx=Database.transaction(COLLECTION,data=>{
            data.contracts[id]=c; 
            data.stats.totalContractsCreated=(data.stats.totalContractsCreated||0)+1; 
            data.stats.totalFeesCollected=(data.stats.totalFeesCollected||0)+fee; 
            // Phase 7.4 (v0.21.3) (S9): Reputation is NO LONGER awarded on
            // creation. Previously +5 was given here, which was farmable —
            // a player could create 5 contracts, let them expire, repeat.
            // Now reputation is awarded on completion (#submitSingle,
            // #submitContribution, #submitServer).
            // Phase 7.4 (v0.21.3) (S8): Incremental index update instead of full rebuild.
            addToContractIndex(data, c); 
            return c;
        });
        
        if(!tx.success){
            // Refund with safe rollback pattern (check return value).
            const refund = MoneyService.addMoney(player, total, "contract_create_rollback");
            if(!refund || !refund.success){
                Logger.error("Contracts", `CRITICAL: contract_create_rollback failed for ${player.id}, ${total}c lost.`);
                AuditService.record("contract.rollback.failed", "contracts", player.id, player.name, `CRITICAL create rollback: ${total}c`, { contractId: id }, "error");
                try { FinanceService.addPayout(player.id, total, "Contract create rollback (delayed)", "contracts", { contractId: id }); } catch(e){ Logger.error("Contracts", "Fallback payout failed", e); }
            }
            return{success:false,message:`§cCreate failed: ${tx.error}`};
        }
        
        FinanceService.addTreasury("contracts", reward+fee, "Player contract escrow+fee", { playerId:player.id, contractId:id });
        AuditService.record("contract.create", "contracts", player.id, player.name, `Created contract ${id}`, { contractId: id, reward, fee, type: c.type });
        return{success:true,contract:c,message:`§aContract created. Escrow ${MoneyUtils.formatCents(reward)}, fee ${MoneyUtils.formatCents(fee)}.`};
    }

    static accept(player, contractIdValue){
        const c=this.db().contracts[contractIdValue]; if(!c||c.type!=="player_supply"||c.status!=="open")return{success:false,message:"§cContract is not open for accepting."};
        if(c.creatorId===player.id)return{success:false,message:"§cYou cannot accept your own contract."};
        const active=this.myAccepted(player).filter(x=>x.status==="accepted").length; if(active>=CC.MAX_ACTIVE_ACCEPTED_PER_PLAYER)return{success:false,message:"§cYou already have an accepted contract."};

        const tx=Database.transaction(COLLECTION,data=>{
            const x=data.contracts[contractIdValue]; if(!x||x.status!=="open")throw new Error("Contract changed.");
            // Phase 7.4 (v0.21.3) (S8): Incremental index update — remove
            // old state (no acceptedBy) then add new state (with acceptedBy).
            const before = { id: x.id, creatorId: x.creatorId, acceptedBy: null };
            x.acceptedBy=player.id; x.acceptedByName=player.name; x.acceptedAt=now(); x.deadlineAt=now()+x.timeLimitSeconds*1000; x.status="accepted"; x.updatedAt=now();
            // Phase 5 Fix: Do NOT award reputation on accept.
            //
            // PROBLEM (pre-Phase 5):
            //   `accept` awarded +10 reputation immediately. A player could
            //   accept a contract, let it expire without submitting anything,
            //   and repeat — farming +10 rep per accept cycle (bounded by
            //   MAX_ACTIVE_ACCEPTED_PER_PLAYER=1, but still exploitable over
            //   time). The code comment said "reputation is NO LONGER
            //   awarded on creation" but accept still granted it.
            //
            // SOLUTION (Phase 5):
            //   Reputation is now awarded ONLY on completion (in #submitSingle,
            //   +50) and on contribution submissions (in #submitContribution,
            //   per-item + completion bonus). We still increment the
            //   `contractsAccepted` counter here for stats purposes, but no
            //   reputation is granted. This closes the accept-and-expire
            //   farm: a player who accepts but never delivers gets 0 rep.
            ContractReputation.add(data, player.id, player.name, 0, { contractsAccepted: 1 });
            // Phase 7.4 (v0.21.3) (S8): Update index incrementally.
            // Remove the 'before' entry (no acceptedBy) then add the 'after'.
            removeFromContractIndex(data, before);
            addToContractIndex(data, { id: x.id, creatorId: x.creatorId, acceptedBy: x.acceptedBy });
        });
        
        if(tx.success){
            // Queue notification for offline creator
            NotificationService.create(c.creatorId,{type:"contract",source:"contracts",title:"Contract Accepted",message:`${player.name} accepted your contract ${c.title}.`,action:"contracts"}); 
            AuditService.record("contract.accept", "contracts", player.id, player.name, `Accepted contract ${contractIdValue}`, { contractId: contractIdValue, creatorId: c.creatorId });
        }
        return{success:tx.success,message:tx.success?"§aContract accepted.":`§c${tx.error}`};
    }

    static submit(player, contractIdValue, amount){
        const live=this.db().contracts[contractIdValue]; if(!live)return{success:false,message:"§cContract not found."};
        const c=live; amount=Math.max(1,Math.floor(amount||1));
        
        if(c.type==="player_supply"&&c.acceptedBy!==player.id)return{success:false,message:"§cYou are not the worker for this contract."};
        if(c.type==="player_contribution"&&c.creatorId===player.id)return{success:false,message:"§cYou cannot contribute to your own contract."};
        if(c.type==="player_contribution"&&c.status!=="open")return{success:false,message:"§cContribution contract is not open."};
        if(c.type==="server_market_supply"&&c.status!=="active")return{success:false,message:"§cServer contract is not active."};
        
        const remaining=Math.max(0,c.amountRequired-c.amountSubmitted); const available=ContractInventory.count(player,c.itemId); const submit=Math.min(amount,remaining,available);
        if(submit<=0)return{success:false,message:`§cYou need ${c.itemId}.`};
        if(c.type==="player_supply"&&submit!==remaining)return{success:false,message:`§cSingle-worker contracts require the full remaining ${remaining} item(s) in one submission.`};
        const rl=CONFIG.RATE_LIMITS?.CONTRACT_SUBMIT;if(rl&&!RateLimiter.check(`contract_submit:${player.id}`,rl[0],rl[1]))return{success:false,message:"§cContract submission rate limit reached."};
        
        // Transactional safety
        const rem=ContractInventory.remove(player,c.itemId,submit); 
        if(!rem.success)return{success:false,message:"§cFailed to reserve items."};
        
        if(c.type==="server_market_supply")return this.#submitServer(player,c.id,submit,c.itemId);
        if(c.type==="player_contribution")return this.#submitContribution(player,c.id,submit,c.itemId);
        return this.#submitSingle(player,c.id,submit,c.itemId);
    }

    /**
     * Phase 4 (v1.5.4): Refund items reserved by submit() but not consumed
     * by the authoritative transaction. This closes a race where another
     * player could complete a contract between the UI pre-check and the DB
     * transaction: submit() removed N items, but the transaction accepted
     * only `actual < N`.
     *
     * If the player's inventory is full when returning the surplus, the
     * remainder is moved to the contract mailbox so the items are not lost.
     */
    static #refundSubmitSurplus(player, itemId, reserved, actual, contractIdValue) {
        const surplus = Math.max(0, Math.floor((reserved || 0) - (actual || 0)));
        if (surplus <= 0) return { refunded: 0, mailed: 0, lost: 0 };

        let refunded = 0, mailed = 0, lost = 0;
        try {
            const add = ContractInventory.add(player, itemId, surplus);
            refunded = Math.max(0, Math.floor(add?.added || 0));
            const remaining = Math.max(0, Math.floor(add?.remaining || 0));
            if (remaining > 0) {
                const mailTx = Database.transaction(COLLECTION, data => {
                    this.#addContractMailbox(data, player.id, itemId, remaining, contractIdValue, "Contract System");
                    return { mailed: remaining };
                });
                if (mailTx.success) mailed = remaining;
                else {
                    lost = remaining;
                    Logger.error("Contracts", `CRITICAL: surplus refund mailbox failed for ${player.id}, ${remaining}x ${itemId}`, mailTx.error);
                    AuditService.record("contract.submit_surplus_refund_failed", "contracts", player.id, player.name,
                        `CRITICAL: Could not refund ${remaining} surplus item(s) from contract ${contractIdValue}. Manual compensation required.`,
                        { contractId: contractIdValue, itemId, surplus, refunded, remaining, error: mailTx.error }, "error");
                }
            }
        } catch (e) {
            lost = surplus - refunded - mailed;
            Logger.error("Contracts", `CRITICAL: surplus refund failed for ${player.id}, ${surplus}x ${itemId}`, e);
            AuditService.record("contract.submit_surplus_refund_failed", "contracts", player.id, player.name,
                `CRITICAL: Surplus item refund crashed for contract ${contractIdValue}. Manual compensation required.`,
                { contractId: contractIdValue, itemId, surplus, refunded, mailed, error: String(e?.message || e).substring(0, 200) }, "error");
        }

        if (refunded > 0 || mailed > 0) {
            try { player.sendMessage(CONFIG.PREFIX + `§eContract accepted only §f${actual}§e item(s); surplus §f${surplus}§e returned${mailed ? ` (§f${mailed}§e mailed)` : ""}.`); } catch {}
        }
        return { refunded, mailed, lost };
    }

    static #queueRewardObligation(data, obligationId, player, contractIdValue, rewardCents, score, reason) {
        const reward = Math.max(0, Math.floor(Number(rewardCents) || 0));
        const scoreAmount = Math.max(0, Math.floor(Number(score) || 0));
        if (reward <= 0 && scoreAmount <= 0) return null;
        if (!data.rewardQueue) data.rewardQueue = {};
        data.rewardQueue[obligationId] = {
            id: obligationId,
            contractId: contractIdValue,
            playerId: player.id,
            playerName: player.name,
            rewardCents: reward,
            score: scoreAmount,
            reason,
            status: "pending",
            journalId: `reward_${obligationId}`,
            createdAt: now(),
            updatedAt: now(),
            attempts: 0,
            lastError: ""
        };
        data.stats.totalRewardsQueued = (data.stats.totalRewardsQueued || 0) + reward;
        return data.rewardQueue[obligationId];
    }

    static #deliverReward(player, contractIdValue, rewardCents = 0, score = 0, reason = "Contract reward", obligationId = "") {
        const reward = Math.max(0, Math.floor(Number(rewardCents) || 0));
        const scoreAmount = Math.max(0, Math.floor(Number(score) || 0));
        if (reward <= 0 && scoreAmount <= 0) return { success: true, skipped: true };
        const res = FinancialJournalService.deliverContractReward(player, {
            obligationId,
            contractId: contractIdValue,
            rewardCents: reward,
            score: scoreAmount,
            reason,
            journalId: obligationId ? `reward_${obligationId}` : undefined
        });
        if (!res || !res.success) {
            Logger.error("Contracts", `Reward delivery journal failed for ${player.id} contract ${contractIdValue}`, res?.message || res);
            AuditService.record("contract.reward_delivery.failed", "contracts", player.id, player.name,
                `Reward delivery failed for contract ${contractIdValue}; journal recovery may be required.`,
                { contractId: contractIdValue, rewardCents: reward, score: scoreAmount, error: res?.message || "unknown" }, "error");
        }
        return res;
    }

    static #submitServer(player,id,submit,itemId){
        let reward=0, score=0;
        const obligationId = rewardObligationId("srv_reward");
        const tx=Database.transaction(COLLECTION,data=>{
            const c=data.contracts[id]; if(!c||c.status!=="active")throw new Error("Contract changed."); 
            const actual=Math.min(submit,c.amountRequired-c.amountSubmitted); 
            if(actual<=0)throw new Error("Contract already fulfilled.");
            c.amountSubmitted+=actual; 
            c.deliveries.push({playerId:player.id,playerName:player.name,amount:actual,time:now()}); 
            reward=Math.floor((c.rewardCents||0)*actual/c.amountRequired); 
            score=Math.floor((c.rewardScore||0)*actual/c.amountRequired); 
            const done=c.amountSubmitted>=c.amountRequired; 
            if(done){c.status="completed";c.completions=(c.completions||0)+1;data.stats.totalContractsCompleted=(data.stats.totalContractsCompleted||0)+1;} 
            data.stats.totalItemsSubmitted=(data.stats.totalItemsSubmitted||0)+actual; 
            data.stats.totalRewardsPaid=(data.stats.totalRewardsPaid||0)+reward; 
            this.#queueRewardObligation(data, obligationId, player, id, reward, score, "Server contract reward");
            ContractReputation.add(data,player.id,player.name,Math.max(1,Math.floor(actual/16))+(done?25:0),{contributions:1,itemsSubmitted:actual,totalEarnedCents:reward,contractsCompleted:done?1:0}); 
            c.updatedAt=now(); 
            return {actual,done};
        });
        
        if(!tx.success){
            this.#refundSubmitSurplus(player,itemId,submit,0,id);
            return{success:false,message:`§cSubmit failed: ${tx.error}`};
        }

        this.#refundSubmitSurplus(player,itemId,submit,tx.result.actual,id);
        
        this.#deliverReward(player,id,reward,score,"Server contract reward",obligationId);
        AuditService.record("contract.submit.server", "contracts", player.id, player.name, `Submitted to server contract ${id}`, { contractId:id, amount:tx.result.actual, reward, score });
        return{success:true,message:`§aSubmitted ${tx.result.actual}. Reward pending: ${MoneyUtils.formatCents(reward)} Score: ${score}.`};
    }

    static #submitContribution(player,id,submit,itemId){
        let creatorId="", earned=0, actual=0, residualBonus=0;
        const obligationId = rewardObligationId("contrib_reward");
        const tx=Database.transaction(COLLECTION,data=>{
            const c=data.contracts[id]; if(!c||c.type!=="player_contribution"||c.status!=="open")throw new Error("Contract changed.");
            actual=Math.min(submit,c.amountRequired-c.amountSubmitted);
            if(actual<=0)throw new Error("Contract already fulfilled.");
            creatorId=c.creatorId;
            c.amountSubmitted+=actual;
            c.deliveries.push({playerId:player.id,playerName:player.name,amount:actual,time:now()});
            earned=Math.floor((c.escrowCents||0)*actual/c.amountRequired);
            // Phase 7.4 (v0.21.3) (CT1): Track paidOutCents so finalizeExpired
            // can refund only the un-paid remainder.
            c.paidOutCents = (c.paidOutCents || 0) + earned;
            const done=c.amountSubmitted>=c.amountRequired;
            // Phase 5 Fix: Rounding residual recovery.
            //
            // PROBLEM (pre-Phase 5):
            //   Due to `Math.floor`, the sum of all `earned` values across
            //   contributions could be slightly less than `escrowCents`.
            //   When the contract completed (done=true), the residual
            //   (escrowCents - paidOutCents) was silently abandoned in
            //   the treasury bucket — a small but real economy leak over
            //   thousands of contracts.
            //
            // SOLUTION (Phase 5):
            //   When the contract completes, award the rounding residual
            //   to the LAST contributor as a bonus. This ensures the
            //   entire escrow is distributed. The residual is typically
            //   0-few cents (floor rounding), so it's a tiny bonus that
            //   fairly goes to the player who completed the contract.
            //   We also update paidOutCents to reflect the full payout.
            if (done) {
                residualBonus = Math.max(0, (c.escrowCents || 0) - (c.paidOutCents || 0));
                earned += residualBonus;
                c.paidOutCents = (c.paidOutCents || 0) + residualBonus;
                c.status="completed";
                data.stats.totalContractsCompleted=(data.stats.totalContractsCompleted||0)+1;
            }
            data.stats.totalItemsSubmitted=(data.stats.totalItemsSubmitted||0)+actual;
            data.stats.totalRewardsPaid=(data.stats.totalRewardsPaid||0)+earned;
            this.#queueRewardObligation(data, obligationId, player, id, earned, 0, "Contribution reward");
            // Phase 7.4 (v0.21.3) (S9): Reputation already awarded here for
            // contributions (this is the completion path for contribution
            // contracts). The +10 on done is the completion bonus.
            ContractReputation.add(data,player.id,player.name,Math.max(1,Math.floor(actual/16))+(done?10:0),{contributions:1,itemsSubmitted:actual,totalEarnedCents:earned,contractsCompleted:done?1:0});

            // Send items to creator's mailbox (works even if offline!)
            this.#addContractMailbox(data,creatorId,itemId,actual,id,player.name);
            c.updatedAt=now();
            return {actual,done,residualBonus};
        });

        if(!tx.success){
            this.#refundSubmitSurplus(player,itemId,submit,0,id);
            return{success:false,message:`§cSubmit failed: ${tx.error}`};
        }

        this.#refundSubmitSurplus(player,itemId,submit,tx.result.actual,id);

        this.#deliverReward(player,id,earned,0,"Contribution reward",obligationId);
        NotificationService.create(creatorId,{type:"contract",source:"contracts",title:"Contract Delivery",message:`${player.name} submitted ${actual} item(s) to ${id}.`,action:"contracts_mailbox"});
        ContractShardService.moveLegacyMailboxFor(creatorId);
        AuditService.record("contract.submit.contrib", "contracts", player.id, player.name, `Submitted to contrib contract ${id}`, { contractId:id, amount:tx.result.actual, reward:earned, residualBonus: tx.result.residualBonus || 0 });
        const doneMsg = tx.result.done ? `§aContract completed. Earned ${MoneyUtils.formatCents(earned)}` + (tx.result.residualBonus > 0 ? ` §7(includes ${MoneyUtils.formatCents(tx.result.residualBonus)} rounding bonus)` : "") + "." : `§aSubmitted ${tx.result.actual}. Earned ${MoneyUtils.formatCents(earned)}.`;
        return{success:true,message:doneMsg};
    }

    static #submitSingle(player,id,submit,itemId){
        let creatorId="", reward=0, actual=0, done=false;
        const obligationId = rewardObligationId("single_reward");
        const tx=Database.transaction(COLLECTION,data=>{
            const c=data.contracts[id]; if(!c||c.type!=="player_supply"||c.status!=="accepted")throw new Error("Contract changed.");
            actual=Math.min(submit,c.amountRequired-c.amountSubmitted); 
            if(actual<=0)throw new Error("Contract already fulfilled.");
            creatorId=c.creatorId; 
            c.amountSubmitted+=actual; 
            c.deliveries.push({playerId:player.id,playerName:player.name,amount:actual,time:now()}); 
            done=c.amountSubmitted>=c.amountRequired; 
            if(done){
                reward=c.escrowCents; 
                c.status="completed"; 
                // Phase 7.4 (v0.21.3) (CT1): Track paidOutCents.
                c.paidOutCents = (c.paidOutCents || 0) + reward;
                data.stats.totalContractsCompleted=(data.stats.totalContractsCompleted||0)+1; 
                data.stats.totalRewardsPaid=(data.stats.totalRewardsPaid||0)+reward; 
                this.#queueRewardObligation(data, obligationId, player, id, reward, 0, "Contract completion");
                // Phase 7.4 (v0.21.3) (S9): Reputation only on completion (+50).
                ContractReputation.add(data,player.id,player.name,50,{itemsSubmitted:actual,totalEarnedCents:reward,contractsCompleted:1});
            } else {
                ContractReputation.add(data,player.id,player.name,Math.max(1,Math.floor(actual/16)),{itemsSubmitted:actual});
            }
            data.stats.totalItemsSubmitted=(data.stats.totalItemsSubmitted||0)+actual; 
            
            // Queue items to offline player's mailbox
            this.#addContractMailbox(data,creatorId,itemId,actual,id,player.name); 
            c.updatedAt=now(); 
            return {actual,done};
        });
        
        if(!tx.success){
            this.#refundSubmitSurplus(player,itemId,submit,0,id);
            return{success:false,message:`§cSubmit failed: ${tx.error}`};
        }

        this.#refundSubmitSurplus(player,itemId,submit,tx.result.actual,id);
        
        this.#deliverReward(player,id,reward,0,"Contract completion",obligationId);
        NotificationService.create(creatorId,{type:"contract",source:"contracts",title:"Contract Delivery",message:`${player.name} submitted ${actual} item(s).`,action:"contracts_mailbox"});
        ContractShardService.moveLegacyMailboxFor(creatorId);
        AuditService.record("contract.submit.player", "contracts", player.id, player.name, `Submitted to player contract ${id}`, { contractId:id, amount:actual, completed:done, reward });
        return{success:true,message:done?`§aContract completed. Reward pending: ${MoneyUtils.formatCents(reward)}.`:`§aSubmitted ${actual}.`};
    }

    static #addContractMailbox(data,playerId,itemId,amount,contractId,fromName){ 
        if(!data.itemMailbox[playerId])data.itemMailbox[playerId]=[]; 
        data.itemMailbox[playerId].push({id:`mail_${Date.now()}_${Math.floor(Math.random()*1000000)}`,itemId,amount,contractId,fromName,createdAt:now()}); 
        // No count trim: contract mailbox entries are economic obligations. 
    }

    static mailbox(player){
        const legacy = this.db().itemMailbox[player.id] || [];
        const shard = ContractShardService.mailbox(player.id) || [];
        const seen = new Set();
        return [...legacy, ...shard].filter(e => { const id = e?.id || JSON.stringify(e); if (seen.has(id)) return false; seen.add(id); return true; }).sort((a,b)=>(b.createdAt||0)-(a.createdAt||0));
    }
    
    // Phase 1 Fix: Transactional claimMailbox with per-entry safety.
    //
    // Previously, `claimMailbox` iterated the mailbox, called
    // `ContractInventory.add(player, itemId, amount)` (which writes to the
    // player's inventory IMMEDIATELY), and then wrote the `remaining` list
    // back via a SEPARATE `Database.transaction`. If the server crashed
    // between the inventory write and the mailbox update — or if the
    // transaction failed for any reason — items were already in the
    // player's inventory AND the mailbox entry still existed. The next
    // `/claim` would re-deliver the items: infinite dupe.
    //
    // This mirrors the v0.21.1 MK4 fix applied to MarketMailbox.claimAll,
    // adapted for the contract mailbox shape (which only holds items, not
    // money):
    //
    //   1. Each entry is processed in its OWN try/catch. A failure on one
    //      entry never affects the others.
    //   2. Item entries: `ContractInventory.add` returns `{added, remaining}`.
    //      We only count the entry as claimed if `added > 0`. Partial fills
    //      preserve the entry with `amount: add.remaining` so the player
    //      can retry for the rest.
    //   3. Unknown/missing itemId entries are preserved, never discarded.
    //   4. The mailbox mutation is done inside `Database.transaction` so
    //      it is atomic at the DB level. Even though the inventory write
    //      is unavoidably outside the transaction, we use the credit-first
    //      pattern: items are credited BEFORE the mailbox is mutated, and
    //      the mailbox is only mutated if the credit succeeded. If the
    //      transaction fails after credit, we log CRITICAL + audit + the
    //      player keeps the items (rare edge case; the alternative —
    //      trying to "un-add" items — is not safe without a
    //      remove-from-inventory API, so we accept the small surplus in
    //      favor of NEVER losing player items).
    //   5. A `#claimAudit` event is recorded so admins can investigate
    //      any anomalies.
    static claimMailbox(player) {
        const legacyResult = this.#claimMailboxFromCollection(player, COLLECTION);
        let shardResult = { claimed: 0, items: 0, remaining: 0 };
        if (ContractShardService.enabled()) {
            const shardName = ContractShardService.shardName(player.id);
            ContractShardService.shardDB(player.id);
            shardResult = this.#claimMailboxFromCollection(player, shardName);
        }
        return {
            claimed: (legacyResult.claimed || 0) + (shardResult.claimed || 0),
            items: (legacyResult.items || 0) + (shardResult.items || 0),
            remaining: (legacyResult.remaining || 0) + (shardResult.remaining || 0),
            legacy: legacyResult,
            shard: shardResult
        };
    }

    static #claimMailboxFromCollection(player, collectionName) {
        const dbData = collectionName === COLLECTION
            ? Database.collection(collectionName, DEFAULT_CONTRACT_DB, { validate: validateContractData })
            : Database.collection(collectionName, DEFAULT_CONTRACT_MAILBOX_SHARD_DB, { validate: validateContractMailboxShardData });
        const list = dbData.itemMailbox?.[player.id] || [];
        if (!list.length) return { claimed: 0, items: 0, remaining: 0 };
        const credited = [];
        const remaining = [];
        let items = 0;
        let claimedCount = 0;
        for (const e of list) {
            if (!e || typeof e !== "object") { remaining.push(e); continue; }
            try {
                const itemId = e.itemId;
                const amount = Math.max(0, Math.floor(e.amount || 0));
                if (amount <= 0 || !itemId) { claimedCount++; credited.push(e); continue; }
                let add;
                try { add = ContractInventory.add(player, itemId, amount); }
                catch (invErr) { Logger.warn("Contract", `claimMailbox: add threw for ${player.id}, item ${itemId}: ${invErr?.message || invErr}`); remaining.push(e); continue; }
                if (add.added > 0) items += add.added;
                if (add.remaining > 0) {
                    remaining.push({ ...e, amount: add.remaining });
                    if (add.added > 0) { credited.push(e); claimedCount++; }
                } else { credited.push(e); claimedCount++; }
            } catch (err) { Logger.error("Contract", `claimMailbox: entry ${e.id} failed for ${player.id}: ${err?.message || err}. Preserving entry.`); remaining.push(e); }
        }
        if (credited.length === 0) return { claimed: 0, items, remaining: remaining.length };
        const deleteTx = Database.transaction(collectionName, data => {
            const currentList = Array.isArray(data.itemMailbox[player.id]) ? data.itemMailbox[player.id] : [];
            const creditedIds = new Set(credited.map(e => e.id).filter(Boolean));
            const kept = currentList.filter(e => !(e && typeof e === "object" && creditedIds.has(e.id)));
            const existingIds = new Set(kept.map(e => e?.id).filter(Boolean));
            for (const r of remaining) if (r?.id && !existingIds.has(r.id)) kept.push(r); else if (!r?.id) kept.push(r);
            if (kept.length > 0) data.itemMailbox[player.id] = kept; else delete data.itemMailbox[player.id];
            return { remainingCount: kept.length };
        });
        if (!deleteTx.success) {
            Logger.error("Contract", `CRITICAL: claimMailbox delete failed for ${player.id} in ${collectionName}. Potential dupe risk.`, deleteTx.error);
        }
        return { claimed: claimedCount, items, remaining: remaining.length };
    }

    
    static stats(player){const db=this.db(); const idx=db.playerIndex[player.id]||{created:[],accepted:[]}; const shardStats=ContractShardService.stats(player.id); return{created:idx.created.length,accepted:idx.accepted.length,mailbox:(db.itemMailbox[player.id]||[]).length+(shardStats.count||0),rep:db.playerStats[player.id]?.reputation||0};}
    static topReputation(limit=50){return Object.values(this.db().playerStats||{}).sort((a,b)=>(b.reputation||0)-(a.reputation||0)).slice(0,limit);}
    
    /** Phase 2.3: persisted, replay-safe contract GC in batches of 50. */
    static finalizeExpired() {
        const started = BatchTaskService.start("contract_gc", { snapshotTime: now() }, { dedupeKey: "contract_gc" });
        return {
            started: !!started.started,
            taskId: started.task?.id || null,
            message: started.started ? "Contract GC queued as a persisted batch task." : started.message,
            error: started.success ? undefined : started.message
        };
    }

    static #processGCBatch(task) {
        const snapshotTime = Number(task.payload?.snapshotTime) || now();
        const cursorKey = String(task.cursor?.key || "");
        let batch = null;
        const tx = Database.transaction(COLLECTION, data => {
            const ids = Object.keys(data.contracts || {}).sort().filter(id => id > cursorKey).slice(0, 50);
            const effects = [];
            let expired = 0, reset = 0, refundsQueued = 0;
            for (const id of ids) {
                const c = data.contracts[id];
                if (!c) continue;
                let refundReason = "";
                if (c.type === "player_supply" && c.status === "accepted" && c.deadlineAt && c.deadlineAt <= snapshotTime) {
                    refundReason = "player_supply_expired";
                    c.status = "expired"; c.updatedAt = snapshotTime; expired++;
                } else if (c.type === "player_contribution" && c.status === "open" && c.expiresAt && c.expiresAt <= snapshotTime) {
                    refundReason = "player_contribution_expired";
                    c.status = "expired"; c.updatedAt = snapshotTime; expired++;
                }
                if (refundReason) {
                    const amount = Math.max(0, (c.escrowCents || 0) - (c.paidOutCents || 0));
                    if (amount > 0 && c.creatorId && c.creatorId !== "server") {
                        const obligationId = `gc_refund_${c.id}`.substring(0, 80);
                        if (!data.rewardQueue[obligationId]) {
                            data.rewardQueue[obligationId] = {
                                id: obligationId, contractId: c.id, playerId: c.creatorId,
                                playerName: c.creatorName || "Unknown", rewardCents: amount, score: 0,
                                reason: "Contract expired refund", status: "pending",
                                journalId: `reward_${obligationId}`, createdAt: snapshotTime,
                                updatedAt: snapshotTime, attempts: 0, lastError: ""
                            };
                            data.stats.totalRewardsQueued = (data.stats.totalRewardsQueued || 0) + amount;
                            refundsQueued++;
                        }
                        effects.push({ type: "refund_queued", playerId: c.creatorId, playerName: c.creatorName, contractId: c.id, amount, reason: refundReason });
                    }
                }

                if (c.type === "server_market_supply" && c.expiresAt && c.expiresAt <= snapshotTime
                    && (c.status === "active" || (c.status === "completed" && (c.resetMode === "daily" || c.resetMode === "weekly")))) {
                    if (c.resetMode === "daily" || c.resetMode === "weekly") {
                        c.amountSubmitted = 0; c.deliveries = []; c.status = "active"; c.updatedAt = snapshotTime;
                        c.expiresAt = snapshotTime + (c.resetMode === "weekly" ? 7 : 1) * DAY_MS; reset++;
                    } else {
                        c.status = "expired"; c.updatedAt = snapshotTime; expired++;
                    }
                }
            }
            const nextKey = ids.length ? ids[ids.length - 1] : cursorKey;
            const hasMore = Object.keys(data.contracts || {}).some(id => id > nextKey);
            data.stats.lastUpdated = snapshotTime;
            batch = { done: !hasMore, cursor: { key: nextKey }, processed: ids.length, expired, reset, refundsQueued, effects };
            return batch;
        });
        if (!tx.success) return { error: tx.error, retryable: true };
        const previous = task.progress || {};
        const progress = {
            processed: (previous.processed || 0) + batch.processed,
            expired: (previous.expired || 0) + batch.expired,
            reset: (previous.reset || 0) + batch.reset,
            refundsQueued: (previous.refundsQueued || 0) + batch.refundsQueued
        };
        return { done: batch.done, cursor: batch.cursor, progress, resultPatch: progress, effects: batch.effects, flushCollections: [COLLECTION] };
    }

    static #afterGCBatch(effects = []) {
        for (const effect of effects) {
            try {
                NotificationService.create(effect.playerId, {
                    type: "contract", source: "contracts", title: "Contract Expired",
                    message: `Refund of ${MoneyUtils.formatCents(effect.amount)} for ${effect.contractId} was queued for recovery delivery.`, action: "payouts"
                });
            } catch (error) { Logger.debug("Contracts", `GC notification failed for ${effect.playerId}`, error); }
        }
        if (effects.length) AuditService.record("contract.gc.batch", "contracts", "", "system", `Queued ${effects.length} expiry refund obligation(s)`, { effects }, "warn");
    }

    /**
     * Phase 7.4 (v0.21.3) (CT2): Cancel an open player contract and refund
     * the remaining escrow to the creator.
     *
     * - Only the creator (or an admin) can cancel.
     * - Only contracts with status "open" can be cancelled. An "accepted"
     *   player_supply contract cannot be cancelled (the worker may have
     *   already gathered items) — it must wait for expiry.
     * - Refund amount = escrowCents - paidOutCents (the un-paid remainder).
     * - The refund is withdrawn from the "contracts" treasury bucket and
     *   queued as a payout via FinanceService.
     */
    static cancelContract(player, contractIdValue) {
        const c = this.db().contracts[contractIdValue];
        if (!c) return { success: false, message: "§cContract not found." };
        // Permission: creator or admin.
        const isCreator = c.creatorId === player.id;
        const isAdmin = player.hasTag?.(CONFIG.TAGS.ADMIN) || player.hasTag?.(CONFIG.TAGS.OWNER) || player.hasTag?.(CONFIG.TAGS.CONTRACT_ADMIN);
        if (!isCreator && !isAdmin) return { success: false, message: "§cOnly the creator or an admin can cancel." };
        // Only open contracts can be cancelled.
        if (c.status !== "open") return { success: false, message: `§cCannot cancel a ${c.status} contract.` };
        // Server contracts cannot be cancelled this way.
        if (c.type === "server_market_supply") return { success: false, message: "§cServer contracts cannot be cancelled." };
        // Accepted player_supply cannot be cancelled (worker may have items).
        if (c.type === "player_supply" && c.status === "accepted") return { success: false, message: "§cCannot cancel an accepted contract — wait for expiry." };
        
        let refundAmount = 0;
        const tx = Database.transaction(COLLECTION, data => {
            const x = data.contracts[contractIdValue];
            if (!x || x.status !== "open") throw new Error("Contract changed.");
            refundAmount = Math.max(0, (x.escrowCents || 0) - (x.paidOutCents || 0));
            x.status = "cancelled"; x.updatedAt = now();
            if(refundAmount>0){const oid=`cancel_refund_${x.id}`;if(!data.rewardQueue[oid])this.#queueRewardObligation(data,oid,{id:x.creatorId,name:x.creatorName},x.id,refundAmount,0,"Contract cancelled refund");}
            // Phase 7.4 (v0.21.3) (S8): Remove from index incrementally.
            removeFromContractIndex(data, { id: x.id, creatorId: x.creatorId, acceptedBy: x.acceptedBy });
            return { refundAmount };
        });
        
        if (!tx.success) return { success: false, message: `§cCancel failed: ${tx.error}` };
        
        // Deliver the deterministic refund obligation through the durable journal.
        if(refundAmount>0){const oid=`cancel_refund_${contractIdValue}`;const delivery=FinancialJournalService.deliverContractReward({id:c.creatorId,name:c.creatorName},{obligationId:oid,contractId:contractIdValue,rewardCents:refundAmount,score:0,reason:"Contract cancelled refund",operationId:`reward_${oid}`});if(!delivery.success)Logger.warn("Contracts",`Cancel refund ${oid} is pending recovery.`);}
        NotificationService.create(c.creatorId, { type: "contract", source: "contracts", title: "Contract Cancelled", message: `Contract ${c.title} was cancelled. Refund: ${MoneyUtils.formatCents(refundAmount)}.`, action: "payouts" });
        return { success: true, message: `§aContract cancelled. Refund: §e${MoneyUtils.formatCents(refundAmount)}§a.` };
    }
}

export default ContractService;