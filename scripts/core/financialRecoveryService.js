// MCity Dashboard V2 - Financial Recovery and Reconciliation
// Phase 3.4: bounded audit-first diagnostics over Part 3 financial primitives.

import { CONFIG } from "../config.js";
import { Database } from "./database.js";
import { BatchTaskService } from "./batchTaskService.js";
import { OperationJournalService } from "./operationJournalService.js";
import { AppliedOperationStore } from "./appliedOperationStore.js";
import { Logger } from "./logger.js";
import { DisposableRegistry } from "./disposableRegistry.js";
import { DEFAULT_FINANCIAL_RECOVERY_DB, validateFinancialRecoveryData } from "../schemas/financialRecoverySchema.js";
import { DEFAULT_MONEY_DB, validateMoneyData } from "../schemas/moneySchema.js";
import { DEFAULT_FINANCE_DB, validateFinanceData } from "../schemas/financeSchema.js";
import { DEFAULT_LEVEL_DB, validateLevelData } from "../schemas/levelSchema.js";
import { DEFAULT_MARKET_DB, validateMarketData } from "../schemas/marketSchema.js";
import { FinanceService } from "../modules/finance/financeService.js";

const COLLECTION="financial_recovery"; const BATCH=25;
function now(){return Date.now();} function clone(v){return JSON.parse(JSON.stringify(v));}
function reportId(){return `reconcile_${Date.now()}_${Math.floor(Math.random()*1_000_000)}`;}

