// MCity Dashboard V2 - Persistent friendship and request service.
import { Database } from "../../core/database.js";
import { DisposableRegistry } from "../../core/disposableRegistry.js";
import { NotificationService } from "../../dashboard/dashboardNotifications.js";
import { DEFAULT_FRIEND_DB, validateFriendData } from "../../schemas/friendSchema.js";

const COLLECTION="friends";
function now(){return Date.now();} function clean(v,max=128){return String(v||"").replace(/[\u0000-\u001f\u007f]/g,"").slice(0,max);}
function blank(id,name){return{playerId:clean(id),playerName:clean(name,64),friends:{},incoming:{},outgoing:{},updatedAt:now()};}
export class FriendService{
 static #initialized=false;
 static initialize(){if(this.#initialized)return;this.#initialized=true;this.db();DisposableRegistry.registerShutdownCleanup("FriendService.lifecycle",()=>{this.#initialized=false;});}
 static shutdown(){this.#initialized=false;}
 static db(){return Database.collection(COLLECTION,DEFAULT_FRIEND_DB,{validate:validateFriendData});}
 static #get(data,id,name=""){if(!data.players[id])data.players[id]=blank(id,name);if(name)data.players[id].playerName=clean(name,64);return data.players[id];}
 static list(player){const p=this.db().players[player.id];return Object.values(p?.friends||{});}
 static requests(player){const p=this.db().players[player.id];return{incoming:Object.values(p?.incoming||{}),outgoing:Object.values(p?.outgoing||{})};}
 static sendRequest(player,target){if(!target||!target.id||target.id===player.id)return{success:false,message:"§cYou cannot send a friend request to yourself."};const tx=Database.transaction(COLLECTION,data=>{const a=this.#get(data,player.id,player.name),b=this.#get(data,target.id,target.name);if(a.friends[target.id])throw new Error("Already friends.");if(a.outgoing[target.id]||b.incoming[player.id])throw new Error("Friend request already exists.");const r={playerId:player.id,playerName:clean(player.name,64),createdAt:now()};a.outgoing[target.id]=r;b.incoming[player.id]={playerId:player.id,playerName:clean(player.name,64),createdAt:r.createdAt};a.updatedAt=b.updatedAt=now();return r;});if(tx.success){try{NotificationService.create(target.id,{type:"friend_request",source:"friends",title:"New Friend Request",message:`${player.name} sent you a friend request.`,action:"friends"});}catch{}}return tx.success?{success:true,message:"§aFriend request sent."}:{success:false,message:`§c${tx.error}`};}
 static respond(player,senderId,accept){const id=clean(senderId);const tx=Database.transaction(COLLECTION,data=>{const me=this.#get(data,player.id,player.name),other=this.#get(data,id);if(!me.incoming[id])throw new Error("Friend request not found.");delete me.incoming[id];delete other.outgoing[player.id];if(accept){const a={playerId:id,playerName:other.playerName,addedAt:now()},b={playerId:player.id,playerName:me.playerName,addedAt:a.addedAt};me.friends[id]=a;other.friends[player.id]=b;}me.updatedAt=other.updatedAt=now();return true;});return tx.success?{success:true,message:accept?"§aFriend request accepted.":"§eFriend request rejected."}:{success:false,message:`§c${tx.error}`};}
 static remove(player,targetId){const id=clean(targetId);const tx=Database.transaction(COLLECTION,data=>{const a=this.#get(data,player.id,player.name),b=this.#get(data,id);delete a.friends[id];delete b.friends[player.id];delete a.outgoing[id];delete b.incoming[player.id];a.updatedAt=b.updatedAt=now();});return tx.success?{success:true,message:"§aFriend removed."}:{success:false,message:`§c${tx.error}`};}
 static isFriend(playerId,targetId){return !!this.db().players[playerId]?.friends?.[targetId];}
}
export default FriendService;
