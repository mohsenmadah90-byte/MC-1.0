// Per-player leaderboard visibility preferences.
const MONEY_KEY = "mcity_show_money_leaderboard";
const LEVEL_KEY = "mcity_show_level_leaderboard";
export class LeaderboardSettingsService {
 static moneyVisible(player){try{return player.getDynamicProperty(MONEY_KEY)!==false;}catch{return true;}}
 static levelVisible(player){try{return player.getDynamicProperty(LEVEL_KEY)!==false;}catch{return true;}}
 static setMoneyVisible(player,value){try{player.setDynamicProperty(MONEY_KEY,!!value);return true;}catch{return false;}}
 static setLevelVisible(player,value){try{player.setDynamicProperty(LEVEL_KEY,!!value);return true;}catch{return false;}}
 static stats(player){return{money:this.moneyVisible(player),level:this.levelVisible(player)};}
}
export default LeaderboardSettingsService;