export class FinancialRecoveryService {
 static #initialized=false;
 static initialize(){if(this.#initialized)return;this.#initialized=true;this.db();BatchTaskService.register("financial_reconcile",{process:t=>this.#process(t)});DisposableRegistry.registerShutdownCleanup("FinancialRecoveryService.lifecycle",()=>{this.#initialized=false;});Logger.startup("FinancialRecovery","Financial reconcile service initialized");}
 static db(){return Database.collection(COLLECTION,DEFAULT_FINANCIAL_RECOVERY_DB,{validate:validateFinancialRecoveryData});}
 static start(mode="AUDIT_ONLY",actor="system"){
  this.initialize(); mode=mode==="RECOVER_SAFE"?"RECOVER_SAFE":"AUDIT_ONLY"; const gate=this.#gate(); if(!gate.success)return gate;
  const id=reportId(),started=now();
  const tx=Database.transaction(COLLECTION,d=>{d.reports[id]={id,status:"queued",mode,stage:"operations",findings:[],findingCount:0,counts:{operations:0,financePlayers:0,recovered:0},components:{},revisions:{started:this.#revisions()},taskId:"",actor:String(actor).slice(0,64),startedAt:started,updatedAt:started,completedAt:0,lastError:""};d.order.push(id);d.stats.totalStarted=(d.stats.totalStarted||0)+1;d.stats.lastUpdated=started;});
  if(!tx.success||!Database.flushCritical(COLLECTION,"financial_reconcile_report_start").ok)return{success:false,error:tx.error||"Report flush failed"};
  const task=BatchTaskService.start("financial_reconcile",{reportId:id,mode},{id:`financial_reconcile_${id}`,dedupeKey:`financial_reconcile:${id}`});
  if(!task.success)return{success:false,error:task.message,reportId:id};
  Database.transaction(COLLECTION,d=>{d.reports[id].taskId=task.task.id;d.reports[id].status="running";d.reports[id].updatedAt=now();});Database.flushCritical(COLLECTION,"financial_reconcile_task_link");
  return{success:true,reportId:id,taskId:task.task.id,mode};
 }
 static report(id){const r=this.db().reports?.[id];return r?clone(r):null;}
 static latest(){const d=this.db();for(let i=(d.order||[]).length-1;i>=0;i--){const r=d.reports[d.order[i]];if(r)return clone(r);}return null;}
 static stats(){const d=this.db(),latest=this.latest();return{stored:Object.keys(d.reports||{}).length,active:Object.values(d.reports||{}).filter(r=>["queued","running"].includes(r.status)).length,latest,stats:clone(d.stats||{})};}
 static recoverOperation(operationId){const gate=this.#gate();if(!gate.success)return gate;return OperationJournalService.recover(operationId);}
 static requeueDeadLetter(operationId,actor="admin"){const gate=this.#gate();if(!gate.success)return gate;const result=OperationJournalService.requeueDeadLetter(operationId);if(result.success)Logger.warn("FinancialRecovery",`Dead-letter ${operationId} requeued by ${actor}`);return result;}
 static #gate(){const runtime=Database.runtimeStatus();if(runtime.mode!=="NORMAL")return{success:false,errorCode:"FINANCIAL_RECOVERY_DB_MODE",error:`Database mode ${runtime.mode} rejects financial recovery`};return{success:true};}
 static #process(task){
  const id=task.payload.reportId,mode=task.payload.mode; const report=this.report(id); if(!report)return{error:"Reconcile report missing",retryable:false};
  const cursor=task.cursor||{}; const stage=Number(cursor.stage)||0;
  if(stage===0)return this.#scanOperations(id,mode,cursor);
  if(stage===1)return this.#scanFinance(id,cursor);
  if(stage===2)return this.#scanLedger(id,cursor);
  return this.#finalize(id);
 }
 static #scanOperations(id,mode,cursor){
  const shards=OperationJournalService.operationCollections();let si=Number(cursor.shard)||0,offset=Number(cursor.offset)||0;
  if(si>=shards.length)return{done:false,cursor:{stage:1,shard:0,offset:0},progress:{stage:"finance"},flushCollections:[COLLECTION]};
  const name=shards[si],before=Database.stats(name)?.revision||0,part=OperationJournalService.inspectOperations(name,offset,BATCH);const findings=[];let recovered=0;
  for(const op of part.operations){findings.push(...this.#inspectOperation(op));if(mode==="RECOVER_SAFE"&&!['completed','cancelled','dead_letter'].includes(op.status)){const r=OperationJournalService.recover(op.operationId,{force:true});if(r.success)recovered++;}}
  const after=Database.stats(name)?.revision||0;if(mode==="AUDIT_ONLY"&&before!==after)findings.push(this.#finding("RECONCILE_REVISION_CHANGED","warn","operations",{collection:name,expected:before,actual:after,detail:"Operation shard changed during audit"}));
  this.#append(id,findings,{operations:part.operations.length,recovered},"operations");offset+=part.operations.length;if(offset>=part.total){si++;offset=0;}
  return{done:false,cursor:{stage:0,shard:si,offset},progress:{stage:"operations",shardsCompleted:si,totalShards:shards.length},flushCollections:[COLLECTION]};
 }
 static #scanFinance(id,cursor){
  const collections=FinanceService.allPayoutCollections();let si=Number(cursor.shard)||0,offset=Number(cursor.offset)||0;
  if(si>=collections.length)return{done:false,cursor:{stage:2,shard:0,offset:0},progress:{stage:"ledger"},flushCollections:[COLLECTION]};
  const name=collections[si],db=Database.collection(name,DEFAULT_FINANCE_DB,{validate:validateFinanceData}),before=Database.stats(name)?.revision||0;
  const players=[...new Set([...Object.keys(db.payouts||{}),...Object.keys(db.playerSummary||{}),...Object.keys(db.claimLocks||{})])];const slice=players.slice(offset,offset+BATCH),findings=[];
  for(const pid of slice){const list=db.payouts?.[pid]||[],sum=list.reduce((s,p)=>s+Math.max(0,Number(p.amount)||0),0),summary=Math.max(0,Number(db.playerSummary?.[pid]?.totalPending)||0);if(sum!==summary)findings.push(this.#finding("PAYOUT_SUMMARY_MISMATCH","error","finance",{collection:name,playerId:pid,expected:sum,actual:summary}));const lock=db.claimLocks?.[pid];if(lock){const op=OperationJournalService.operation(lock.operationId);if(!op||["completed","cancelled"].includes(op.status))findings.push(this.#finding("PAYOUT_CLAIM_LOCK_ORPHAN","error","finance",{collection:name,playerId:pid,operationId:lock.operationId,detail:"Claim lock has no active operation"}));}}
  const after=Database.stats(name)?.revision||0;if(before!==after)findings.push(this.#finding("RECONCILE_REVISION_CHANGED","warn","finance",{collection:name,expected:before,actual:after}));this.#append(id,findings,{financePlayers:slice.length},"finance");offset+=slice.length;if(offset>=players.length){si++;offset=0;}
  return{done:false,cursor:{stage:1,shard:si,offset},progress:{stage:"finance",shardsCompleted:si,totalShards:collections.length},flushCollections:[COLLECTION]};
 }
 static #scanLedger(id,cursor){
  const base=FinanceService.db(),findings=[],seen=new Set();for(const e of base.transactions||[]){if(seen.has(e.id))findings.push(this.#finding("LEDGER_DUPLICATE_ID","error","ledger",{collection:CONFIG.FINANCE.COLLECTION,detail:`Duplicate ledger id ${e.id}`}));seen.add(e.id);if(base.ledgerIndex?.[e.id]===undefined)findings.push(this.#finding("LEDGER_INDEX_MISMATCH","error","ledger",{collection:CONFIG.FINANCE.COLLECTION,detail:`Missing index ${e.id}`}));}
  const stats=FinanceService.getStats(),created=Number(stats.stats.totalPayoutAmountCreated)||0,claimed=Number(stats.stats.totalPayoutAmountClaimed)||0,pending=Number(stats.pendingAmount)||0,legacyIncomplete=!stats.ledgerMeta?.legacyMigrationComplete;
  let payoutStatus="PASS";if(legacyIncomplete)payoutStatus="INCONCLUSIVE";else if(created-claimed!==pending){payoutStatus="FAIL";findings.push(this.#finding("PAYOUT_CREATED_AMOUNT_MISMATCH","critical","invariant",{expected:created-claimed,actual:pending,detail:"created - claimed != pending"}));}
  const market=Database.collection(CONFIG.MARKET.COLLECTION,DEFAULT_MARKET_DB,{validate:validateMarketData});let marketFailures=0;const bookIds=new Set();for(const book of Object.values(market.orders||{}))for(const order of [...(book.bids||[]),...(book.asks||[])])if(order?.status==="open")bookIds.add(order.id);for(const orders of Object.values(market.playerOrders||{}))for(const order of Object.values(orders||{})){if(order?.status!=="open")continue;const expected=order.type==="buy"?(order.pricePerItem||0)*(order.remaining||0):(order.remaining||0),actual=order.type==="buy"?(order.reservedMoney||0):(order.reservedItems||0);if(expected!==actual||!bookIds.has(order.id)){marketFailures++;findings.push(this.#finding("MARKET_RESERVE_MISMATCH","critical","market",{operationId:order.id,expected,actual,detail:bookIds.has(order.id)?"reserve mismatch":"open order missing from book"}));}}
  this.#append(id,findings,{},"ledger",{payoutConservation:{status:payoutStatus,created,claimed,pending},moneyTransfers:{status:"PENDING_FINALIZE"},marketReserve:{status:marketFailures?"FAIL":"PASS",failures:marketFailures},contractEscrow:{status:"NOT_EVALUATED"},atm:{status:"NOT_EVALUATED"},land:{status:"NOT_EVALUATED"}});
  return{done:false,cursor:{stage:3},progress:{stage:"finalize"},flushCollections:[COLLECTION]};
 }
 static #finalize(id){
  const storageFindings=[];for(const name of Database.listCollections()){const status=Database.stats(name)?.status;if(status==="quarantined"||status==="oversize")storageFindings.push(this.#finding(status==="quarantined"?"COLLECTION_QUARANTINED":"COLLECTION_OVERSIZE","critical","storage",{collection:name,detail:`Collection status ${status}`}));}if(storageFindings.length)this.#append(id,storageFindings,{},"storage");
  const tx=Database.transaction(COLLECTION,d=>{const r=d.reports[id];if(!r)throw new Error("Report missing");const transferFailures=r.findings.filter(f=>f.component==="money_transfer"&&["error","critical"].includes(f.severity)).length;const markerFailures=r.findings.filter(f=>f.code.startsWith("OP_MARKER")).length;r.components.moneyTransfers={status:transferFailures?"FAIL":"PASS",failures:transferFailures};r.components.operationMarkers={status:markerFailures?"FAIL":"PASS",failures:markerFailures};const inconclusive=Object.values(r.components).some(c=>c?.status==="INCONCLUSIVE");r.status=inconclusive?"inconclusive":"completed";r.stage="completed";r.completedAt=now();r.updatedAt=now();d.stats.totalCompleted=(d.stats.totalCompleted||0)+1;d.stats.lastUpdated=now();return r;});
  if(!tx.success)return{error:tx.error};return{done:true,cursor:{stage:4},progress:{stage:"completed"},resultPatch:{reportId:id,findingCount:tx.result.findingCount,status:tx.result.status},flushCollections:[COLLECTION]};
 }
 static #inspectOperation(op){
  const f=[];if(op.status==="dead_letter")f.push(this.#finding("DEAD_LETTER_OPERATION","error","operations",{operationId:op.operationId,detail:op.lastError}));
  for(const req of op.markerRequirements||[]){const data=this.#destination(op,req);if(!data){f.push(this.#finding("OP_MARKER_MISSING","error","operations",{operationId:op.operationId,collection:req.collection,detail:"Destination unavailable"}));continue;}const marker=AppliedOperationStore.get(data,op.operationId,req.effectId,req.field);if(!marker)f.push(this.#finding("OP_MARKER_MISSING","error","operations",{operationId:op.operationId,collection:req.collection,detail:`Missing ${req.effectId}`}));else if(Number(marker.amount)!==Number(op.amount)&&!["rollback"].includes(req.effectId))f.push(this.#finding("OP_MARKER_AMOUNT_MISMATCH","error","operations",{operationId:op.operationId,collection:req.collection,expected:op.amount,actual:marker.amount,detail:req.effectId}));}
  if(op.operationType==="money_transfer_cross_shard")f.push(...this.#inspectTransfer(op));
  return f;
 }
 static #inspectTransfer(op){const p=op.payload||{},f=[];if(!p.senderShard||!p.targetShard){f.push(this.#finding("TRANSFER_TERMINAL_STATE_INVALID","critical","money_transfer",{operationId:op.operationId,detail:"Transfer shard routing missing"}));return f;}const s=Database.collection(p.senderShard,DEFAULT_MONEY_DB,{validate:validateMoneyData}).appliedJournals?.[op.operationId]||{},t=Database.collection(p.targetShard,DEFAULT_MONEY_DB,{validate:validateMoneyData}).appliedJournals?.[op.operationId]||{};if(t.credit&&s.rollback)f.push(this.#finding("TRANSFER_CREDIT_AND_ROLLBACK","critical","money_transfer",{operationId:op.operationId}));if(op.status==="completed"&&(!s.debit||!t.credit||s.rollback))f.push(this.#finding("TRANSFER_TERMINAL_STATE_INVALID","critical","money_transfer",{operationId:op.operationId,expected:"debit+credit,no rollback",actual:{s,t}}));if(op.status==="cancelled"&&s.debit&&(!s.rollback||t.credit))f.push(this.#finding("TRANSFER_TERMINAL_STATE_INVALID","critical","money_transfer",{operationId:op.operationId,expected:"rollback,no credit",actual:{s,t}}));return f;}
 static #destination(op,req){try{const meta=Database.getCollectionMeta(req.collection);if(meta)return Database.collection(req.collection,meta.defaultData||{},meta.validator?{validate:meta.validator}:undefined);if(req.field==="appliedJournals"||req.effectId==="claim_credit")return Database.collection(req.collection,DEFAULT_MONEY_DB,{validate:validateMoneyData});if(req.effectId==="contract_score")return Database.collection(req.collection,DEFAULT_LEVEL_DB,{validate:validateLevelData});return Database.collection(req.collection,DEFAULT_FINANCE_DB,{validate:validateFinanceData});}catch{return null;}}
 static #append(id,findings,countPatch,stage,components={}){Database.transaction(COLLECTION,d=>{const r=d.reports[id];if(!r)return;for(const finding of findings){r.findingCount=(r.findingCount||0)+1;if(r.findings.length<500)r.findings.push(finding);}for(const[k,v]of Object.entries(countPatch||{}))r.counts[k]=(r.counts[k]||0)+v;r.components={...(r.components||{}),...components};r.stage=stage;r.status="running";r.updatedAt=now();});}
 static #finding(code,severity,component,extra={}){return{code,severity,component,operationId:extra.operationId||"",collection:extra.collection||"",playerId:extra.playerId||"",expected:extra.expected??null,actual:extra.actual??null,detail:extra.detail||"",at:now()};}
 static #revisions(){const out={};for(const name of Database.listCollections())out[name]=Database.stats(name)?.revision||0;return out;}
}
export default FinancialRecoveryService;
