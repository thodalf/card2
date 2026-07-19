import { useState, useEffect, useRef } from 'react'
import { Copy, Volume2, VolumeX, Home, BookOpen, Wifi, Play, Users, Check, X, Zap, Bot, Layers, Plus, Trash2, Star, UserCircle, LogIn, LogOut, Mail, Lock, RefreshCw, Swords, Gift, ArrowRightLeft, Sparkles, Store, Coins, Bell, UserPlus, Send } from 'lucide-react'
import {
  genRoomCode, createRoom, joinRoom, pushState, subscribeRoom, removeRoom,
  onAuthChange, registerWithEmail, loginWithEmail, loginWithGoogle, logout, completeRedirectLogin,
  reauthenticate, deleteAccountData, deleteCurrentAccount,
  updateDisplayName, currentUserSnapshot,
  loadCloudDecks, saveCloudDecks, subscribeStats, recordGameResult,
  joinMatchmaking, leaveMatchmaking, publishMatchResult, subscribeMatchResult, clearMatchResult,
  loadCloudCollection, saveCloudCollection, loadCloudLastBooster, saveCloudLastBooster,
  loadCloudEconomy, saveCloudEconomy, loadCloudDeletedIds, saveCloudDeletedIds,
  claimUsername, getUidByPseudo, sendFriendRequest, respondFriendRequest,
  subscribeFriends, subscribeFriendRequests,
  pushNotification, subscribeNotifications, markNotificationRead, markAllNotificationsRead,
} from './firebase.js'

// Nukes any service-worker cache so a stale PWA build can't keep serving old code
async function forceClearCacheAndReload() {
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations()
      await Promise.all(regs.map(r => r.unregister()))
    }
    if ('caches' in window) {
      const keys = await caches.keys()
      await Promise.all(keys.map(k => caches.delete(k)))
    }
  } finally {
    window.location.reload()
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════
const CORNERS   = [[0,0],[0,4],[4,0],[4,4]]
const P1_ROWS   = [0, 1]
const P2_ROWS   = [3, 4]
const FRESH_ACTIONS = {placement:1,moves:2,attack:1}
// A turn must include at least one placement, move or attack before it can end
const hasActedThisTurn = al => al.placement<FRESH_ACTIONS.placement||al.moves<FRESH_ACTIONS.moves||al.attack<FRESH_ACTIONS.attack
const GRID_KEYS = [
  ['topLeft','top','topRight'],
  ['left',null,'right'],
  ['bottomLeft','bottom','bottomRight'],
]

const isCorner      = (r,c) => CORNERS.some(([br,bc])=>br===r&&bc===c)
const isDynBlock    = (game,r,c) => (game.blockedCells||[]).some(([br,bc])=>br===r&&bc===c)
const isCellBlocked = (game,r,c) => isCorner(r,c)||isDynBlock(game,r,c)
const inZone        = (r,p) => p===1 ? P1_ROWS.includes(r) : P2_ROWS.includes(r)
const isCardinal    = (r1,c1,r2,c2) => Math.abs(r1-r2)+Math.abs(c1-c2)===1
const isAdjacent    = (r1,c1,r2,c2) => Math.max(Math.abs(r1-r2),Math.abs(c1-c2))===1

// ═══════════════════════════════════════════════════════════════════════════════
//  CARD GENERATION
// ═══════════════════════════════════════════════════════════════════════════════
const rnd  = (lo,hi) => Math.floor(Math.random()*(hi-lo+1))+lo
const shuf = a => { const b=[...a]; for(let i=b.length-1;i>0;i--){const j=rnd(0,i);[b[i],b[j]]=[b[j],b[i]]}; return b }

// Each points tier draws its portrait from a small free pool for visual variety.
// The rest of the roster is sold as cosmetic skins in the shop (see SKIN_CATALOG)
// and only joins this pool — for THIS account's random cards — once purchased.
const CARD_IMAGE_TIERS = {
  weak:   ['gnome.png'],
  medium: ['elf.png'],
  strong: ['dragon.png'],
}
const SKIN_CATALOG = [
  {id:'hobbit',       file:'hobbit.png',       name:'Hobbit',          tier:'weak',   price:50},
  {id:'elf_noir',     file:'elf_noir.png',     name:'Elfe noir',       tier:'medium', price:100},
  {id:'orc',          file:'orc.png',          name:'Orc',             tier:'medium', price:100},
  {id:'nain_femme',   file:'nain_femme.png',   name:'Naine',           tier:'medium', price:100},
  {id:'nain',         file:'nain.png',         name:'Nain',            tier:'medium', price:100},
  {id:'bard',         file:'bard.png',         name:'Barde',           tier:'medium', price:100},
  {id:'elf_foret',    file:'elf_foret.png',    name:'Elfe des forêts', tier:'medium', price:100},
  // No standalone image file — composited live from elfsansfond.png + fondforet.png
  // (see PARALLAX_SKINS below), and animated with a parallax shift when zoomed.
  // Priced above the usual cosmetic skin to reflect the extra effect.
  {id:'elf_sylvestre',file:'elf_sylvestre.png',name:'Elfe sylvestre',  tier:'strong', price:250},
  {id:'roi',          file:'roi.png',          name:'Roi',             tier:'strong', price:200},
]
// Keyed by the (possibly virtual, see elf_sylvestre above) filename a card would
// otherwise show. When zoomed, the two layers animate with a differing amount of
// drift each — the foreground swings noticeably more than the background — which
// is what actually reads as parallax; riding the shared idle-tilt rotation alone
// moves both layers as one rigid body and cancels the depth cue out.
const PARALLAX_SKINS={'elf_sylvestre.png':{bg:'fondforet.png',fg:'elfsansfond.png'}}
function pickCardImage(total,ownedSkins){
  const tier=total<=20?'weak':total<=28?'medium':'strong'
  const owned=SKIN_CATALOG.filter(s=>s.tier===tier&&(ownedSkins||[]).includes(s.id)).map(s=>s.file)
  const pool=[...CARD_IMAGE_TIERS[tier],...owned]
  return `/images/card/${pool[rnd(0,pool.length-1)]}`
}
// Portraits the Deck Builder gallery can offer — the free set plus any owned skins
const FREE_CARD_IMAGES=['gnome.png','elf.png','dragon.png'].map(f=>`/images/card/${f}`)
function cardImageGallery(ownedSkins){
  const owned=SKIN_CATALOG.filter(s=>(ownedSkins||[]).includes(s.id)).map(s=>`/images/card/${s.file}`)
  return [...FREE_CARD_IMAGES,...owned]
}
// Every portrait that could possibly appear in a match (free tiers + every purchasable
// skin, owned or not — an opponent in online play may have skins we don't) plus the
// board background, preloaded on the match-start loading screen.
// PARALLAX_SKINS' fg/bg layers aren't referenced by any SKIN_CATALOG `file`
// entry directly (only the flat composite is), so they'd otherwise never be
// preloaded and would pop in the first time that card gets zoomed.
const ALL_MATCH_IMAGES=[...FREE_CARD_IMAGES,...SKIN_CATALOG.map(s=>`/images/card/${s.file}`),'/images/plateau.png',
  ...Object.values(PARALLAX_SKINS).flatMap(l=>[`/images/card/${l.bg}`,`/images/card/${l.fg}`])]
// App-boot preload set: every match image (so the first match never pops in) plus the
// two menu background variants (landscape/portrait) and the menu music track — the
// one audio file guaranteed to play within seconds of the app opening.
const BOOT_IMAGES=['/images/menu.png','/images/menuvertical.png',...ALL_MATCH_IMAGES]
const BOOT_AUDIO=['/musiques/menu.mp3']
function preloadImage(src){
  return new Promise(resolve=>{
    const img=new window.Image()
    img.onload=img.onerror=resolve
    img.src=src
  })
}
function preloadAudio(src){
  return new Promise(resolve=>{
    const audio=new window.Audio()
    const done=()=>resolve()
    audio.addEventListener('canplaythrough',done,{once:true})
    audio.addEventListener('error',done,{once:true})
    setTimeout(done,4000) // don't let one slow/unbuffered track stall the whole boot screen
    audio.preload='auto'
    audio.src=src
  })
}
function genValues(total) {
  // Each value is 1–9: distribute (total - 8) extra points across 8 slots of [0, 8]
  const extra=total-8
  const v=Array(8).fill(0);let rem=extra
  for(let i=0;i<7;i++){const slots=7-i;const lo=Math.max(0,rem-8*slots),hi=Math.min(8,rem);v[i]=rnd(lo,hi);rem-=v[i]}
  v[7]=rem;const s=shuf(v)
  return {topLeft:s[0]+1,top:s[1]+1,topRight:s[2]+1,left:s[3]+1,right:s[4]+1,bottomLeft:s[5]+1,bottom:s[6]+1,bottomRight:s[7]+1}
}
function genDeckTotals() {
  const t=[[15,20],[15,20],[24,28],[24,28],[32,42],[32,42]]
  for(let i=0;i<3000;i++){const r=t.map(([lo,hi])=>rnd(lo,hi));if(r.reduce((a,b)=>a+b,0)===150)return r}
  return [15,15,25,25,35,35]
}
function genDeck(owner,ownedSkins) {
  return shuf(genDeckTotals()).map((total,i)=>{
    const values=genValues(total)
    const imageUrl=pickCardImage(total,ownedSkins)
    return {id:`${owner}-${i}-${Date.now()}-${Math.random().toString(36).slice(2)}`,owner,total,values,baseValues:{...values},imageUrl}
  })
}

// ═══════════════════════════════════════════════════════════════════════════════
//  DECK BUILDER — storage & helpers
// ═══════════════════════════════════════════════════════════════════════════════
const DECKS_KEY='tacticalcards_decks'
const DECK_MAX_POINTS=150
const CARD_MAX_POINTS=40
const DECK_MAX_CARDS=10
const FACE_KEYS=['topLeft','top','topRight','left','right','bottomLeft','bottom','bottomRight']

function loadDecks(){
  try{return JSON.parse(localStorage.getItem(DECKS_KEY)||'[]')}catch{return[]}
}
function saveDecks(decks){
  try{localStorage.setItem(DECKS_KEY,JSON.stringify(decks))}
  catch(e){console.error('saveDecks failed — deck changes (including card images) were NOT persisted:',e)}
}

const COINS_KEY='tacticalcards_coins'
const COINS_UPDATED_KEY='tacticalcards_coins_updated_at'
function loadCoins(){try{return Number(localStorage.getItem(COINS_KEY)||0)}catch{return 0}}
function saveCoins(n){try{localStorage.setItem(COINS_KEY,String(n))}catch(e){console.error('saveCoins failed:',e)}}
function loadCoinsUpdatedAt(){try{return Number(localStorage.getItem(COINS_UPDATED_KEY)||0)}catch{return 0}}
function saveCoinsUpdatedAt(ts){try{localStorage.setItem(COINS_UPDATED_KEY,String(ts))}catch{}}

const OWNED_SKINS_KEY='tacticalcards_owned_skins'
function loadOwnedSkins(){try{return JSON.parse(localStorage.getItem(OWNED_SKINS_KEY)||'[]')}catch{return[]}}
function saveOwnedSkins(arr){try{localStorage.setItem(OWNED_SKINS_KEY,JSON.stringify(arr))}catch(e){console.error('saveOwnedSkins failed:',e)}}

const SOUND_PREF_KEY='tacticalcards_sound_on'
function loadSoundPref(){
  try{const v=localStorage.getItem(SOUND_PREF_KEY);return v===null?true:v==='1'}catch{return true}
}
function saveSoundPref(on){
  try{localStorage.setItem(SOUND_PREF_KEY,on?'1':'0')}catch{}
}

const MUSIC_VOLUME_PREF_KEY='tacticalcards_music_volume'
function loadMusicVolumePref(){
  try{const v=parseFloat(localStorage.getItem(MUSIC_VOLUME_PREF_KEY));return Number.isFinite(v)?Math.min(1,Math.max(0,v)):0.5}catch{return 0.5}
}
function saveMusicVolumePref(v){
  try{localStorage.setItem(MUSIC_VOLUME_PREF_KEY,String(v))}catch{}
}

const TUTORIAL_SEEN_KEY='tacticalcards_tutorial_seen'
function loadTutorialSeen(){try{return localStorage.getItem(TUTORIAL_SEEN_KEY)==='1'}catch{return false}}
function saveTutorialSeen(){try{localStorage.setItem(TUTORIAL_SEEN_KEY,'1')}catch{}}
const DECK_TUTORIAL_SEEN_KEY='tacticalcards_deck_tutorial_seen'
function loadDeckTutorialSeen(){try{return localStorage.getItem(DECK_TUTORIAL_SEEN_KEY)==='1'}catch{return false}}
function saveDeckTutorialSeen(){try{localStorage.setItem(DECK_TUTORIAL_SEEN_KEY,'1')}catch{}}
const DEFAULT_CARD_IMAGE='/images/card/gnome.png'
function customCardPts(card){
  return FACE_KEYS.reduce((s,k)=>s+(card.values[k]||0),0)
}
function deckTotalPts(deck){
  return (deck?.cards||[]).reduce((s,c)=>s+customCardPts(c),0)
}
function isDeckValid(deck){
  if(!deck||!deck.cards||deck.cards.length===0)return false
  if(deck.cards.length>DECK_MAX_CARDS)return false
  // Booster-sourced cards (c.rarity set) are exempt from the per-card cap — that's
  // the whole point of a rare pull. The deck total cap still keeps things balanced.
  if(deck.cards.some(c=>!c.rarity&&customCardPts(c)>CARD_MAX_POINTS))return false
  if(deckTotalPts(deck)>DECK_MAX_POINTS)return false
  return true
}
function invertValues180(v){
  return {top:v.bottom,bottom:v.top,left:v.right,right:v.left,topLeft:v.bottomRight,bottomRight:v.topLeft,topRight:v.bottomLeft,bottomLeft:v.topRight}
}
function deckToHandCards(deck,owner){
  // Cards are designed in the Deck Builder facing "down" (Player 1's orientation).
  // Player 2 sits on the opposite side of the board, so their custom cards are
  // rotated 180° here to keep the designed front-facing values pointed at the enemy.
  return deck.cards.map((c,i)=>{
    const values=owner===2?invertValues180(c.values):{...c.values}
    return{
      id:`${owner}-${i}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      owner, total:customCardPts(c), values, baseValues:{...values}, imageUrl:c.imageUrl||null,
    }
  })
}

// ═══════════════════════════════════════════════════════════════════════════════
//  CARD COLLECTION & BOOSTER PACKS
// ═══════════════════════════════════════════════════════════════════════════════
const COLLECTION_KEY='tacticalcards_collection'
const LAST_BOOSTER_KEY='tacticalcards_last_booster'
const BOOSTER_COOLDOWN_MS=24*60*60*1000

function loadCollection(){
  try{return JSON.parse(localStorage.getItem(COLLECTION_KEY)||'[]')}catch{return[]}
}
function saveCollection(cards){
  try{localStorage.setItem(COLLECTION_KEY,JSON.stringify(cards))}catch{}
}

// Tombstones — ids of sold/deleted decks or collection cards. Only ever grows
// (a plain array union is always a safe merge), and lets mergeById tell "deleted
// elsewhere" apart from "not seen by this device yet".
const DELETED_COLLECTION_KEY='tacticalcards_deleted_collection_ids'
const DELETED_DECKS_KEY='tacticalcards_deleted_deck_ids'
function loadDeletedIds(key){try{return JSON.parse(localStorage.getItem(key)||'[]')}catch{return[]}}
function saveDeletedIds(key,ids){try{localStorage.setItem(key,JSON.stringify(ids))}catch(e){console.error('saveDeletedIds failed:',e)}}
function loadLastBoosterAt(){
  try{return Number(localStorage.getItem(LAST_BOOSTER_KEY)||0)}catch{return 0}
}
function saveLastBoosterAt(ts){
  try{localStorage.setItem(LAST_BOOSTER_KEY,String(ts))}catch{}
}
function msUntilNextBooster(lastAt){
  return Math.max(0,BOOSTER_COOLDOWN_MS-(Date.now()-(lastAt||0)))
}
// Clears the locally-cached copy of account-bound game data after a deletion —
// otherwise a future login/merge (mergeById in App) would read this device's
// stale local copy and silently resurrect decks/coins the user just deleted.
// Device-only preferences (sound, music volume, tutorial-seen) are left alone.
function clearLocalAccountData(){
  [DECKS_KEY,COINS_KEY,COINS_UPDATED_KEY,OWNED_SKINS_KEY,COLLECTION_KEY,LAST_BOOSTER_KEY,DELETED_COLLECTION_KEY,DELETED_DECKS_KEY]
    .forEach(k=>{try{localStorage.removeItem(k)}catch{}})
}
function boosterCardRarity(total){
  if(total>60)return 'legendary'
  if(total>50)return 'ultra'
  if(total>40)return 'rare'
  if(total>=25)return 'uncommon'
  return 'common'
}
function genBoosterCardTotal(){
  const roll=Math.random()
  // Breaks the normal 40-pt cap, <1% chance — lands as rare/ultra/legendary
  // depending on where in 41-64 it falls (see boosterCardRarity)
  if(roll<0.007)return rnd(41,64)
  if(roll<0.10)return rnd(33,40)   // uncommon (33-40)
  if(roll<0.35)return rnd(25,32)   // uncommon (25-32)
  return rnd(8,24)                 // common
}
function genBoosterCard(ownedSkins){
  const total=genBoosterCardTotal()
  const values=genValues(total)
  const rarity=boosterCardRarity(total)
  const imageUrl=pickCardImage(total,ownedSkins)
  return{id:`bc-${Date.now()}-${Math.random().toString(36).slice(2)}`,values,imageUrl,rarity,total,obtainedAt:Date.now()}
}
function openBoosterPack(ownedSkins){
  return Array.from({length:4},()=>genBoosterCard(ownedSkins))
}
const BOOSTER_COIN_MIN=10, BOOSTER_COIN_MAX=25
const SELL_VALUE={common:5,uncommon:12,rare:30,ultra:60,legendary:100}
const ONLINE_WIN_COIN_REWARD=20
// Lower than the online reward — an AI match can be replayed instantly with no
// real cost or wait, unlike finding an online opponent, so it stays a smaller trickle.
const AI_WIN_COIN_REWARD=8
const BOOSTER_PURCHASE_PRICE=300

// ═══════════════════════════════════════════════════════════════════════════════
//  POWER DECK
// ═══════════════════════════════════════════════════════════════════════════════
const POWER_INFO = {
  buff:   {name:'Amplification',desc:'+1 à toutes les valeurs d\'une carte alliée',       icon:'⬆',border:'border-emerald-500',bg:'from-emerald-950 to-emerald-800',glow:'shadow-[0_0_10px_rgba(16,185,129,0.35)]'},
  recall: {name:'Rappel',       desc:'Retourner une carte alliée en main',                icon:'↩',border:'border-sky-500',    bg:'from-sky-950 to-sky-800',        glow:'shadow-[0_0_10px_rgba(14,165,233,0.35)]'},
  switch: {name:'Rotation',     desc:'Permuter les valeurs (rotation 90°)',               icon:'⟳',border:'border-amber-400',  bg:'from-amber-950 to-amber-800',    glow:'shadow-[0_0_10px_rgba(245,158,11,0.35)]'},
  block:  {name:'Barrage',      desc:'Bloquer définitivement un emplacement vide',        icon:'⊘',border:'border-rose-500',   bg:'from-rose-950 to-rose-900',      glow:'shadow-[0_0_10px_rgba(239,68,68,0.35)]'},
}
const TERRAIN = [
  {gradient:'linear-gradient(135deg,#0d2b1a,#1a4a2f,#0f3520)', imageUrl:null, label:'Forêt'},
  {gradient:'linear-gradient(135deg,#2a2824,#433d36,#2d2820)', imageUrl:null, label:'Roche'},
  {gradient:'linear-gradient(135deg,#0d1f3a,#143060,#0a1828)', imageUrl:null, label:'Eau'},
  {gradient:'linear-gradient(135deg,#3a2a10,#5a4218,#3d2c12)', imageUrl:null, label:'Terre'},
  {gradient:'linear-gradient(135deg,#3a0d0d,#5c1810,#3d0e0a)', imageUrl:null, label:'Lave'},
]
function genBoardTiles(){
  return Array(5).fill(null).map(()=>Array(5).fill(null).map(()=>Math.floor(Math.random()*TERRAIN.length)))
}
function rotateValues(v) {
  return {top:v.left,right:v.top,bottom:v.right,left:v.bottom,topLeft:v.bottomLeft,topRight:v.topLeft,bottomRight:v.topRight,bottomLeft:v.bottomRight}
}
function isValidPowerTarget(game,type,player,r,c) {
  if(isCellBlocked(game,r,c)) return false
  const cell=game.board[r][c]
  switch(type){case 'buff':return !!(cell?.owner===player);case 'recall':return !!(cell?.owner===player);case 'switch':return !!cell;case 'block':return !cell;default:return false}
}
function applyPowerAction(game,type,r,c) {
  const cp=game.currentPlayer; const nb=game.board.map(row=>[...row])
  const hand=game.powerCardHand[cp]||[]
  if(!hand.includes(type))return game
  const removeCard = g => { const h=[...(g.powerCardHand[cp]||[])]; const i=h.indexOf(type); if(i>=0)h.splice(i,1); return {...g,powerCardHand:{...g.powerCardHand,[cp]:h}} }
  if(type==='buff'){const card=nb[r][c];if(!card||card.owner!==cp)return game;nb[r][c]={...card,values:Object.fromEntries(Object.entries(card.values).map(([k,v])=>[k,Math.min(9,v+1)]))};return removeCard({...game,board:nb})}
  if(type==='recall'){const card=nb[r][c];if(!card||card.owner!==cp)return game;nb[r][c]=null;return removeCard({...game,board:nb,players:{...game.players,[cp]:{...game.players[cp],hand:[...game.players[cp].hand,card]}}})}
  if(type==='switch'){const card=nb[r][c];if(!card)return game;nb[r][c]={...card,values:rotateValues(card.values)};return removeCard({...game,board:nb})}
  if(type==='block'){if(nb[r][c])return game;return removeCard({...game,blockedCells:[...(game.blockedCells||[]),[r,c]]})}
  return game
}

// ═══════════════════════════════════════════════════════════════════════════════
//  GAME STATE
// ═══════════════════════════════════════════════════════════════════════════════
function newGame(p1Deck,p2Deck,ownedSkins) {
  return {
    board:Array(5).fill(null).map(()=>Array(5).fill(null)),
    players:{
      1:{hand:isDeckValid(p1Deck)?deckToHandCards(p1Deck,1):genDeck(1,ownedSkins)},
      2:{hand:isDeckValid(p2Deck)?deckToHandCards(p2Deck,2):genDeck(2,ownedSkins)},
    },
    currentPlayer:1, actionsLeft:{...FRESH_ACTIONS},
    winner:null, turn:1,
    powerCardHand:{1:['block','block','switch'],2:['block','block','switch']}, blockedCells:[], boardTiles:genBoardTiles(),
  }
}
const cardPts  = c => Object.values(c.values).reduce((a,b)=>a+b,0)
const cardTier = c => c.total<=20?'weak':c.total<=28?'medium':'strong'
function playerPts(game,p){let pts=game.players[p].hand?.reduce((a,c)=>a+cardPts(c),0);for(const row of game.board)for(const cell of row)if(cell?.owner===p)pts+=cardPts(cell);return pts}
function cardCount(game,p){let n=game.players[p].hand?.length;for(const row of game.board)for(const cell of row)if(cell?.owner===p)n++;return n}
// Down to a single card, moving it back to where it just came from is a no-op
// that both players (and the AI) could otherwise repeat forever — block it so
// a last-card standoff can't stall the match. With 2+ cards, backtracking is
// still a legitimate tactic (regroup, retreat, feint), so it's left alone.
function isBannedLastCardBacktrack(game,cp,card,tr,tc){
  return cardCount(game,cp)===1&&card.prevPos&&card.prevPos.r===tr&&card.prevPos.c===tc
}
function checkWin(game){
  const p1Empty=cardCount(game,1)===0, p2Empty=cardCount(game,2)===0
  // An attack that kills both the attacker and defender can empty both sides at once
  // (each had exactly one card left, and both died in the exchange) — a draw, not a win.
  if(p1Empty&&p2Empty)return 'draw'
  if(p1Empty)return 2
  if(p2Empty)return 1
  return null
}

// ═══════════════════════════════════════════════════════════════════════════════
//  COMBAT
// ═══════════════════════════════════════════════════════════════════════════════
function getContactKeys(ar,ac,dr,dc){
  if(dr===ar&&dc===ac+1)return[['topRight','right','bottomRight'],['topLeft','left','bottomLeft']]
  if(dr===ar&&dc===ac-1)return[['topLeft','left','bottomLeft'],['topRight','right','bottomRight']]
  if(dr===ar+1&&dc===ac)return[['bottomLeft','bottom','bottomRight'],['topLeft','top','topRight']]
  if(dr===ar-1&&dc===ac)return[['topLeft','top','topRight'],['bottomLeft','bottom','bottomRight']]
  return[[],[]]
}
function doAttack(board,ar,ac,dr,dc){
  const a={...board[ar][ac],values:{...board[ar][ac].values}},d={...board[dr][dc],values:{...board[dr][dc].values}}
  const [ak,dk]=getContactKeys(ar,ac,dr,dc)
  ak.forEach(k=>a.values[k]-=1);dk.forEach(k=>d.values[k]-=1)
  const aDead=Object.values(a.values).some(v=>v<0),dDead=Object.values(d.values).some(v=>v<0)
  const nb=board.map(row=>[...row]);nb[ar][ac]=aDead?null:a;nb[dr][dc]=dDead?null:d
  return{newBoard:nb,aDead,dDead}
}

// ═══════════════════════════════════════════════════════════════════════════════
//  SOUND
// ═══════════════════════════════════════════════════════════════════════════════
let _ctx=null
const getCtx=()=>_ctx||(_ctx=new(window.AudioContext||window.webkitAudioContext)())
function snd(type,enabled){
  if(!enabled||!type)return
  try{
    const c=getCtx(),t=c.currentTime
    const tone=(freq,wt,dur,vol=0.25)=>{const o=c.createOscillator(),g=c.createGain();o.type=wt;o.connect(g);g.connect(c.destination);o.frequency.setValueAtTime(freq,t);g.gain.setValueAtTime(vol,t);g.gain.exponentialRampToValueAtTime(0.001,t+dur);o.start(t);o.stop(t+dur);return o}
    if(type==='place-weak'){const o=tone(280,'sine',0.25,0.18);o.frequency.exponentialRampToValueAtTime(200,t+0.22)}
    if(type==='place-medium'){const o=tone(380,'triangle',0.28,0.22);o.frequency.exponentialRampToValueAtTime(280,t+0.24);tone(760,'sine',0.1,0.12)}
    if(type==='place-strong'){const o=tone(520,'sawtooth',0.32,0.28);o.frequency.exponentialRampToValueAtTime(260,t+0.28);tone(1040,'triangle',0.14,0.18).frequency.exponentialRampToValueAtTime(780,t+0.16);const buf=c.createBuffer(1,c.sampleRate*0.06,c.sampleRate);const d=buf.getChannelData(0);for(let i=0;i<d.length;i++)d[i]=(Math.random()*2-1)*(1-i/d.length);const n=c.createBufferSource(),ng=c.createGain();n.buffer=buf;n.connect(ng);ng.connect(c.destination);ng.gain.setValueAtTime(0.25,t);ng.gain.exponentialRampToValueAtTime(0.001,t+0.06);n.start(t)}
    if(type==='move'){const o=tone(300,'sine',0.15);o.frequency.exponentialRampToValueAtTime(150,t+0.12)}
    if(type==='power'){tone(660,'triangle',0.35,0.2).frequency.exponentialRampToValueAtTime(990,t+0.2);tone(880,'sine',0.2,0.12).frequency.exponentialRampToValueAtTime(1320,t+0.18)}
    if(type==='attack'){const o=tone(200,'sawtooth',0.2,0.35);o.frequency.exponentialRampToValueAtTime(60,t+0.15);const buf=c.createBuffer(1,c.sampleRate*0.08,c.sampleRate);const d=buf.getChannelData(0);for(let i=0;i<d.length;i++)d[i]=Math.random()*2-1;const n=c.createBufferSource(),ng=c.createGain();n.buffer=buf;n.connect(ng);ng.connect(c.destination);ng.gain.setValueAtTime(0.2,t);ng.gain.exponentialRampToValueAtTime(0.001,t+0.08);n.start(t)}
    if(type==='destroy'){const buf=c.createBuffer(1,c.sampleRate*0.5,c.sampleRate);const d=buf.getChannelData(0);for(let i=0;i<d.length;i++)d[i]=(Math.random()*2-1)*Math.pow(1-i/d.length,1.5);const n=c.createBufferSource(),ng=c.createGain();n.buffer=buf;n.connect(ng);ng.connect(c.destination);ng.gain.setValueAtTime(0.5,t);ng.gain.exponentialRampToValueAtTime(0.001,t+0.5);n.start(t);const o=tone(80,'sine',0.5,0.5);o.frequency.exponentialRampToValueAtTime(15,t+0.5)}
    if(type==='coin'){tone(1318.5,'sine',0.18,0.22);tone(1975.5,'triangle',0.22,0.15)}
  }catch(e){}
}

// ═══════════════════════════════════════════════════════════════════════════════
//  MUSIC — procedural ambient loop (A natural minor, arpeggiated)
// ═══════════════════════════════════════════════════════════════════════════════
let _audio = null
let _gameTrackIdx = 0
let _currentMode = null
let _musicVolume = loadMusicVolumePref()
function setMusicVolume(v) {
  _musicVolume = Math.min(1, Math.max(0, v))
  saveMusicVolumePref(_musicVolume)
  if (_audio) _audio.volume = _musicVolume
}
const GAME_TRACKS = ['/musiques/music1.mp3', '/musiques/music2.mp3', '/musiques/music3.mp3', '/musiques/music4.mp3', '/musiques/music5.mp3', '/musiques/music6.mp3', '/musiques/music7.mp3']

// Random pick that avoids repeating the track that just ended
function _randomTrackIdx(excludeIdx) {
  if (GAME_TRACKS.length <= 1) return 0
  let i
  do { i = Math.floor(Math.random() * GAME_TRACKS.length) } while (i === excludeIdx)
  return i
}

function _playNextGameTrack() {
  if (!_audio) return
  _audio.src = GAME_TRACKS[_gameTrackIdx]
  _audio.play().catch(() => {})
}

function startMusic(enabled, isMenu = false, outcome = null) {
  if (!enabled) { stopMusic(); return }
  const mode = outcome ? `outcome:${outcome}` : (isMenu ? 'menu' : 'game')
  if (_currentMode === mode && _audio && !_audio.paused) return
  stopMusic()
  _currentMode = mode
  _audio = new Audio()
  _audio.volume = _musicVolume
  if (outcome) {
    // One-shot victory/defeat stinger — doesn't loop, doesn't fall back to game tracks
    _audio.src = outcome === 'victory' ? '/musiques/victory.mp3' : '/musiques/defeat.mp3'
    _audio.loop = false
    _audio.play().catch(() => {})
  } else if (isMenu) {
    _audio.src = '/musiques/menu.mp3'
    _audio.loop = true
    // Browsers block audio with sound until a genuine user gesture — retry on
    // whichever gesture type the browser actually honors (pointerdown covers
    // most desktop/Android cases, but Safari/iOS sometimes only counts a
    // real 'click' or 'touchend').
    const GESTURE_EVENTS = ['pointerdown', 'click', 'touchend', 'keydown']
    const tryPlay = () => { if (_audio) _audio.play().catch(() => {}) }
    GESTURE_EVENTS.forEach(ev => document.addEventListener(ev, tryPlay, { once: true }))
    tryPlay()
  } else {
    _gameTrackIdx = _randomTrackIdx(-1)
    _audio.addEventListener('ended', () => {
      _gameTrackIdx = _randomTrackIdx(_gameTrackIdx)
      _playNextGameTrack()
    })
    _playNextGameTrack()
  }
}

function stopMusic() {
  if (!_audio) return
  _audio.pause()
  _audio.src = ''
  _audio = null
  _currentMode = null
}

// ═══════════════════════════════════════════════════════════════════════════════
//  DRAG GHOST — larger card preview while dragging
// ═══════════════════════════════════════════════════════════════════════════════
const GHOST_BORDER = {1:{weak:'#1e40af',medium:'#3b82f6',strong:'#67e8f9'},2:{weak:'#7f1d1d',medium:'#ef4444',strong:'#fb923c'}}
const GHOST_BG     = {1:{weak:'#0f172a',medium:'#1e3a5f',strong:'#0a3344'},2:{weak:'#1c0404',medium:'#450a0a',strong:'#431407'}}
const GHOST_BG2    = {1:{weak:'#1e293b',medium:'#1d4ed8',strong:'#0e7490'},2:{weak:'#3b0a0a',medium:'#991b1b',strong:'#9a3412'}}

function createDragGhost(card) {
  const tier=cardTier(card),p1=card.owner===1
  const bdr=GHOST_BORDER[card.owner][tier]
  const bg1=GHOST_BG[card.owner][tier],bg2=GHOST_BG2[card.owner][tier]
  const centerSym=tier==='strong'?'✦':tier==='medium'?'◆':'·'
  const centerColor=p1?'rgba(96,165,250,0.5)':'rgba(248,113,113,0.5)'
  const playerOverlay=p1?'rgba(30,58,138,0.45)':'rgba(127,29,29,0.45)'

  const ghost=document.createElement('div')
  ghost.style.cssText=`position:fixed;top:-9999px;left:0;width:170px;height:170px;border:3px solid ${bdr};border-radius:18px;background:linear-gradient(135deg,${bg1},${bg2});display:grid;grid-template-columns:repeat(3,1fr);grid-template-rows:repeat(3,1fr);padding:5px;box-sizing:border-box;font-family:system-ui,sans-serif;box-shadow:0 12px 40px rgba(0,0,0,0.85),0 0 24px ${bdr}55;pointer-events:none;overflow:hidden;`

  // Background image layer
  if(card.imageUrl){
    const img=document.createElement('img')
    img.src=card.imageUrl
    img.style.cssText='position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:0;border-radius:15px;'
    ghost.appendChild(img)
    const ov=document.createElement('div')
    ov.style.cssText=`position:absolute;inset:0;background:linear-gradient(to top,${playerOverlay},transparent 60%);z-index:1;border-radius:15px;`
    ghost.appendChild(ov)
  }

  const keys=['topLeft','top','topRight','left',null,'right','bottomLeft','bottom','bottomRight']
  for(const key of keys){
    const cell=document.createElement('div')
    cell.style.cssText='display:flex;align-items:center;justify-content:center;position:relative;z-index:2;'
    if(key){
      const isDmg=card.values[key]<(card.baseValues?.[key]??card.values[key])
      const span=document.createElement('span')
      const valBg=card.imageUrl?'background:rgba(0,0,0,0.65);border-radius:5px;padding:2px 4px;':'';
      span.style.cssText=`font-size:28px;font-weight:900;color:${isDmg?'#fca5a5':'#f8fafc'};text-shadow:0 1px 6px rgba(0,0,0,0.8);${valBg}`
      span.textContent=String(card.values[key])
      cell.appendChild(span)
    }else{
      const span=document.createElement('span')
      span.style.cssText=`font-size:18px;color:${centerColor};`
      span.textContent=centerSym
      cell.appendChild(span)
    }
    ghost.appendChild(cell)
  }
  document.body.appendChild(ghost)
  return ghost
}

// ═══════════════════════════════════════════════════════════════════════════════
//  AI — pure computation functions (Player 2)
// ═══════════════════════════════════════════════════════════════════════════════

// Snapshot of the board situation from cp's perspective — also classifies how the
// match is going (`posture`) and turns that into a single `aggression` multiplier
// (>1 when behind, <1 when ahead) that every scoring function below leans on, so
// the AI actually plays differently depending on whether it's winning or losing
// instead of always following the same fixed heuristics.
function getSituation(game,cp){
  const opp=cp===1?2:1
  const myPts=playerPts(game,cp),oppPts=playerPts(game,opp)
  const myCards=cardCount(game,cp),oppCards=cardCount(game,opp)
  // Count allied board cards that could be destroyed by an adjacent enemy next turn
  let cardsInDanger=0
  for(let r=0;r<5;r++)for(let c=0;c<5;c++){
    const card=game.board[r][c];if(!card||card.owner!==cp)continue
    for(const[dr,dc]of[[-1,0],[1,0],[0,-1],[0,1]]){
      const nr=r+dr,nc=c+dc;if(nr<0||nr>=5||nc<0||nc>=5)continue
      if(!game.board[nr][nc]||game.board[nr][nc].owner===cp)continue
      // enemy can attack our card from nr,nc — check which of our faces would take damage
      const[_,ourFaces]=getContactKeys(nr,nc,r,c)
      if(ourFaces.some(k=>card.values[k]<=1)){cardsInDanger++;break}
    }
  }
  const ptDelta=myPts-oppPts,cardDelta=myCards-oppCards
  // Cards on board/hand decide the match (hitting zero is an instant loss), so they
  // dominate the advantage read; points and immediate board threats refine it.
  const advantage=cardDelta*30+ptDelta*0.8-cardsInDanger*12
  const posture=advantage<=-25?'losing':advantage>=25?'winning':'even'
  // Smooth multiplier (not just 3 buckets) so borderline situations don't cause an
  // abrupt behavior flip: ~1.6 when badly behind, ~1.0 when even, ~0.6 when well ahead.
  const aggression=Math.min(1.6,Math.max(0.6,1-advantage/80))
  return{myPts,oppPts,ptDelta,myCards,oppCards,cardDelta,cardsInDanger,advantage,posture,aggression}
}

// Returns {dangerScore, killScore} of a potential attack without committing
function analyzeAttack(game,ar,ac,dr,dc){
  const[ak,dk]=getContactKeys(ar,ac,dr,dc)
  const atk=game.board[ar][ac],def=game.board[dr][dc]
  const aDies=ak.some(k=>atk.values[k]===0)
  const dDies=dk.some(k=>def.values[k]===0)
  return{aDies,dDies,ak,dk,atk,def}
}

function scoreAttack(game,ar,ac,dr,dc,sit){
  const{aDies,dDies,ak,dk,atk,def}=analyzeAttack(game,ar,ac,dr,dc)
  const aggr=sit?.aggression??1

  // Hard rules — never suicide for nothing
  if(aDies&&!dDies) return -99999
  if(aDies&&dDies){
    if((sit?.myCards??9)<=2) return -99999           // can't afford card loss right now
    const stillValuable=cardPts(atk)>20               // our card still carries a lot of points
    if(!stillValuable) return 200+def.total*2         // take the kill even though we lose our card
    const gain=def.total-atk.total
    if(gain<10/aggr) return -99999                    // behind: accept a worse trade to try to swing the match
    return gain*3
  }

  let s=0
  if(dDies){
    s+=180+def.total*2
    if(cardTier(def)==='strong')s+=200  // huge bonus: killing a strong card is always worth it
    if((sit?.oppCards??9)<=2)s+=100
  } else {
    // Reward hitting low-value faces — brings them closer to death. Scaled by
    // aggression: chipping away matters more when behind and needs to matter less
    // when a lead just needs protecting.
    dk.forEach(k=>{
      const v=def.values[k]
      if(v===1)s+=95*aggr   // → 0 next attack kills
      else if(v===2)s+=50*aggr
      else if(v===3)s+=20*aggr
      else if(v<=5)s+=7*aggr
    })
  }
  // Penalise risk to attacker's own faces — divided by aggression so a losing AI
  // (aggr>1) discounts the risk and a winning one (aggr<1) is extra cautious.
  ak.forEach(k=>{
    const v=atk.values[k]
    if(v===1)s-=45/aggr   // face becomes 0 = vulnerable next turn
    else if(v===2)s-=18/aggr
    else if(v===3)s-=6/aggr
  })
  return s
}

function findBestAttack(game,cp,sit){
  let best=null,bestS=-25*(sit?.aggression??1)  // behind: tolerate riskier attacks; ahead: only the clean ones
  for(let ar=0;ar<5;ar++)for(let ac=0;ac<5;ac++){
    if(!game.board[ar][ac]||game.board[ar][ac].owner!==cp)continue
    for(const[ddr,ddc]of[[-1,0],[1,0],[0,-1],[0,1]]){
      const dr=ar+ddr,dc=ac+ddc
      if(dr<0||dr>=5||dc<0||dc>=5)continue
      if(!game.board[dr][dc]||game.board[dr][dc].owner===cp)continue
      const s=scoreAttack(game,ar,ac,dr,dc,sit)
      if(s>bestS){bestS=s;best={ar,ac,dr,dc}}
    }
  }
  return best
}

// Returns true if placing card at (r,c) would expose it to an immediate lethal attack
function wouldBePlacedInDanger(game,card,r,c){
  for(const[dr,dc]of[[-1,0],[1,0],[0,-1],[0,1]]){
    const nr=r+dr,nc=c+dc;if(nr<0||nr>=5||nc<0||nc>=5)continue
    const nb=game.board[nr][nc];if(!nb||nb.owner===card.owner)continue
    // enemy at nr,nc attacks us: check our faces that would be exposed
    const[_,ourFaces]=getContactKeys(nr,nc,r,c)
    if(ourFaces.some(k=>card.values[k]===0)) return true   // immediate death possible
  }
  return false
}

function scorePlacement(game,card,r,c,sit){
  const aggr=sit?.aggression??1
  let s=0
  // Row 3 = attack row, row 4 = safe back row — the pull toward the front line
  // scales with aggression, same idea as the attack-row bonus below.
  s+=(r===3?20:0)*aggr
  // Center columns are more flexible
  s+=(2-Math.abs(c-2))*4
  // Hard penalty: don't place where opponent can instantly destroy a face — this
  // stays fixed regardless of posture, a free kill never helps either way.
  if(wouldBePlacedInDanger(game,card,r,c))s-=150
  // Evaluate attack opportunity from this cell
  for(const[dr,dc]of[[-1,0],[1,0],[0,-1],[0,1]]){
    const nr=r+dr,nc=c+dc;if(nr<0||nr>=5||nc<0||nc>=5)continue
    const nb=game.board[nr][nc];if(!nb||nb.owner===card.owner)continue
    // Check damage we could deal next turn
    const[ourAtkFaces,theirFaces]=getContactKeys(r,c,nr,nc)
    theirFaces.forEach(k=>{
      const v=nb.values[k]
      if(v===0)s+=80*aggr
      else if(v===1)s+=40*aggr
      else if(v<=2)s+=15*aggr
    })
    // But also penalise risky exposure (less severe than instant death)
    const[_,ourExp]=getContactKeys(nr,nc,r,c)
    ourExp.forEach(k=>{
      const v=card.values[k]
      if(v===1)s-=30/aggr
      else if(v===2)s-=10/aggr
    })
  }
  s+=card.total*0.4
  return s
}

function findBestPlacement(game,cp,sit){
  if(!game.players[cp].hand.length)return null
  let best=null,bestS=-Infinity
  for(const r of P2_ROWS)for(let c=0;c<5;c++){
    if(isCellBlocked(game,r,c)||game.board[r][c])continue
    for(let i=0;i<game.players[cp].hand.length;i++){
      const s=scorePlacement(game,game.players[cp].hand[i],r,c,sit)
      if(s>bestS){bestS=s;best={cardIdx:i,r,c}}
    }
  }
  return best
}

function scoreMove(game,fr,fc,tr,tc,card,cp,sit){
  const aggr=sit?.aggression??1
  let dangerBefore=0,dangerAfter=0,atkAfter=0
  // Danger at current position
  for(const[dr,dc]of[[-1,0],[1,0],[0,-1],[0,1]]){
    const nr=fr+dr,nc=fc+dc;if(nr<0||nr>=5||nc<0||nc>=5)continue
    const nb=game.board[nr][nc];if(!nb||nb.owner===cp)continue
    const[_,ourFaces]=getContactKeys(nr,nc,fr,fc)
    ourFaces.forEach(k=>{const v=card.values[k];if(v===0)dangerBefore+=90;else if(v===1)dangerBefore+=45;else if(v===2)dangerBefore+=15})
  }
  // Danger + opportunity at target
  for(const[dr,dc]of[[-1,0],[1,0],[0,-1],[0,1]]){
    const nr=tr+dr,nc=tc+dc;if(nr<0||nr>=5||nc<0||nc>=5)continue
    const nb=game.board[nr][nc];if(!nb||nb.owner===cp)continue
    const[_,ourFaces]=getContactKeys(nr,nc,tr,tc)
    ourFaces.forEach(k=>{const v=card.values[k];if(v===0)dangerAfter+=90;else if(v===1)dangerAfter+=45;else if(v===2)dangerAfter+=15})
    // Attack opportunity from target
    const[__,theirFaces]=getContactKeys(tr,tc,nr,nc)
    theirFaces.forEach(k=>{const v=nb.values[k];if(v===0)atkAfter+=130;else if(v===1)atkAfter+=70;else if(v===2)atkAfter+=35;else if(v<=4)atkAfter+=12})
  }
  // Escaping existing danger is always rewarded; remaining/new danger at the
  // destination is discounted when behind (aggr>1) and weighted extra when
  // comfortably ahead (aggr<1) — same reward/risk split as scoreAttack.
  let s=dangerBefore-dangerAfter/aggr
  s+=atkAfter*0.5*aggr                 // bonus for reaching attack position, bigger when behind
  if(tr<fr)s+=8*aggr                   // bias toward advancing grows when behind
  s-=5                                 // baseline cost so AI only moves for a reason
  return s
}

function findBestMove(game,cp,sit){
  let best=null,bestS=-8*(sit?.aggression??1)  // move if marginally beneficial or to escape danger
  for(let fr=0;fr<5;fr++)for(let fc=0;fc<5;fc++){
    const card=game.board[fr][fc];if(!card||card.owner!==cp)continue
    for(let dr=-1;dr<=1;dr++)for(let dc=-1;dc<=1;dc++){
      if(dr===0&&dc===0)continue
      const tr=fr+dr,tc=fc+dc
      if(tr<0||tr>=5||tc<0||tc>=5)continue
      if(isCellBlocked(game,tr,tc)||game.board[tr][tc])continue
      if(isBannedLastCardBacktrack(game,cp,card,tr,tc))continue  // would just undo the last move with nothing else to do
      const s=scoreMove(game,fr,fc,tr,tc,card,cp,sit)
      if(s>bestS){bestS=s;best={fr,fc,tr,tc}}
    }
  }
  return best
}

// How dangerous is our card at (r,c) — higher = more urgent to protect
function cardDangerScore(game,r,c,cp){
  const card=game.board[r][c];if(!card||card.owner!==cp)return 0
  let d=0
  for(const[dr,dc]of[[-1,0],[1,0],[0,-1],[0,1]]){
    const nr=r+dr,nc=c+dc;if(nr<0||nr>=5||nc<0||nc>=5)continue
    if(!game.board[nr][nc]||game.board[nr][nc].owner===cp)continue
    const[_,ourFaces]=getContactKeys(nr,nc,r,c)
    ourFaces.forEach(k=>{const v=card.values[k];if(v===0)d+=100;else if(v===1)d+=50;else if(v===2)d+=15})
  }
  return d
}
// How valuable would an empty cell be to the OPPONENT — used to pick which cell
// a Barrage (block) most usefully denies, instead of a fixed column order.
function cellDenialValue(game,cp,r,c){
  let s=(2-Math.abs(c-2))*4  // central columns are generically more flexible
  for(const[dr,dc]of[[-1,0],[1,0],[0,-1],[0,1]]){
    const nr=r+dr,nc=c+dc;if(nr<0||nr>=5||nc<0||nc>=5)continue
    const nb=game.board[nr][nc];if(!nb||nb.owner!==cp)continue  // adjacent ally of ours
    // A card placed here could attack this ally of ours next turn — the weaker
    // the exposed face, the more this cell is worth denying.
    const[_,ourFaces]=getContactKeys(r,c,nr,nc)
    ourFaces.forEach(k=>{const v=nb.values[k];if(v===0)s+=80;else if(v===1)s+=40;else if(v<=2)s+=15})
  }
  return s
}

function computePowerTarget(game,cp,type,sit){
  const aggr=sit?.aggression??1
  if(type==='buff'){
    let best=null,bestS=-Infinity
    for(let r=0;r<5;r++)for(let c=0;c<5;c++){
      if(!isValidPowerTarget(game,'buff',cp,r,c))continue
      const card=game.board[r][c]
      const lost=Object.entries(card.values).reduce((sum,[k,v])=>sum+((card.baseValues?.[k]??v)-v),0)
      const danger=cardDangerScore(game,r,c,cp)
      const s=lost*15+danger*0.8+card.total*0.3
      if(s>10/aggr&&s>bestS){bestS=s;best={r,c}}  // behind: a smaller buff is still worth spending on
    }
    return best?{type:'power',powerType:'buff',...best}:null
  }
  if(type==='recall'){
    // Only recall a card that is genuinely in danger — the bar for "endangered
    // enough" drops when behind, since every remaining card matters more.
    let best=null,bestS=-Infinity
    for(let r=0;r<5;r++)for(let c=0;c<5;c++){
      if(!isValidPowerTarget(game,'recall',cp,r,c))continue
      const d=cardDangerScore(game,r,c,cp)
      if(d<50/aggr)continue
      const card=game.board[r][c]
      const s=d+card.total
      if(s>bestS){bestS=s;best={r,c}}
    }
    return best?{type:'power',powerType:'recall',...best}:null
  }
  if(type==='switch'){
    let best=null,bestS=-Infinity
    for(let r=0;r<5;r++)for(let c=0;c<5;c++){
      if(!isValidPowerTarget(game,'switch',cp,r,c))continue
      const card=game.board[r][c],rotated=rotateValues(card.values)
      let s=0
      if(card.owner!==cp){
        // Rotate enemy: does it weaken their faces toward our allies?
        for(const[dr,dc]of[[-1,0],[1,0],[0,-1],[0,1]]){
          const nr=r+dr,nc=c+dc;if(nr<0||nr>=5||nc<0||nc>=5)continue
          if(!game.board[nr][nc]||game.board[nr][nc].owner!==cp)continue
          const[_,enemyFaces]=getContactKeys(nr,nc,r,c)
          enemyFaces.forEach(k=>{s+=(card.values[k]??0)-(rotated[k]??0)})  // positive if rotation weakens them
        }
        s+=cardPts(card)*0.05
      } else {
        // Rotate own: does it improve our faces toward enemies?
        for(const[dr,dc]of[[-1,0],[1,0],[0,-1],[0,1]]){
          const nr=r+dr,nc=c+dc;if(nr<0||nr>=5||nc<0||nc>=5)continue
          if(!game.board[nr][nc]||game.board[nr][nc].owner===cp)continue
          const[ourFaces,theirFaces]=getContactKeys(r,c,nr,nc)
          theirFaces.forEach(k=>{const nb=game.board[nr][nc];if(nb.values[k]===0)s+=60;else if(nb.values[k]===1)s+=30})
          // Penalise if rotation puts a 0 value facing an enemy
          ourFaces.forEach(k=>{if(rotated[k]===0)s-=50})
        }
        s-=15  // baseline: prefer targeting enemies
      }
      if(s>bestS){bestS=s;best={r,c}}
    }
    // Only one Rotation for the whole match — behind, a decent rotation is worth
    // gambling on; ahead, hold out for a clearly excellent one.
    return best&&bestS>25/aggr?{type:'power',powerType:'switch',...best}:null
  }
  if(type==='block'){
    // Only block once enemy has deployed — no point blocking an empty board
    const enemyDeployed=game.board.some(row=>row.some(c=>c&&c.owner!==cp))
    if(!enemyDeployed)return null
    const opp=cp===1?2:1,oppRows=opp===1?P1_ROWS:P2_ROWS
    let best=null,bestS=-Infinity
    for(const r of oppRows)for(let c=0;c<5;c++){
      if(!isValidPowerTarget(game,'block',cp,r,c))continue
      const s=cellDenialValue(game,cp,r,c)
      if(s>bestS){bestS=s;best={r,c}}
    }
    // Barrage is a purely defensive denial tool, not a direct path back into the
    // match — unlike every other power/action above, being behind RAISES the bar
    // (spend actions clawing back the game instead) while a comfortable lead
    // lowers it (freely lock in the advantage).
    return best&&bestS>20*aggr?{type:'power',powerType:'block',...best}:null
  }
  return null
}

function computeAIAction(game){
  const cp=2,al=game.actionsLeft,powerCards=game.powerCardHand[cp]||[]
  const sit=getSituation(game,cp)

  // Priority 0: retreat a card with a 0-face exposed toward an enemy (imminent kill)
  if(al.moves>0){
    let bestFlee=null,bestFleeS=-Infinity
    for(let fr=0;fr<5;fr++)for(let fc=0;fc<5;fc++){
      const card=game.board[fr][fc];if(!card||card.owner!==cp)continue
      const d=cardDangerScore(game,fr,fc,cp)
      if(d<80)continue
      for(let dr=-1;dr<=1;dr++)for(let dc=-1;dc<=1;dc++){
        if(dr===0&&dc===0)continue
        const tr=fr+dr,tc=fc+dc
        if(tr<0||tr>=5||tc<0||tc>=5)continue
        if(isCellBlocked(game,tr,tc)||game.board[tr][tc])continue
        if(isBannedLastCardBacktrack(game,cp,card,tr,tc))continue
        const s=d+scoreMove(game,fr,fc,tr,tc,card,cp,sit)
        if(s>bestFleeS){bestFleeS=s;bestFlee={fr,fc,tr,tc}}
      }
    }
    if(bestFlee)return{type:'move',...bestFlee}
  }

  // Priority 1: guaranteed kill of a strong enemy card (attacker survives)
  if(al.attack>0){
    for(let ar=0;ar<5;ar++)for(let ac=0;ac<5;ac++){
      if(!game.board[ar][ac]||game.board[ar][ac].owner!==cp)continue
      for(const[ddr,ddc]of[[-1,0],[1,0],[0,-1],[0,1]]){
        const dr=ar+ddr,dc=ac+ddc
        if(dr<0||dr>=5||dc<0||dc>=5)continue
        const def=game.board[dr][dc]
        if(!def||def.owner===cp)continue
        if(cardTier(def)!=='strong')continue
        const{aDies,dDies}=analyzeAttack(game,ar,ac,dr,dc)
        if(dDies&&!aDies)return{type:'attack',ar,ac,dr,dc}
      }
    }
  }

  // Power cards — which one to even consider first shifts with the match state:
  // behind, preserving cards (recall) and setting up a swing (switch) come
  // first; ahead, consolidating the lead (block, buff) takes priority instead.
  if(powerCards.length>0){
    const order=sit.posture==='losing'?['recall','switch','buff','block']
      :sit.posture==='winning'?['block','buff','recall','switch']
      :['recall','buff','switch','block']
    for(const type of order){
      if(!powerCards.includes(type))continue
      const pa=computePowerTarget(game,cp,type,sit)
      if(pa)return pa
    }
  }

  // Any guaranteed kill (any tier)
  if(al.attack>0){
    const atk=findBestAttack(game,cp,sit)
    if(atk){
      const{dDies}=analyzeAttack(game,atk.ar,atk.ac,atk.dr,atk.dc)
      if(dDies)return{type:'attack',...atk}
    }
  }

  // Place a card
  if(al.placement>0&&game.players[cp].hand.length>0){
    const p=findBestPlacement(game,cp,sit)
    if(p)return{type:'place',...p}
  }

  // High-value non-lethal attack before moving
  if(al.attack>0){
    const atk=findBestAttack(game,cp,sit)
    if(atk){
      const s=scoreAttack(game,atk.ar,atk.ac,atk.dr,atk.dc,sit)
      if(al.moves===0||s>=55)return{type:'attack',...atk}
    }
  }

  // Move to better position
  if(al.moves>0){
    const m=findBestMove(game,cp,sit)
    if(m)return{type:'move',...m}
  }

  // Any remaining attack
  if(al.attack>0){
    const atk=findBestAttack(game,cp,sit)
    if(atk)return{type:'attack',...atk}
  }

  // Fallback: force some action
  if(al.moves>0){
    for(let fr=0;fr<5;fr++)for(let fc=0;fc<5;fc++){
      const card=game.board[fr][fc];if(!card||card.owner!==cp)continue
      for(const[ddr,ddc]of[[-1,0],[0,-1],[0,1],[1,0]]){
        const tr=fr+ddr,tc=fc+ddc
        if(tr<0||tr>=5||tc<0||tc>=5)continue
        if(isBannedLastCardBacktrack(game,cp,card,tr,tc))continue
        if(!isCellBlocked(game,tr,tc)&&!game.board[tr][tc])return{type:'move',fr,fc,tr,tc}
      }
    }
  }
  if(al.attack>0){
    for(let ar=0;ar<5;ar++)for(let ac=0;ac<5;ac++){
      if(!game.board[ar][ac]||game.board[ar][ac].owner!==cp)continue
      for(const[ddr,ddc]of[[-1,0],[1,0],[0,-1],[0,1]]){
        const dr=ar+ddr,dc=ac+ddc
        if(dr<0||dr>=5||dc<0||dc>=5)continue
        if(game.board[dr][dc]&&game.board[dr][dc].owner!==cp)return{type:'attack',ar,ac,dr,dc}
      }
    }
  }

  return{type:'endTurn'}
}
function applyAIActionDirect(g,action){
  if(!g||!action)return null
  const cp=g.currentPlayer,al=g.actionsLeft
  switch(action.type){
    case 'endTurn':return{...g,currentPlayer:1,actionsLeft:{...FRESH_ACTIONS},turn:g.turn+1}
    case 'power':return applyPowerAction(g,action.powerType,action.r,action.c)
    case 'attack':{
      const{ar,ac,dr,dc}=action
      if(al.attack<=0)return null
      if(!g.board[ar][ac]||g.board[ar][ac].owner!==cp)return null
      if(!g.board[dr][dc]||g.board[dr][dc].owner===cp||!isCardinal(ar,ac,dr,dc))return null
      const{newBoard}=doAttack(g.board,ar,ac,dr,dc)
      return{...g,board:newBoard,actionsLeft:{...al,attack:al.attack-1}}
    }
    case 'place':{
      const{cardIdx,r,c}=action
      if(al.placement<=0||!inZone(r,cp)||isCellBlocked(g,r,c)||g.board[r][c])return null
      const hand=[...g.players[cp].hand];const card=hand[cardIdx];if(!card)return null
      hand.splice(cardIdx,1);const nb=g.board.map(row=>[...row]);nb[r][c]=card
      return{...g,board:nb,players:{...g.players,[cp]:{...g.players[cp],hand}},actionsLeft:{...al,placement:al.placement-1}}
    }
    case 'move':{
      const{fr,fc,tr,tc}=action
      if(al.moves<=0||isCellBlocked(g,tr,tc)||!isAdjacent(fr,fc,tr,tc)||g.board[tr][tc])return null
      const card=g.board[fr][fc];if(!card||card.owner!==cp)return null
      if(isBannedLastCardBacktrack(g,cp,card,tr,tc))return null
      const nb=g.board.map(row=>[...row]);nb[tr][tc]={...card,prevPos:{r:fr,c:fc}};nb[fr][fc]=null
      return{...g,board:nb,actionsLeft:{...al,moves:al.moves-1}}
    }
    default:return null
  }
}
function soundForAIAction(action,g){
  if(!action)return null
  if(action.type==='attack'){
    const[ak,dk]=getContactKeys(action.ar,action.ac,action.dr,action.dc)
    const a=g.board[action.ar][action.ac],d=g.board[action.dr][action.dc]
    return(ak.some(k=>a?.values[k]===0)||dk.some(k=>d?.values[k]===0))?'destroy':'attack'
  }
  return{place:'place',move:'move',power:'power',draw:'power',endTurn:null}[action.type]||null
}

// ═══════════════════════════════════════════════════════════════════════════════
//  CARD FACE
// ═══════════════════════════════════════════════════════════════════════════════
function CardImageLayer({imageUrl,zoom,className}){
  const file=imageUrl?.split('/').pop()
  const layers=PARALLAX_SKINS[file]
  if(!layers)return <img src={imageUrl} alt="" className={className}/>
  // Not zoomed: the two layers just stack statically, which composites into
  // the same picture a flat file would — no separate flat image needed.
  return(
    <div className={className}>
      <img src={`/images/card/${layers.bg}`} alt="" className={`absolute inset-0 w-full h-full object-cover ${zoom?'parallax-bg-idle':''}`}/>
      <img src={`/images/card/${layers.fg}`} alt="" className={`absolute inset-0 w-full h-full object-cover ${zoom?'parallax-fg-idle':''}`}/>
    </div>
  )
}
const TIER_THEME={
  1:{weak:{border:'border-blue-700/70',bg:'from-blue-950 to-slate-900',glow:'',center:'text-blue-800 text-[8px]',sym:'·'},medium:{border:'border-blue-500',bg:'from-blue-900 to-blue-800',glow:'',center:'text-blue-500/50 text-[9px]',sym:'◆'},strong:{border:'border-cyan-300',bg:'from-blue-700 to-cyan-900',glow:'shadow-[0_0_14px_rgba(34,211,238,0.45)]',center:'text-cyan-300/70 text-sm',sym:'✦'}},
  2:{weak:{border:'border-red-800/70',bg:'from-red-950 to-slate-900',glow:'',center:'text-red-900 text-[8px]',sym:'·'},medium:{border:'border-red-500',bg:'from-red-900 to-red-800',glow:'',center:'text-red-500/50 text-[9px]',sym:'◆'},strong:{border:'border-orange-300',bg:'from-red-700 to-orange-900',glow:'shadow-[0_0_14px_rgba(251,146,60,0.45)]',center:'text-orange-300/70 text-sm',sym:'✦'}},
}
function CardFace({card,small=false,compact=false,zoom=false,draggable=false,onDragStart,onTouchStart,onClick,animClass='',isTarget=false}){
  const tier=cardTier(card),theme=TIER_THEME[card.owner][tier]
  const sz=zoom
    ?'w-[88vw] h-[88vw] max-w-[420px] max-h-[420px]'
    :small
      ?(compact?'w-[58px] h-[58px]':'w-[80px] h-[80px]')
      :(compact?'w-[64px] h-[64px]':'w-[118px] h-[118px]')
  const fs=zoom
    ?'text-[34px]'
    :small
      ?(compact?'text-[9px]':'text-[12px]')
      :(compact?'text-[9px]':'text-[15px]')
  const hasImg=!!card.imageUrl
  // Colored outer glow distinguishes players even with full-opacity images
  const playerGlow=card.owner===1
    ?'shadow-[0_0_18px_rgba(59,130,246,0.65),0_0_6px_rgba(59,130,246,0.3)]'
    :'shadow-[0_0_18px_rgba(239,68,68,0.65),0_0_6px_rgba(239,68,68,0.3)]'
  const hoverGlow=card.owner===1
    ?tier==='strong'?'hover:shadow-[0_0_32px_rgba(34,211,238,0.8)]':tier==='medium'?'hover:shadow-[0_0_28px_rgba(59,130,246,0.75)]':'hover:shadow-[0_0_24px_rgba(30,64,175,0.65)]'
    :tier==='strong'?'hover:shadow-[0_0_32px_rgba(251,146,60,0.8)]':tier==='medium'?'hover:shadow-[0_0_28px_rgba(239,68,68,0.75)]':'hover:shadow-[0_0_24px_rgba(127,29,29,0.65)]'
  return(
    <div draggable={draggable} onDragStart={draggable?onDragStart:undefined} onTouchStart={onTouchStart} onClick={onClick}
      className={`${sz} border-2 ${theme.border} ${hasImg?playerGlow:theme.glow} rounded-xl bg-gradient-to-br ${hasImg?'':theme.bg} relative select-none overflow-hidden transition-all duration-200
        ${draggable?`cursor-grab active:cursor-grabbing active:scale-95 hover:scale-125 hover:brightness-110 hover:-translate-y-1 ${hoverGlow}`:''}
        ${onClick&&!draggable?'cursor-zoom-in':''}
        ${isTarget?'target-pulse ring-2 ring-yellow-400 ring-offset-1 ring-offset-slate-900 cursor-pointer brightness-110':''}
        ${animClass}`}>
      {hasImg&&<CardImageLayer imageUrl={card.imageUrl} zoom={zoom} className="absolute inset-0 w-full h-full object-cover"/>}
      {hasImg&&<div className={`absolute inset-0 bg-gradient-to-t ${card.owner===1?'from-blue-900/50':'from-red-900/50'} to-transparent`}/>}
      {!hasImg&&tier==='strong'&&<div className={`absolute inset-0 opacity-10 ${card.owner===1?'bg-cyan-300':'bg-orange-300'}`}/>}
      {!hasImg&&<div className={`absolute inset-0 bg-gradient-to-br ${theme.bg}`}/>}
      <div className={`absolute inset-0 grid grid-cols-3 grid-rows-3 ${fs} p-0.5`}>
        {GRID_KEYS.map((row,ri)=>row.map((key,ci)=>(
          <div key={`${ri}-${ci}`} className="flex items-center justify-center leading-none">
            {key?<span
              style={{textShadow:'0 0 6px #000,0 0 3px #000,0 1px 0 #000,0 -1px 0 #000'}}
              className={`font-black ${card.values[key]<(card.baseValues?.[key]??card.values[key])?'text-red-300':'text-white'}`}>
              {card.values[key]}
            </span>
            :<span className={`font-bold ${hasImg?'hidden':theme.center}`}>{theme.sym}</span>}
          </div>
        )))}
      </div>
      <div className={`absolute bottom-0.5 right-1 ${zoom?'text-sm bottom-2 right-3':'text-[9px]'} font-bold opacity-50 ${card.owner===1?'text-blue-200':'text-red-200'}`}>{card.total}</div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
//  BOARD CELL
// ═══════════════════════════════════════════════════════════════════════════════
function Cell({r,c,card,currentPlayer,actionsLeft,myPlayer,onDragStart,onDrop,onCellClick,onZoom,animKey,ghost,violent,targeting,game,onBoardTouchStart,compact=false}){
  const[over,setOver]=useState(false)
  const corner=isCorner(r,c),dynBlocked=isDynBlock(game,r,c),blocked=corner||dynBlocked
  const validTarget=targeting?isValidPowerTarget(game,targeting,currentPlayer,r,c):false
  let bg=blocked?'bg-slate-900/70':' bg-transparent'
  if(!blocked){
    if(targeting){if(!validTarget)bg='opacity-40';if(validTarget&&!over)bg='ring-1 ring-yellow-500/50';if(validTarget&&over)bg='bg-yellow-400/20 ring-2 ring-yellow-400 shadow-[0_0_16px_rgba(234,179,8,0.55)]'}
    else if(over)bg='bg-yellow-400/15 ring-1 ring-yellow-400/40'
  }
  // In online play, only the locally-assigned player may drag a card, and only during their own turn
  const isMyTurn=myPlayer==null||myPlayer===currentPlayer
  const canDrag=!targeting&&isMyTurn&&card&&card.owner===currentPlayer&&(actionsLeft.moves>0||actionsLeft.attack>0)
  const borderColor=blocked?'border-slate-700/30':P1_ROWS.includes(r)?'border-blue-500/70':P2_ROWS.includes(r)?'border-red-500/70':'border-slate-300/50'
  const cellSz=compact?'w-[68px] h-[68px]':'w-[90px] h-[90px]'
  return(
    <div data-cell={`${r},${c}`}
      className={`${cellSz} rounded-xl border-2 ${borderColor} ${bg} flex items-center justify-center relative transition-all duration-100 overflow-hidden ${targeting&&validTarget?'cursor-pointer':''} ${violent?'anim-kill-shake':''}`}
      onDragOver={!blocked&&!targeting?e=>{e.preventDefault();setOver(true)}:undefined}
      onDragLeave={!blocked&&!targeting?()=>setOver(false):undefined}
      onDrop={!blocked&&!targeting?e=>{e.preventDefault();setOver(false);onDrop(e,r,c)}:undefined}
      onMouseEnter={targeting&&validTarget?()=>setOver(true):undefined}
      onMouseLeave={targeting&&validTarget?()=>setOver(false):undefined}
      onClick={targeting&&validTarget?()=>onCellClick(r,c):undefined}>
      {corner&&<span className="text-slate-600/60 text-base select-none">✕</span>}
      {dynBlocked&&<span className="text-rose-700/70 text-3xl select-none" title="Bloqué">⊘</span>}
      {!blocked&&ghost&&<CardFace card={ghost.card} small compact={compact} animClass={ghost.anim}/>}
      {!blocked&&!ghost&&card&&<CardFace card={card} small compact={compact} draggable={canDrag} onDragStart={e=>onDragStart(e,'board',r,c)} onTouchStart={canDrag?e=>onBoardTouchStart(e,'board',r,c):undefined} onClick={!targeting?e=>{e.stopPropagation();onZoom(card)}:undefined} animClass={animKey} isTarget={targeting&&validTarget&&!!card}/>}
      {violent&&<div className="absolute inset-0 anim-kill-flash pointer-events-none"/>}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
//  POWER CARD DISPLAY
// ═══════════════════════════════════════════════════════════════════════════════
function PowerCardDisplay({type,onClick,isActive=false,animClass='',compact=false}){
  const info=POWER_INFO[type]
  const w=compact?'w-[48px]':'w-[76px]'
  const h=compact?'48px':'84px'
  const iconSz=compact?'text-base':'text-2xl'
  const nameSz=compact?'text-[7px]':'text-[9px]'
  return(
    <div onClick={onClick} style={{height:h}}
      className={`${w} border-2 ${info.border} ${info.glow} rounded-xl bg-gradient-to-br ${info.bg} flex flex-col items-center justify-center gap-0.5 p-1 cursor-pointer select-none transition-all duration-200 hover:scale-110 hover:brightness-110 active:scale-95 ${isActive?'ring-2 ring-yellow-400 ring-offset-1 ring-offset-slate-900 scale-105':''} ${animClass}`}>
      <span className={`${iconSz} leading-none`}>{info.icon}</span>
      <span className={`${nameSz} font-bold text-center text-slate-200 leading-tight px-0.5`}>{info.name}</span>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
//  POWER BAR
// ═══════════════════════════════════════════════════════════════════════════════
function PowerBar({game,isMyTurn,targeting,onActivatePower,onCancelTargeting,compact=false}){
  const cp=game.currentPlayer,myHand=game.powerCardHand[cp]||[]
  const minH=compact?'min-h-[52px]':'min-h-[72px]'
  const pad=compact?'px-2 py-1':'px-4 py-2'
  const gap=compact?'gap-1.5':'gap-3'
  return(
    <div className={`flex items-center justify-center ${gap} bg-purple-950/50 border border-purple-800/30 rounded-2xl ${pad} w-full ${minH}`}>
      {targeting?(
        <div className={`flex items-center ${gap}`}>
          <PowerCardDisplay type={targeting} isActive compact={compact}/>
          <div className="flex flex-col items-start gap-1">
            <span className={`text-yellow-400 ${compact?'text-xs':'text-sm'} font-bold animate-pulse`}>{POWER_INFO[targeting].icon} Sélectionnez une cible…</span>
            <button onClick={onCancelTargeting} className="flex items-center gap-1 text-slate-400 hover:text-white bg-slate-700/70 hover:bg-slate-700 px-2 py-1 rounded-lg text-xs transition-colors"><X size={11}/> Annuler</button>
          </div>
        </div>
      ):(
        <div className="flex items-center gap-2 flex-wrap justify-center">
          {myHand.map((type,i)=>(
            <PowerCardDisplay key={i} type={type} compact={compact}
              onClick={isMyTurn?()=>onActivatePower(type):undefined}/>
          ))}
          {!isMyTurn&&myHand.length>0&&<span className="text-slate-500 text-xs ml-1">En attente…</span>}
          {myHand.length===0&&<span className="text-slate-600 text-xs">Aucune carte pouvoir</span>}
        </div>
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
//  LOADING SCREEN — preloads a set of images/audio before revealing the next
//  screen, so nothing pops in or plays silently-late. Used both for the
//  app-boot preload (menu backgrounds + menu music) and the per-match one
//  (card portraits, board) shown between choosing a match and playing it.
// ═══════════════════════════════════════════════════════════════════════════════
function LoadingScreen({onDone,images=ALL_MATCH_IMAGES,audio=[],title='Préparation du combat…',minDelayMs=1300}){
  const[progress,setProgress]=useState(0)
  useEffect(()=>{
    let cancelled=false,loaded=0
    const total=images.length+audio.length
    const bump=()=>{loaded++;if(!cancelled)setProgress(total?Math.round(loaded/total*100):100)}
    try{getCtx()}catch(e){} // warm up the WebAudio context so the first SFX isn't delayed
    const minDelay=new Promise(resolve=>setTimeout(resolve,minDelayMs))
    const tasks=[...images.map(src=>preloadImage(src).then(bump)),...audio.map(src=>preloadAudio(src).then(bump))]
    Promise.all([Promise.all(tasks),minDelay]).then(()=>{if(!cancelled)onDone()})
    return()=>{cancelled=true}
  },[])
  return(
    <div className="min-h-screen relative flex flex-col items-center justify-center px-4 overflow-hidden">
      <div className="bg-charta fixed inset-0" aria-hidden="true"/>
      <div className="relative flex flex-col items-center gap-5 rounded-2xl px-8 py-10 border border-amber-900/40" style={{background:'rgba(8,5,2,0.82)'}}>
        <div className="loading-spin text-6xl" aria-hidden="true">⚔</div>
        <h2 className="charta-title text-2xl sm:text-3xl font-black tracking-wide text-center"
          style={{...CINZEL_DEC,
            background:'linear-gradient(115deg,#7a5c0a 0%,#ffe566 20%,#fff8dc 32%,#ffe566 44%,#c9a020 60%,#7a5c0a 100%)',
            backgroundSize:'250% auto',WebkitBackgroundClip:'text',WebkitTextFillColor:'transparent'}}>
          {title}
        </h2>
        <p className="text-slate-300 text-xs text-center" style={CINZEL}>Chargement des images et des sons</p>
        <div className="w-64 max-w-[60vw] h-2.5 rounded-full bg-black/50 border border-amber-900/40 overflow-hidden">
          <div className="h-full rounded-full bg-gradient-to-r from-amber-700 via-amber-400 to-amber-200 transition-all duration-200 ease-out" style={{width:`${progress}%`}}/>
        </div>
        <p className="text-amber-200/70 text-xs" style={CINZEL}>{progress}%</p>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
//  TUTORIAL — shown automatically on a player's first Solo vs IA match
// ═══════════════════════════════════════════════════════════════════════════════
const TUTORIAL_STEPS=[
  {icon:'👋',title:'Bienvenue !',text:"C'est votre première partie contre l'IA. Ce court tutoriel explique les règles et les actions — vous pouvez le passer à tout moment, le plateau reste visible derrière."},
  {icon:'🎲',title:'Le plateau',text:"On joue sur une grille de 5×5 cases. Les 4 coins (marqués d'une croix) sont bloqués. Votre camp est en haut du plateau, celui de l'IA en bas."},
  {icon:'🎴',title:'Vos cartes',text:"Chaque carte a un chiffre sur ses 8 faces (haut, bas, côtés, diagonales). Votre deck compte 6 cartes : 2 faibles, 2 moyennes et 2 puissantes."},
  {icon:'✋',title:'Poser une carte',text:"Glissez une carte depuis votre main (en haut de l'écran) vers une case libre de votre camp. Une seule pose par tour."},
  {icon:'↔️',title:'Déplacer une carte',text:"Vous pouvez déplacer jusqu'à 2 cartes déjà en jeu, diagonales autorisées, en les faisant glisser vers une case adjacente libre."},
  {icon:'⚔️',title:'Attaquer',text:"Glissez une de vos cartes sur une carte adverse juste à côté (haut, bas, gauche ou droite — pas en diagonale) pour l'attaquer. Une seule attaque par tour."},
  {icon:'💥',title:'Le combat',text:"Lors d'une attaque, les faces qui se touchent perdent chacune 1 point. Si un chiffre tombe sous zéro, la carte est détruite."},
  {icon:'🃏',title:'Les pouvoirs',text:"La barre de pouvoirs propose des cartes spéciales gratuites, qui ne consomment pas vos actions normales : vous commencez avec 2 Barrage (bloquer définitivement une case vide) et 1 Rotation (faire tourner les chiffres d'une carte)."},
  {icon:'🏆',title:'Victoire',text:"Dès qu'un joueur n'a plus aucune carte, ni en main ni sur le plateau, la partie se termine et son adversaire gagne. Bonne chance !"},
]
const DECK_TUTORIAL_STEPS=[
  {icon:'🃏',title:'D\'où viennent les cartes ?',text:"Il n'est plus possible de créer des cartes à la main : toutes proviennent des boosters. Ouvrez-en un depuis la page Booster pour obtenir de nouvelles cartes."},
  {icon:'📦',title:'Votre collection',text:"Les cartes obtenues attendent dans votre collection, sur la page Booster, tant qu'elles ne sont pas assignées à un deck."},
  {icon:'➕',title:'Construire un deck',text:"Depuis la page Booster, choisissez un deck pour chaque carte de votre collection (bouton « Ajouter à un deck »). Un deck contient entre 1 et 10 cartes."},
  {icon:'⚖️',title:'Les limites',text:`Chaque deck a un total de ${DECK_MAX_POINTS} points maximum. Les cartes classiques sont plafonnées à ${CARD_MAX_POINTS} points ; les cartes rares de booster peuvent dépasser ce plafond individuel.`},
  {icon:'↔️',title:'Réorganiser',text:"Depuis l'éditeur d'un deck, vous pouvez retirer une carte (elle retourne dans votre collection) ou la déplacer vers un autre deck."},
  {icon:'⭐',title:'Deck par défaut',text:"Marquez un deck comme « par défaut » : c'est celui utilisé automatiquement en Partie Locale et Solo vs IA."},
]
function TutorialOverlay({onClose,steps=TUTORIAL_STEPS,finalLabel='Compris, jouer !'}){
  const[step,setStep]=useState(0)
  const s=steps[step]
  const isLast=step===steps.length-1
  return(
    <div className="fixed inset-0 z-40 flex items-end sm:items-center justify-center bg-black/70 backdrop-blur-sm px-4 pb-6 sm:pb-4">
      <div className="wood-btn rounded-2xl p-5 max-w-sm w-full flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <span className="text-amber-300 text-xs font-bold" style={CINZEL}>Tutoriel · {step+1}/{steps.length}</span>
          <button onClick={onClose} className="text-slate-300 hover:text-white text-xs">Passer ✕</button>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-3xl leading-none">{s.icon}</span>
          <h3 className="text-amber-200 font-black text-lg" style={CINZEL}>{s.title}</h3>
        </div>
        <p className="text-slate-200 text-sm leading-relaxed">{s.text}</p>
        <div className="flex items-center gap-2 mt-2">
          {step>0&&<MedBtn onClick={()=>setStep(v=>v-1)} color="#a89484" className="flex-1 justify-center">Précédent</MedBtn>}
          <MedBtn onClick={()=>isLast?onClose():setStep(v=>v+1)} color="#7cb87c" className="flex-1 justify-center">{isLast?finalLabel:'Suivant'}</MedBtn>
        </div>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
//  GAME SCREEN
// ═══════════════════════════════════════════════════════════════════════════════
function GameScreen({game,soundEnabled,myPlayer,isAI,onAction,onEndTurn,onHome,onPowerAction,onSurrender,lastAnim,syncError,showTutorial,onTutorialClose,pseudo}){
  const[drag,setDrag]=useState(null)
  const[zoomedCard,setZoomedCard]=useState(null)
  const[anims,setAnims]=useState({})
  const[ghosts,setGhosts]=useState({})
  const[violentKeys,setViolentKeys]=useState({})
  const[targeting,setTargeting]=useState(null)
  const[confirmSurrender,setConfirmSurrender]=useState(false)
  const[gameScale,setGameScale]=useState(1)
  const[compact,setCompact]=useState(()=>window.innerWidth<640)
  const touchDragRef=useRef(null)
  const localGameRef=useRef(game)
  const myPlayerRef_=useRef(myPlayer)
  const targetingRef_=useRef(targeting)
  const cbRef=useRef({})
  const animTimersRef=useRef([])
  useEffect(()=>{localGameRef.current=game},[game])
  useEffect(()=>{myPlayerRef_.current=myPlayer},[myPlayer])
  useEffect(()=>{targetingRef_.current=targeting},[targeting])
  useEffect(()=>{
    const update=()=>{
      const w=window.innerWidth
      const c=w<640
      setCompact(c)
      // zoom only on compact mode: design width = 5×68 + 4×4 + 2×6 = 368
      setGameScale(c?Math.min(1,w/368):1)
    }
    update()
    window.addEventListener('resize',update)
    return()=>window.removeEventListener('resize',update)
  },[])
  const{board,players,currentPlayer,actionsLeft}=game
  const isMyTurn=myPlayer===null||myPlayer===currentPlayer
  const canEndTurn=hasActedThisTurn(actionsLeft)
  const p1pts=playerPts(game,1),p2pts=playerPts(game,2)

  function triggerAnim(r,c,cls,dur=420){
    const key=`${r},${c}`;setAnims(p=>({...p,[key]:cls}));setTimeout(()=>setAnims(p=>{const n={...p};delete n[key];return n}),dur)
  }
  // Central animation pipeline — driven by the parent, covers both human and AI actions.
  // Cards that die are rendered as a "ghost" snapshot since the board already nulled them out.
  // Timers are kept in a ref (not a useEffect cleanup) so a NEW action's effect run never
  // cancels a still-pending ghost/anim removal from a PREVIOUS action — cancelling it would
  // leave e.g. `ghosts[key]` stuck forever, permanently hiding any card later placed there.
  useEffect(()=>{
    if(!lastAnim)return
    lastAnim.cells.forEach(({r,c,ghost,anim,dur})=>{
      const key=`${r},${c}`
      if(ghost){
        setGhosts(p=>({...p,[key]:{card:ghost,anim}}))
        animTimersRef.current.push(setTimeout(()=>setGhosts(p=>{const n={...p};delete n[key];return n}),dur))
      }else{
        setAnims(p=>({...p,[key]:anim}))
        animTimersRef.current.push(setTimeout(()=>setAnims(p=>{const n={...p};delete n[key];return n}),dur))
      }
    })
    if(lastAnim.violent){
      const keys=lastAnim.cells.filter(c=>c.ghost).map(c=>`${c.r},${c.c}`)
      setViolentKeys(p=>{const n={...p};keys.forEach(k=>n[k]=true);return n})
      animTimersRef.current.push(setTimeout(()=>setViolentKeys(p=>{const n={...p};keys.forEach(k=>delete n[k]);return n}),700))
    }
  },[lastAnim])
  useEffect(()=>()=>animTimersRef.current.forEach(clearTimeout),[])
  function handleDragStart(e,from,...args){
    if(targeting)return
    e.dataTransfer.effectAllowed='move'
    let card=null
    if(from==='hand'){const[hi,pl]=args;card=game.players[pl].hand[hi];setDrag({from:'hand',handIdx:hi,player:pl})}
    if(from==='board'){const[r,c]=args;card=game.board[r][c];setDrag({from:'board',r,c})}
    if(card){
      const ghost=createDragGhost(card)
      e.dataTransfer.setDragImage(ghost,85,85)
      requestAnimationFrame(()=>requestAnimationFrame(()=>{if(ghost.parentNode)document.body.removeChild(ghost)}))
    }
  }
  function handleDrop(e,r,c){
    if(!drag||targeting)return
    onAction({drag,targetR:r,targetC:c})
    setDrag(null)
  }
  function handleCellClick(r,c){
    if(!targeting||!isMyTurn)return
    if(!isValidPowerTarget(game,targeting,currentPlayer,r,c))return
    onPowerAction(targeting,r,c);triggerAnim(r,c,'anim-power',500);setTargeting(null);snd('power',soundEnabled)
  }
  // keep cbRef fresh every render (used by document touch listeners)
  cbRef.current.onAction=onAction

  function handleTouchStart(e,from,...args){
    if(targetingRef_.current)return
    const g=localGameRef.current;if(!g)return
    const cp=g.currentPlayer,al=g.actionsLeft
    const isMyT=myPlayerRef_.current===null||myPlayerRef_.current===cp
    if(!isMyT)return
    let card=null,dragInfo=null
    if(from==='hand'){
      const[hi,pl]=args
      if(al.placement<=0||pl!==cp)return
      card=g.players[pl].hand[hi];if(!card)return
      dragInfo={from:'hand',handIdx:hi,player:pl}
    }else if(from==='board'){
      const[r,c_]=args
      card=g.board[r][c_];if(!card||card.owner!==cp)return
      if(al.moves<=0&&al.attack<=0)return
      dragInfo={from:'board',r,c:c_}
    }
    if(!card||!dragInfo)return
    e.preventDefault()
    const touch=e.touches[0]
    const ghost=createDragGhost(card)
    ghost.style.top=`${touch.clientY-85}px`
    ghost.style.left=`${touch.clientX-85}px`
    ghost.style.zIndex='9999'
    touchDragRef.current={drag:dragInfo,ghost}
    setDrag(dragInfo)
  }
  useEffect(()=>{
    const onMove=(e)=>{
      if(!touchDragRef.current?.ghost)return
      e.preventDefault()
      const t=e.touches[0]
      touchDragRef.current.ghost.style.top=`${t.clientY-85}px`
      touchDragRef.current.ghost.style.left=`${t.clientX-85}px`
    }
    const onEnd=(e)=>{
      if(!touchDragRef.current)return
      const{drag,ghost}=touchDragRef.current
      touchDragRef.current=null
      if(ghost?.parentNode)ghost.parentNode.removeChild(ghost)
      const t=e.changedTouches[0]
      const el=document.elementFromPoint(t.clientX,t.clientY)
      const cellEl=el?.closest('[data-cell]')
      if(cellEl&&drag){
        const[rv,cv]=cellEl.dataset.cell.split(',').map(Number)
        cbRef.current.onAction({drag,targetR:rv,targetC:cv})
      }
      setDrag(null)
    }
    document.addEventListener('touchmove',onMove,{passive:false})
    document.addEventListener('touchend',onEnd)
    return()=>{
      document.removeEventListener('touchmove',onMove)
      document.removeEventListener('touchend',onEnd)
    }
  },[])
  // Tailwind can't statically see classes built from a template string like
  // `bg-${color}-900/50` — they never made it into the compiled CSS, so these
  // badges rendered with no color at all. Use a lookup of complete class
  // strings instead, with solid/opaque colors for real contrast.
  const ACTION_BADGE_COLOR={green:'bg-emerald-600 text-white border-emerald-300',yellow:'bg-amber-400 text-black border-amber-200',red:'bg-red-600 text-white border-red-300'}
  const badge=(label,count,color)=>`px-2.5 py-1 rounded-full text-xs font-bold border shadow-sm ${count>0?ACTION_BADGE_COLOR[color]:'bg-slate-800/60 text-slate-500 border-slate-700/50'}`

  // Render function (not a component) — avoids remount-on-render which kills drag events
  const renderHand=(player,canDrag)=>{
    const isP1=player===1
    const activeColor=isP1?'text-blue-400':'text-red-400'
    const pts=isP1?p1pts:p2pts
    // Show the logged-in player's pseudo on their own hand (Solo vs IA: always P1;
    // online: whichever side myPlayer is). Local hotseat has no single "you" — both
    // sides are physically shared on one device — so it keeps J1/J2. The opponent's
    // identity isn't synced anywhere yet, so it also falls back to J1/J2.
    const isYou=myPlayer!=null&&player===myPlayer
    const label=isAI&&!isP1
      ?<span className="flex items-center gap-1"><Bot size={11}/>IA</span>
      :(isYou&&pseudo?pseudo:(isP1?'J1':'J2'))
    return(
      <div className="game-hand-section flex flex-col items-center gap-1.5">
        <div className="flex items-center gap-2">
          {currentPlayer===player&&<span className="w-2 h-2 rounded-full bg-green-400 animate-pulse inline-block"/>}
          <span className={`${activeColor} text-xs font-bold`}>{label} · {pts} pts</span>
        </div>
        <div className={`game-hand-cards flex ${compact?'gap-1.5':'gap-3'} justify-center flex-wrap`}>
          {(players[player]?.hand??[]).map((card,i)=>(
            <div key={card.id} className="anim-idle" style={{animationDelay:`${i*0.18}s`}}>
              <CardFace card={card} compact={compact} draggable={canDrag} onDragStart={e=>handleDragStart(e,'hand',i,player)} onTouchStart={canDrag?e=>handleTouchStart(e,'hand',i,player):undefined} onClick={e=>{e.stopPropagation();setZoomedCard(card)}}/>
            </div>
          ))}
          {!(players[player]?.hand?.length)&&<span className={`text-slate-600 text-xs flex items-center justify-center border-2 border-dashed border-slate-700/40 rounded-xl ${compact?'w-[64px] h-[64px]':'w-[118px] h-[118px]'}`}>vide</span>}
        </div>
      </div>
    )
  }

  return(
    <div className="game-outer min-h-screen bg-gradient-to-br from-slate-900 via-slate-900 to-slate-800 overflow-y-auto relative">
      <CardZoomOverlay card={zoomedCard} onClose={()=>setZoomedCard(null)} renderCard={c=><CardFace card={c} zoom/>}/>
      {showTutorial&&<TutorialOverlay onClose={onTutorialClose}/>}
      <BackButton onClick={onHome} compact className="absolute top-3 left-3 z-10">Menu</BackButton>
      {syncError&&(
        <div className="fixed top-0 left-0 right-0 z-30 bg-red-900/95 text-red-100 text-xs text-center py-1.5 px-10">
          ⚠ Synchronisation en ligne interrompue : {syncError}
        </div>
      )}
      <div className={`game-inner flex flex-col items-center ${compact?'gap-2 pt-14 pb-2':'gap-3 py-4'} px-2`} style={{zoom:gameScale,transformOrigin:'top center'}}>

        {/* J1 hand — top */}
        {renderHand(1,currentPlayer===1&&isMyTurn&&actionsLeft.placement>0&&!targeting)}

        {/* Board + controls */}
        <div className={`game-board-area flex flex-col items-center ${compact?'gap-1.5':'gap-2'}`}>
          <div className="flex gap-2">
            <span className={badge('Pose',actionsLeft.placement,'green')}>Pose {actionsLeft.placement}</span>
            <span className={badge('Dépl',actionsLeft.moves,'yellow')}>Dépl {actionsLeft.moves}</span>
            <span className={badge('Att',actionsLeft.attack,'red')}>Att {actionsLeft.attack}</span>
          </div>
          <div className={`grid grid-cols-5 ${compact?'gap-1 p-1.5':'gap-1.5 p-2.5'} rounded-2xl border transition-all ${targeting?'border-purple-600/60 shadow-[0_0_20px_rgba(147,51,234,0.2)]':'border-slate-700/30'}`}
            style={{backgroundImage:'url(/images/plateau.png)',backgroundSize:'cover',backgroundPosition:'center'}}>
            {board.map((row,r)=>row.map((cell,c)=>(
              <Cell key={`${r}-${c}`} r={r} c={c} card={cell} currentPlayer={currentPlayer} actionsLeft={actionsLeft} myPlayer={myPlayer}
                onDragStart={handleDragStart} onDrop={handleDrop} onCellClick={handleCellClick} onZoom={setZoomedCard}
                animKey={anims[`${r},${c}`]||''} ghost={ghosts[`${r},${c}`]} violent={!!violentKeys[`${r},${c}`]}
                targeting={targeting} game={game} onBoardTouchStart={handleTouchStart} compact={compact}/>
            )))}
          </div>
          <PowerBar game={game} isMyTurn={isMyTurn} targeting={targeting} onActivatePower={type=>setTargeting(type)} onCancelTargeting={()=>setTargeting(null)} compact={compact}/>
          <div className="flex items-center gap-3 flex-wrap justify-center">
            <span className={`text-sm font-bold ${currentPlayer===1?'text-blue-400':'text-red-400'}`}>
              Tour — {isAI&&currentPlayer===2?<span className="flex items-center gap-1.5"><Bot size={14} className="inline"/> IA réfléchit… <span className="animate-pulse">▪▪▪</span></span>:`Joueur ${currentPlayer}`}
              {!isAI&&myPlayer&&myPlayer!==currentPlayer&&<span className="text-slate-500 font-normal ml-2">(en attente…)</span>}
            </span>
            {isMyTurn&&!targeting&&!(isAI&&currentPlayer===2)&&(
              <button onClick={onEndTurn} disabled={!canEndTurn}
                title={canEndTurn?undefined:'Effectuez au moins une action (pose, déplacement ou attaque) avant de terminer votre tour.'}
                className={`font-bold py-1.5 px-4 rounded-lg text-sm transition-all duration-200 ${canEndTurn?'bg-emerald-700 hover:bg-emerald-600 hover:scale-105 active:scale-95 text-white':'bg-slate-700 text-slate-400 cursor-not-allowed opacity-60'}`}>
                Fin du tour ▶
              </button>
            )}
            {isMyTurn&&!canEndTurn&&!targeting&&!(isAI&&currentPlayer===2)&&(
              <span className="text-amber-400/80 text-xs">Effectuez au moins une action pour terminer le tour.</span>
            )}
            {!(isAI&&currentPlayer===2)&&(
              confirmSurrender?(
                <span className="flex items-center gap-1.5">
                  <span className="text-slate-400 text-xs">Capituler ?</span>
                  <button onClick={()=>{onSurrender(myPlayer??currentPlayer);setConfirmSurrender(false)}} className="bg-red-700 hover:bg-red-600 hover:scale-110 active:scale-95 text-white font-bold py-0.5 px-2 rounded text-xs transition-all duration-200">Oui</button>
                  <button onClick={()=>setConfirmSurrender(false)} className="bg-slate-700 hover:bg-slate-600 hover:scale-110 active:scale-95 text-white font-bold py-0.5 px-2 rounded text-xs transition-all duration-200">Non</button>
                </span>
              ):(
                <button onClick={()=>setConfirmSurrender(true)} className="text-slate-500 hover:text-red-400 hover:scale-110 active:scale-95 inline-block transition-all duration-200">⚑ Cap.</button>
              )
            )}
          </div>
        </div>

        {/* J2 hand — bottom */}
        {renderHand(2,currentPlayer===2&&isMyTurn&&actionsLeft.placement>0&&!targeting&&!isAI)}

      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
//  MENU / RULES / LOBBY / GAMEOVER
// ═══════════════════════════════════════════════════════════════════════════════
const CINZEL_DEC = {fontFamily:"'Cinzel Decorative', serif"}
const CINZEL     = {fontFamily:"'Cinzel', serif"}

function MenuBtn({onClick, icon, color, children, delay}){
  return(
    <button onClick={onClick}
      className="wood-btn menu-fade-up w-full flex items-center justify-center gap-3 px-5 py-3.5 sm:py-3 rounded-lg select-none cursor-pointer"
      style={{...CINZEL, fontSize:'0.88rem', letterSpacing:'0.08em', animationDelay:delay, color,
        textShadow:'0 1px 2px rgba(0,0,0,0.85)'}}>
      {icon}<span>{children}</span>
    </button>
  )
}

// Unified "back" button — same look on every screen (menu, deck builder, in-game, etc.)
function BackButton({onClick, children='Menu', compact=false, disabled=false, className=''}){
  return(
    <button onClick={onClick} disabled={disabled}
      className={`wood-btn inline-flex items-center gap-2 rounded-lg select-none ${disabled?'opacity-40 cursor-not-allowed':'cursor-pointer'} ${compact?'px-2.5 py-1.5 text-xs':'px-4 py-2 text-sm'} ${className}`}
      style={{...CINZEL, letterSpacing:'0.06em', color:'#e8c766',
        textShadow:'0 1px 2px rgba(0,0,0,0.85)'}}>
      <Home size={compact?14:16}/><span>{children}</span>
    </button>
  )
}

// Small medieval-styled action button reused across the Deck Builder
function MedBtn({onClick, icon, color='#c9a020', children, className='', disabled=false, title, as='button'}){
  const Tag = as
  return(
    <Tag onClick={onClick} title={title} disabled={as==='button'?disabled:undefined}
      className={`wood-btn inline-flex items-center justify-center gap-2 rounded-lg select-none ${disabled?'opacity-40 cursor-not-allowed':'cursor-pointer'} ${className}`}
      style={{...CINZEL, fontSize:'0.8rem', letterSpacing:'0.06em', padding:'0.55rem 1.1rem', color,
        textShadow:'0 1px 2px rgba(0,0,0,0.85)'}}>
      {icon}{children&&<span>{children}</span>}
    </Tag>
  )
}

// Fixed (non-random-per-render) ember field for the menu background —
// positions/timings are hand-spread via index math so the layout never jumps on re-render.
const MENU_EMBERS = Array.from({length:18},(_,i)=>({
  left: (i*53.7)%100,
  size: 3+(i%4)*2.2,
  duration: 8+(i%6)*1.6,
  delay: -(i*1.7),
  drift: (i%2===0?1:-1)*(12+(i%3)*10),
}))

function MenuIconBtn({onClick, icon, label, color, delay, title}){
  return(
    <button onClick={onClick} title={title}
      className="menu-fade-up flex-1 min-w-0 flex flex-col items-center gap-1 py-2 rounded-lg transition-all duration-200 hover:scale-110 active:scale-90 select-none cursor-pointer"
      style={{animationDelay:delay}}>
      <span className="wood-btn w-10 h-10 flex items-center justify-center rounded-full" style={{color}}>
        {icon}
      </span>
      <span className="text-[10px] font-bold tracking-wide truncate max-w-full" style={{...CINZEL, color}}>{label}</span>
    </button>
  )
}

// Shared bottom icon nav — used by the main menu, Deck Builder and Booster screens
// so switching between these sections never requires a trip back through the menu.
// Fixed to the bottom of the viewport on every screen that uses it, so it's
// always reachable without scrolling — like a native app's tab bar.
function BottomNav({onDeckBuilder,onBooster,onRules,onAccount,onShop,onSocial,unreadCount=0,user,className=''}){
  return(
    <div className={`fixed inset-x-0 z-20 mx-auto w-[calc(100%-1.5rem)] max-w-md flex items-stretch justify-around gap-1 px-2 py-2 rounded-2xl border border-amber-900/50 ${className}`}
      style={{background:'linear-gradient(135deg,rgba(10,7,3,0.85),rgba(20,13,5,0.82))', boxShadow:'0 4px 20px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.05)',
        bottom:'max(0.75rem, env(safe-area-inset-bottom))'}}>
      <MenuIconBtn onClick={onDeckBuilder} icon={<Layers size={18}/>} label="Decks" color="#34d399"/>
      {user
        ?<MenuIconBtn onClick={onBooster} icon={<Gift size={18}/>} label="Booster" color="#f472b6"/>
        :<MenuIconBtn onClick={onAccount} icon={<Lock size={16}/>} label="Booster" color="#64748b"/>
      }
      <MenuIconBtn onClick={onShop}    icon={<Store size={18}/>}    label="Boutique" color="#f59e0b"/>
      {user
        ?<MenuIconBtn onClick={onSocial} icon={<span className="relative">{unreadCount>0&&<span className="absolute -top-1 -right-1.5 w-3.5 h-3.5 rounded-full bg-red-600 text-white text-[8px] font-bold flex items-center justify-center leading-none">{unreadCount>9?'9+':unreadCount}</span>}<Bell size={18}/></span>} label="Amis" color="#c084fc"/>
        :<MenuIconBtn onClick={onAccount} icon={<Lock size={16}/>} label="Amis" color="#64748b"/>
      }
      <MenuIconBtn onClick={onRules}   icon={<BookOpen size={18}/>} label="Règles"   color="#fbbf24"/>
      <MenuIconBtn onClick={onAccount} icon={<UserCircle size={18}/>} label={user?'Compte':'Connexion'} color="#38bdf8" title={user?(user.displayName||user.email):undefined}/>
    </div>
  )
}

// Small fixed coin balance badge, reused on any screen where coins are earned/spent.
// Sits below the sound toggle (also fixed top-right) so the two never overlap.
function CoinBadge({coins,onClick}){
  const[displayCoins,setDisplayCoins]=useState(coins)
  const[pulse,setPulse]=useState(false)
  const prevRef=useRef(coins)
  useEffect(()=>{
    const from=prevRef.current,to=coins
    if(from===to)return
    prevRef.current=to
    setPulse(false);requestAnimationFrame(()=>setPulse(true)) // restart the animation even if it's already mid-run
    const duration=600,start=performance.now()
    let raf
    const step=(now)=>{
      const p=Math.min(1,(now-start)/duration)
      const eased=1-Math.pow(1-p,3)
      setDisplayCoins(Math.round(from+(to-from)*eased))
      if(p<1)raf=requestAnimationFrame(step)
    }
    raf=requestAnimationFrame(step)
    const clearPulse=setTimeout(()=>setPulse(false),650)
    return()=>{cancelAnimationFrame(raf);clearTimeout(clearPulse)}
  },[coins])
  return(
    <button onClick={onClick} title="Boutique"
      className={`wood-btn fixed top-14 right-3 z-20 flex items-center gap-1.5 px-3 py-1.5 rounded-lg cursor-pointer ${pulse?'coin-badge-pulse':''}`} style={{color:'#fbbf24'}}>
      <Coins size={15} className={pulse?'coin-flip':''}/><span className="font-bold text-sm tabular-nums" style={CINZEL}>{displayCoins}</span>
    </button>
  )
}

function MenuScreen({onLocal,onAI,onOnline,onRules,onDeckBuilder,onAccount,onBooster,onShop,onSocial,unreadCount,user,coins}){
  return(
    <div className="bg-charta menu-screen relative flex flex-col items-center gap-4 px-4 overflow-hidden">

      <CoinBadge coins={coins} onClick={onShop}/>
      <div className="menu-embers" aria-hidden="true">
        {MENU_EMBERS.map((e,i)=>(
          <span key={i} className="menu-ember" style={{
            left:`${e.left}%`, width:e.size, height:e.size,
            animationDuration:`${e.duration}s`, animationDelay:`${e.delay}s`,
            '--drift':`${e.drift}px`,
          }}/>
        ))}
      </div>
      <div className="menu-vignette-pulse" aria-hidden="true"/>

      <div className="relative z-10 flex-1 flex flex-col items-center justify-center gap-8 sm:gap-10 w-full">
        <div className="text-center menu-fade-up" style={{animationDelay:'0s'}}>
          <h1 className="charta-title text-5xl sm:text-6xl font-black tracking-wide leading-tight"
            style={{...CINZEL_DEC,
              background:'linear-gradient(115deg,#7a5c0a 0%,#ffe566 20%,#fff8dc 32%,#ffe566 44%,#c9a020 60%,#7a5c0a 100%)',
              backgroundSize:'250% auto',
              WebkitBackgroundClip:'text',WebkitTextFillColor:'transparent'}}>
            Charta Logica
          </h1>
          <div className="text-amber-600/70 text-base sm:text-lg tracking-widest mt-1 select-none">⸺⸺ ✦ ⸺⸺</div>
          <p className="inline-block mt-2 px-3 py-1 rounded-full text-slate-100 text-[13px] sm:text-sm tracking-[0.06em] bg-black/45 border border-amber-700/40 shadow-[0_2px_10px_rgba(0,0,0,0.5)]"
            style={CINZEL}>Jeu de cartes tactique · 2 joueurs</p>
        </div>

        <div className="flex flex-col gap-3 w-full max-w-[17rem] sm:w-64">
          <MenuBtn onClick={onAI}     icon={<Bot   size={16}/>} color="#a78bfa" delay="0.05s">Solo vs IA</MenuBtn>
          <MenuBtn onClick={onLocal}  icon={<Users size={16}/>} color="#60a5fa" delay="0.10s">Partie Locale</MenuBtn>
          <MenuBtn onClick={onOnline} icon={<Wifi  size={16}/>} color="#c084fc" delay="0.15s">Partie en Ligne</MenuBtn>
        </div>
      </div>

      <BottomNav onDeckBuilder={onDeckBuilder} onBooster={onBooster} onRules={onRules} onAccount={onAccount} onShop={onShop} onSocial={onSocial} unreadCount={unreadCount} user={user}/>
    </div>
  )
}
function RulesScreen({onBack,user,onDeckBuilder,onBooster,onRules,onAccount,onShop,onSocial,unreadCount}){
  const S=[
    ['🎴 Les cartes','Chaque carte a un chiffre sur chacune de ses 8 faces (haut, bas, les côtés, et les diagonales). Votre deck compte 6 cartes : deux plutôt faibles, deux moyennes et deux très puissantes. Vous pouvez créer les vôtres dans le Deck Builder, avec vos propres chiffres et un portrait de votre choix (d\'autres s\'achètent dans la Boutique).'],
    ['🎲 Le plateau','On joue sur une grille de 5 cases sur 5. Les 4 coins sont bloqués : personne ne peut y poser de carte. Vous démarrez en haut du plateau, votre adversaire en bas.'],
    ['⚡ Pendant votre tour','À chaque tour, vous pouvez poser une carte depuis votre main dans votre camp, déplacer deux cartes déjà en jeu (les déplacements en diagonale sont autorisés), et attaquer une fois une carte adverse juste à côté de la vôtre (seulement en haut, en bas, à gauche ou à droite — pas en diagonale). Vos pouvoirs spéciaux sont gratuits et ne comptent pas dans ces actions.'],
    ['💥 Le combat','Quand vous attaquez une carte voisine, vos deux cartes s\'affrontent sur les faces qui se touchent : chacune y perd 1 point. Si un chiffre tombe sous zéro, la carte est détruite.'],
    ['🃏 Les pouvoirs','En plus de vos cartes classiques, vous disposez de pouvoirs gratuits, à utiliser quand vous le souhaitez : vous commencez la partie avec 2 cartes Barrage (bloque définitivement une case vide du plateau) et 1 carte Rotation (fait tourner les chiffres d\'une carte).'],
    ['🤖 Face à l\'ordinateur','En mode Solo, votre adversaire est joué par une intelligence artificielle : elle pose, déplace, attaque et utilise ses pouvoirs toute seule.'],
    ['🏆 Comment gagner','Dès qu\'un joueur n\'a plus aucune carte, ni en main ni sur le plateau, la partie s\'arrête et son adversaire remporte la victoire.'],
  ]
  return(
    <div className="relative min-h-screen">
      <div className="bg-charta fixed inset-0" aria-hidden="true"/>
      <div className="relative scrollbar-hide min-h-screen overflow-y-auto py-8 pb-28 px-4 flex flex-col items-center">
        <div className="max-w-lg w-full">
          <BackButton onClick={onBack} className="mb-6">Menu</BackButton>
          <h2 className="text-3xl font-black mb-5" style={{...CINZEL_DEC,background:'linear-gradient(to bottom,#ffe566,#c9a020)',WebkitBackgroundClip:'text',WebkitTextFillColor:'transparent',filter:'drop-shadow(0 1px 10px rgba(0,0,0,1))'}}>Règles du jeu</h2>
          {S.map(([t,d])=>(
            <div key={t} className="rounded-xl p-4 mb-3 border border-amber-900/40" style={{background:'rgba(8,5,2,0.78)'}}>
              <h3 className="text-amber-300 font-bold mb-1" style={CINZEL}>{t}</h3>
              <p className="text-slate-300 text-sm leading-relaxed">{d}</p>
            </div>
          ))}
        </div>
      </div>
      <BottomNav onDeckBuilder={onDeckBuilder} onBooster={onBooster} onRules={onRules} onAccount={onAccount} onShop={onShop} onSocial={onSocial} unreadCount={unreadCount} user={user}/>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
//  LEGAL — Terms of Service (CGU) and Privacy Policy
//  Drafted from an actual audit of what the app stores (Firebase Auth, the
//  Realtime Database paths in firebase.js, and the localStorage keys in this
//  file) — not boilerplate. Still: this is a starting draft, not legal advice.
//  Have it reviewed by a qualified professional before a real Play Store
//  submission, and fill in the bracketed placeholders (legal form, address,
//  SIRET) once the publishing entity is registered.
// ═══════════════════════════════════════════════════════════════════════════════
const LEGAL_LAST_UPDATED='17 juillet 2026'
const LEGAL_PUBLISHER='Linereve'
const LEGAL_CONTACT='thodalf@gmail.com'
const LEGAL_APP='Charta Logica'

const CGU_SECTIONS=[
  ['1. Objet',
    `Les présentes Conditions Générales d'Utilisation (« CGU ») régissent l'accès et l'utilisation de l'application ${LEGAL_APP} (le « Service »), un jeu de cartes tactique à deux joueurs, éditée par ${LEGAL_PUBLISHER}. En créant un compte ou en utilisant le Service, vous acceptez sans réserve les présentes CGU. Si vous ne les acceptez pas, veuillez ne pas utiliser le Service.`],
  ['2. Éditeur',
    `Le Service est édité par ${LEGAL_PUBLISHER} EURL, C/O DIGIDOM 10 RUE DE PENTHIEVRE 75008 PARIS, SIRET 92049503300010. Pour toute question relative aux présentes CGU, vous pouvez nous contacter à l'adresse ${LEGAL_CONTACT}.`],
  ['3. Accès au service et compte utilisateur',
    `Certaines fonctionnalités (parties en ligne, boosters de cartes, boutique, decks personnalisés, amis) nécessitent la création d'un compte, par email/mot de passe ou via Google Sign-In. D'autres (partie locale, solo contre l'IA avec un deck aléatoire, règles) restent accessibles sans compte, avec une sauvegarde limitée à votre appareil. Vous êtes responsable de la confidentialité de vos identifiants et de toute activité effectuée depuis votre compte.`],
  ['4. Âge minimum',
    `L'utilisation du Service avec un compte est réservée aux personnes âgées d'au moins 15 ans, conformément à l'âge du consentement numérique applicable en France. Si vous avez moins de 15 ans, la création d'un compte nécessite l'accord d'un titulaire de l'autorité parentale.`],
  ['5. Pseudo et comportement',
    `Votre pseudo est visible par les autres joueurs (adversaires en ligne, amis) et peut être recherché par eux pour vous ajouter en ami. Vous vous engagez à choisir un pseudo non injurieux, non usurpateur d'identité et respectueux d'autrui, et à ne pas utiliser le Service à des fins de harcèlement, de triche ou de contournement des mécaniques de jeu. Nous nous réservons le droit de suspendre un compte en cas de manquement manifeste.`],
  ['6. Monnaie virtuelle et boutique',
    `Les « pièces » gagnées en jouant (ouverture de boosters, victoires) sont une monnaie purement virtuelle, sans valeur monétaire réelle, non convertible en argent, non transférable entre comptes et non remboursable. L'achat de pièces avec de l'argent réel n'est pas proposé à ce jour. Les portraits de cartes achetés en boutique et les cartes obtenues par booster sont des contenus cosmétiques/de jeu liés à votre compte, sans valeur en dehors du Service.`],
  ['7. Fonctionnalités en ligne et sociales',
    `Le mode « Partie en Ligne », le système d'amis et les notifications reposent sur une infrastructure tierce (Firebase, voir la Politique de confidentialité) et nécessitent une connexion internet. Nous ne garantissons pas la disponibilité permanente de ces fonctionnalités ni l'absence d'interruption du service de mise en relation entre joueurs.`],
  ['8. Propriété intellectuelle',
    `L'application, son design, ses illustrations, sa charte graphique et son code sont la propriété de ${LEGAL_PUBLISHER} ou de ses concédants, et sont protégés par le droit de la propriété intellectuelle. Toute reproduction ou exploitation non autorisée est interdite. Les decks et pseudos que vous créez restent votre contenu ; en les utilisant dans le Service, vous nous accordez le droit technique nécessaire de les stocker et de les afficher aux autres joueurs dans le cadre du jeu.`],
  ['9. Disponibilité et évolution du service',
    `Nous nous efforçons d'assurer un accès continu au Service mais ne garantissons pas une disponibilité ininterrompue. Le Service peut évoluer (nouvelles fonctionnalités, rééquilibrages, changements d'interface) ou être interrompu, temporairement ou définitivement, à tout moment.`],
  ['10. Suspension et suppression de compte',
    `Vous pouvez supprimer votre compte et vos données à tout moment depuis l'écran « Mon Compte » de l'application. Nous pouvons suspendre ou supprimer un compte en cas de violation des présentes CGU, notamment en cas de triche, harcèlement ou usurpation d'identité.`],
  ['11. Responsabilité',
    `Le Service est fourni « en l'état ». Dans la limite permise par la loi, ${LEGAL_PUBLISHER} ne saurait être tenu responsable des dommages indirects résultant de l'utilisation du Service, ni de la perte de données due à une défaillance d'un service tiers (Firebase, hébergement) hors de notre contrôle.`],
  ['12. Droit applicable',
    `Les présentes CGU sont soumises au droit français. Tout litige relatif à leur interprétation ou leur exécution relève, à défaut de résolution amiable, des juridictions compétentes.`],
  ['13. Modification des CGU',
    `Nous pouvons modifier ces CGU pour refléter une évolution du Service ou de la réglementation. La date de dernière mise à jour figure en haut de ce document. En cas de modification substantielle, nous vous en informerons dans l'application.`],
  ['14. Contact',
    `Pour toute question relative aux présentes CGU : ${LEGAL_CONTACT}.`],
]

const PRIVACY_SECTIONS=[
  ['1. Responsable du traitement',
    `Le responsable du traitement de vos données personnelles est ${LEGAL_PUBLISHER} EURL, C/O DIGIDOM 10 RUE DE PENTHIEVRE 75008 PARIS, SIRET 92049503300010, éditeur de ${LEGAL_APP}, joignable à ${LEGAL_CONTACT}.`],
  ['2. Données que nous collectons',
    `Si vous créez un compte : votre adresse email et votre mot de passe (géré directement par Firebase Authentication — nous n'y avons jamais accès en clair), ou votre profil Google si vous utilisez « Se connecter avec Google » ; votre pseudo ; un identifiant technique unique (UID).\n\nDonnées de jeu liées à votre compte : vos decks, votre collection de cartes, votre solde de pièces virtuelles et vos portraits possédés, vos statistiques (parties jouées, victoires, défaites), votre liste d'amis et demandes d'ami, vos notifications (résultats de parties, demandes/acceptations d'ami, défis).\n\nSi vous jouez sans compte : vos decks, votre collection et vos préférences (son, musique) restent stockés localement sur votre appareil uniquement (« localStorage »), et ne nous sont jamais transmis.`],
  ['3. Pourquoi nous collectons ces données',
    `Nous traitons ces données pour : exécuter le contrat qui nous lie à vous en tant qu'utilisateur du Service (créer et faire fonctionner votre compte, sauvegarder votre progression, permettre les parties en ligne et les fonctionnalités sociales) ; et, pour les préférences techniques (son, tutoriel vu), sur la base de notre intérêt légitime à assurer le bon fonctionnement de l'application. Nous ne faisons pas de profilage, ne vendons aucune donnée et n'affichons aucune publicité ciblée.`],
  ['4. Qui peut voir vos données',
    `Votre pseudo est visible par les autres joueurs (adversaire d'une partie en ligne, autres utilisateurs qui vous recherchent pour vous ajouter en ami) et apparaît dans les notifications liées aux parties et aux demandes d'ami. Votre email, votre mot de passe, votre solde de pièces, vos decks et vos statistiques ne sont jamais visibles par les autres utilisateurs. Nous ne partageons vos données avec aucun tiers à des fins commerciales.`],
  ['5. Sous-traitants et hébergement',
    `Nous faisons appel aux prestataires suivants, qui agissent en tant que sous-traitants ou traitent des données en tant que responsables conjoints selon leurs propres conditions :\n— Google Firebase (Google Ireland Limited / Google LLC) : authentification et base de données en temps réel hébergeant vos données de jeu ;\n— Netlify, Inc. : hébergement du site et de l'application ;\n— Google Fonts : chargement des polices d'écriture de l'interface.\nCes prestataires peuvent traiter des données en dehors de l'Union européenne (notamment aux États-Unis) ; le cas échéant, ce transfert repose sur les clauses contractuelles types de la Commission européenne ou un mécanisme équivalent mis en place par le prestataire.`],
  ['6. Durée de conservation',
    `Vos données de compte et de jeu sont conservées tant que votre compte existe. Les données techniques transitoires (mise en relation pour une partie en ligne, salle de jeu) sont supprimées à la fin de la partie ou après un court délai d'inactivité. Vos notifications sont conservées dans la limite des 50 plus récentes. Si vous supprimez votre compte, vos données sont effacées selon les modalités décrites à la section 9.`],
  ['7. Sécurité',
    `L'accès à vos données est protégé par les règles de sécurité de la base de données Firebase, qui restreignent la lecture et l'écriture de vos données personnelles à votre propre compte authentifié (à l'exception des informations sociales décrites à la section 4, nécessaires au fonctionnement du jeu). Aucune méthode de transmission ou de stockage n'est toutefois sécurisée à 100 %.`],
  ['8. Vos droits',
    `Conformément au RGPD, vous disposez d'un droit d'accès, de rectification, d'effacement, de limitation, d'opposition et de portabilité de vos données. Vous pouvez :\n— rectifier votre pseudo directement depuis l'écran « Mon Compte » ;\n— supprimer votre compte et l'ensemble de vos données associées depuis ce même écran (voir section 9) ;\n— nous contacter à ${LEGAL_CONTACT} pour toute autre demande (accès, portabilité, opposition).\nVous disposez également du droit d'introduire une réclamation auprès de la CNIL (www.cnil.fr) si vous estimez que le traitement de vos données n'est pas conforme à la réglementation.`],
  ['9. Suppression de votre compte',
    `Vous pouvez supprimer votre compte à tout moment depuis l'écran « Mon Compte » → « Supprimer mon compte ». Cette action est irréversible et entraîne la suppression de votre compte d'authentification ainsi que de vos decks, collection, statistiques, pièces, portraits, amis, demandes d'ami et notifications stockés sur nos serveurs. Les données déjà partagées avec d'autres joueurs avant la suppression (par exemple votre pseudo dans une notification déjà reçue par un ami) peuvent subsister chez ces derniers. Si la suppression échoue parce que votre session est trop ancienne, l'application vous demandera de vous reconnecter avant de réessayer.`],
  ['10. Stockage local et cookies',
    `L'application utilise le stockage local de votre navigateur (« localStorage »), et non des cookies publicitaires ou de suivi, pour mémoriser vos préférences (son, volume de musique, tutoriel vu) et, si vous n'êtes pas connecté, votre progression de jeu. Ce stockage reste sur votre appareil et n'est pas transmis à nos serveurs.`],
  ['11. Mineurs',
    `Le Service n'est pas destiné aux enfants de moins de 15 ans sans l'accord d'un titulaire de l'autorité parentale (voir CGU, section 4). Nous ne collectons pas sciemment de données auprès d'enfants ne respectant pas cette condition.`],
  ['12. Modification de cette politique',
    `Nous pouvons mettre à jour cette politique pour refléter une évolution du Service, de nos prestataires ou de la réglementation. La date de dernière mise à jour figure en haut de ce document.`],
  ['13. Contact',
    `Pour toute question relative à vos données personnelles ou pour exercer vos droits : ${LEGAL_CONTACT}.`],
]

function LegalScreen({type,onBack,user,onDeckBuilder,onBooster,onRules,onAccount,onShop,onSocial,unreadCount}){
  const isCgu=type==='cgu'
  const sections=isCgu?CGU_SECTIONS:PRIVACY_SECTIONS
  const title=isCgu?'Conditions Générales d\'Utilisation':'Politique de confidentialité'
  return(
    <div className="relative min-h-screen">
      <div className="bg-charta fixed inset-0" aria-hidden="true"/>
      <div className="relative scrollbar-hide min-h-screen overflow-y-auto py-8 pb-28 px-4 flex flex-col items-center">
        <div className="max-w-lg w-full">
          <BackButton onClick={onBack} className="mb-6">Menu</BackButton>
          <h2 className="text-3xl font-black mb-1" style={{...CINZEL_DEC,background:'linear-gradient(to bottom,#ffe566,#c9a020)',WebkitBackgroundClip:'text',WebkitTextFillColor:'transparent',filter:'drop-shadow(0 1px 10px rgba(0,0,0,1))'}}>{title}</h2>
          <p className="text-slate-400 text-xs mb-5">{LEGAL_APP} · Dernière mise à jour : {LEGAL_LAST_UPDATED}</p>
          {sections.map(([t,d])=>(
            <div key={t} className="rounded-xl p-4 mb-3 border border-amber-900/40" style={{background:'rgba(8,5,2,0.78)'}}>
              <h3 className="text-amber-300 font-bold mb-1.5" style={CINZEL}>{t}</h3>
              {d.split('\n\n').map((para,i)=>(
                <p key={i} className="text-slate-300 text-sm leading-relaxed whitespace-pre-line mb-2 last:mb-0">{para}</p>
              ))}
            </div>
          ))}
        </div>
      </div>
      <BottomNav onDeckBuilder={onDeckBuilder} onBooster={onBooster} onRules={onRules} onAccount={onAccount} onShop={onShop} onSocial={onSocial} unreadCount={unreadCount} user={user}/>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
//  DECK BUILDER SCREEN
// ═══════════════════════════════════════════════════════════════════════════════
function CardEditor({card,onUpdate,onRemove,otherDecks,onMoveCard,onZoom,ownedSkins}){
  const isBooster=!!card.rarity
  const pts=customCardPts(card),over=!isBooster&&pts>CARD_MAX_POINTS
  const rarityTheme=isBooster?RARITY_THEME[card.rarity]:null
  function setVal(key,v){
    const n=Math.max(0,Math.min(9,Number(v)||0))
    onUpdate({values:{...card.values,[key]:n}})
  }
  return(
    <div className={`rounded-xl p-3 border ${over?'border-red-600':'border-amber-900/40'}`} style={{background:'rgba(8,5,2,0.78)'}}>
      <div className="flex gap-4">
        <div onClick={()=>onZoom?.(card)}
          className="w-[150px] h-[150px] shrink-0 rounded-lg border-2 border-amber-800/50 overflow-hidden relative bg-slate-800 cursor-zoom-in">
          <CardImageLayer imageUrl={card.imageUrl||DEFAULT_CARD_IMAGE} className="absolute inset-0 w-full h-full object-cover"/>
          <div className="absolute inset-0 bg-black/25"/>
          <div className="absolute inset-0 grid grid-cols-3 grid-rows-3 gap-0.5 p-1">
            {GRID_KEYS.map((row,ri)=>row.map((key,ci)=>(
              <div key={`${ri}-${ci}`} className="flex items-center justify-center">
                {key&&(isBooster
                  ?<span className="w-9 h-8 flex items-center justify-center text-base bg-black/60 text-white font-bold rounded-md border border-amber-800/40">{card.values[key]}</span>
                  :<input type="number" min={0} max={9} value={card.values[key]}
                    onClick={e=>e.stopPropagation()}
                    onChange={e=>setVal(key,e.target.value)}
                    className="w-9 h-8 text-center text-base bg-black/60 text-white font-bold rounded-md outline-none border border-amber-800/40 focus:ring-2 focus:ring-amber-400" style={{padding:0}}/>)}
              </div>
            )))}
          </div>
        </div>
        <div className="flex-1 flex flex-col gap-2 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`text-sm font-bold ${over?'text-red-400':'text-amber-300'}`}>{pts} / {CARD_MAX_POINTS} pts</span>
            {over&&<span className="text-red-400 text-xs">Trop élevée !</span>}
            {isBooster&&<span className="text-[10px] font-bold px-1.5 py-0.5 rounded" style={{color:rarityTheme.color,background:'rgba(0,0,0,0.4)'}}>{rarityTheme.label}</span>}
          </div>
          {isBooster?(
            <p className="text-slate-500 text-[11px] flex items-center gap-1"><Lock size={11}/> Carte de booster : valeurs et image fixes.</p>
          ):(
            <>
              <span className="text-slate-400 text-[11px]">Image de fond :</span>
              <div className="flex flex-wrap gap-1.5">
                {cardImageGallery(ownedSkins).map(src=>{
                  const selected=card.imageUrl===src
                  return(
                    <button key={src} onClick={()=>onUpdate({imageUrl:src})} title={src.split('/').pop()}
                      className={`w-9 h-9 rounded-md overflow-hidden border-2 transition-all duration-200 hover:scale-110 active:scale-95 shrink-0 ${selected?'border-amber-400':'border-slate-700 hover:border-amber-600'}`}>
                      <CardImageLayer imageUrl={src} className="w-full h-full object-cover"/>
                    </button>
                  )
                })}
              </div>
              <span className="text-slate-500 text-[10px]">D'autres portraits sont en vente dans la Boutique.</span>
            </>
          )}
          <MedBtn onClick={onRemove} color="#ef4444" icon={<Trash2 size={13}/>} className="w-fit mt-auto">Supprimer la carte</MedBtn>
          {otherDecks&&otherDecks.length>0&&(
            <div className="flex flex-wrap items-center gap-1.5 pt-1 border-t border-slate-700/50">
              <span className="text-slate-400 text-[11px] flex items-center gap-1"><ArrowRightLeft size={11}/> Déplacer vers :</span>
              {otherDecks.map(d=>{
                const full=d.cardCount>=DECK_MAX_CARDS
                return(
                  <button key={d.id} onClick={()=>!full&&onMoveCard(d.id)} disabled={full} title={full?`Deck complet (${DECK_MAX_CARDS} max)`:undefined}
                    className={`text-[11px] px-2 py-0.5 rounded-md border transition-all duration-200 ${full?'border-slate-700 text-slate-600 cursor-not-allowed':'border-slate-600 text-slate-300 hover:border-amber-500 hover:text-amber-300 hover:scale-110 active:scale-95'}`}>
                    {d.name}{full?' (plein)':''}
                  </button>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
function DeckEditor({deck,onBack,onRename,onRemoveCard,onUpdateCard,onSetDefault,otherDecks,onMoveCard,ownedSkins,onGoToBooster}){
  const total=deckTotalPts(deck),overTotal=total>DECK_MAX_POINTS,valid=isDeckValid(deck)
  const atMaxCards=deck.cards.length>=DECK_MAX_CARDS
  const[zoomedCard,setZoomedCard]=useState(null)
  return(
    <div className="bg-charta min-h-screen py-8 px-4 flex flex-col items-center overflow-y-auto">
      <CardZoomOverlay card={zoomedCard} onClose={()=>setZoomedCard(null)}/>
      <div className="max-w-lg w-full">
        <BackButton onClick={onBack} className="mb-4">Decks</BackButton>
        <input value={deck.name} onChange={e=>onRename(e.target.value)}
          className="text-2xl font-black bg-transparent border-b border-amber-700/40 text-amber-200 outline-none focus:border-amber-400 mb-2 w-full" style={CINZEL_DEC}/>
        <div className="flex items-center gap-3 mb-4 flex-wrap">
          <span className={`text-sm font-bold ${overTotal?'text-red-400':'text-amber-300'}`}>{total} / {DECK_MAX_POINTS} pts</span>
          <span className={`text-sm font-bold ${atMaxCards?'text-amber-400':'text-slate-400'}`}>{deck.cards.length} / {DECK_MAX_CARDS} cartes</span>
          <MedBtn onClick={onSetDefault} disabled={!valid} color={deck.isDefault?'#fbbf24':'#71717a'}
            icon={<Star size={13} fill={deck.isDefault?'currentColor':'none'}/>}>
            {deck.isDefault?'Deck par défaut':'Définir par défaut'}
          </MedBtn>
          {!valid&&<span className="text-red-400 text-xs">Deck invalide (vérifiez les points)</span>}
        </div>
        <div className="rounded-xl p-3 mb-4 border border-amber-900/40 flex items-start gap-2" style={{background:'rgba(8,5,2,0.78)'}}>
          <span className="text-amber-400 text-base leading-none">↕</span>
          <p className="text-slate-300 text-xs leading-relaxed">
            Les cartes sont conçues orientées <strong className="text-amber-300">vers le bas</strong>, comme si vous étiez le <strong className="text-blue-300">Joueur 1</strong>.
            Si vous jouez en tant que <strong className="text-red-300">Joueur 2</strong>, elles seront automatiquement <strong className="text-amber-300">inversées (rotation 180°)</strong> en partie pour rester tournées vers l'adversaire.
          </p>
        </div>
        <div className="flex flex-col gap-3 mb-4">
          {deck.cards.map(c=>(
            <CardEditor key={c.id} card={c} onUpdate={patch=>onUpdateCard(c.id,patch)} onRemove={()=>onRemoveCard(c.id)}
              otherDecks={otherDecks} onMoveCard={toDeckId=>onMoveCard(c.id,toDeckId)} onZoom={setZoomedCard} ownedSkins={ownedSkins}/>
          ))}
          {deck.cards.length===0&&<p className="text-slate-300 text-sm text-center py-6 drop-shadow-[0_1px_3px_rgba(0,0,0,0.9)]">Aucune carte. Ouvrez un booster pour en obtenir, puis assignez-les ici.</p>}
        </div>
        {!atMaxCards&&(
          <MedBtn onClick={onGoToBooster} color="#34d399" icon={<Gift size={16}/>} className="w-full">
            Ouvrir un booster pour ajouter des cartes
          </MedBtn>
        )}
      </div>
    </div>
  )
}
function DeckBuilderScreen({onBack,user,ownedSkins,coins,onDeckBuilder,onBooster,onRules,onAccount,onShop,onSocial,unreadCount}){
  const[decks,setDecks]=useState(()=>loadDecks())
  const[collection,setCollection]=useState(()=>loadCollection())
  const[deletedCollectionIds,setDeletedCollectionIds]=useState(()=>loadDeletedIds(DELETED_COLLECTION_KEY))
  const[deletedDeckIds,setDeletedDeckIds]=useState(()=>loadDeletedIds(DELETED_DECKS_KEY))
  const[editingId,setEditingId]=useState(null)
  const[showDeckTutorial,setShowDeckTutorial]=useState(()=>!loadDeckTutorialSeen())
  const cloudReadyRef=useRef(false)
  function handleDeckTutorialClose(){saveDeckTutorialSeen();setShowDeckTutorial(false)}
  useEffect(()=>{
    saveDecks(decks)
    if(user&&cloudReadyRef.current)saveCloudDecks(user.uid,decks).catch(()=>{})
  },[decks])
  useEffect(()=>{
    saveCollection(collection)
    if(user&&cloudReadyRef.current)saveCloudCollection(user.uid,collection).catch(()=>{})
  },[collection])
  useEffect(()=>{
    saveDeletedIds(DELETED_COLLECTION_KEY,deletedCollectionIds)
    if(user&&cloudReadyRef.current)saveCloudDeletedIds(user.uid,'deletedCollectionIds',deletedCollectionIds).catch(()=>{})
  },[deletedCollectionIds])
  useEffect(()=>{
    saveDeletedIds(DELETED_DECKS_KEY,deletedDeckIds)
    if(user&&cloudReadyRef.current)saveCloudDeletedIds(user.uid,'deletedDeckIds',deletedDeckIds).catch(()=>{})
  },[deletedDeckIds])
  useEffect(()=>{
    cloudReadyRef.current=false
    if(!user){cloudReadyRef.current=true;return}
    Promise.all([
      loadCloudDecks(user.uid),loadCloudCollection(user.uid),
      loadCloudDeletedIds(user.uid,'deletedDeckIds'),loadCloudDeletedIds(user.uid,'deletedCollectionIds'),
    ]).then(([cloudDecks,cloudCollection,cDeletedDecks,cDeletedCollection])=>{
      // Merge instead of overwrite — decks/cards created on another device (or
      // before ever logging in here) must not be wiped by this device's fetch.
      // Tombstones (ids deleted/sold elsewhere) are unioned too — they only
      // ever grow, so that side of the merge can't lose data.
      const mergedDeletedDecks=Array.from(new Set([...deletedDeckIds,...(cDeletedDecks||[])]))
      const mergedDeletedCollection=Array.from(new Set([...deletedCollectionIds,...(cDeletedCollection||[])]))
      const mergedDecks=mergeById(decks,cloudDecks,mergedDeletedDecks)
      const mergedCollection=mergeById(collection,cloudCollection,mergedDeletedCollection)
      cloudReadyRef.current=true
      setDecks(mergedDecks)
      setCollection(mergedCollection)
      setDeletedDeckIds(mergedDeletedDecks)
      setDeletedCollectionIds(mergedDeletedCollection)
      saveCloudDecks(user.uid,mergedDecks).catch(()=>{})
      saveCloudCollection(user.uid,mergedCollection).catch(()=>{})
      saveCloudDeletedIds(user.uid,'deletedDeckIds',mergedDeletedDecks).catch(()=>{})
      saveCloudDeletedIds(user.uid,'deletedCollectionIds',mergedDeletedCollection).catch(()=>{})
    }).catch(()=>{cloudReadyRef.current=true})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[user?.uid])
  const editing=decks.find(d=>d.id===editingId)

  function createDeck(){
    const d={id:`d-${Date.now()}`,name:`Deck ${decks.length+1}`,cards:[],isDefault:false,updatedAt:Date.now()}
    setDecks(p=>[...p,d]);setEditingId(d.id)
  }
  function deleteDeck(id){
    setDecks(p=>p.filter(d=>d.id!==id))
    setDeletedDeckIds(ids=>ids.includes(id)?ids:[...ids,id])
  }
  function setDefault(id){setDecks(p=>p.map(d=>({...d,isDefault:d.id===id,updatedAt:Date.now()})))}
  function renameDeck(id,name){setDecks(p=>p.map(d=>d.id===id?{...d,name,updatedAt:Date.now()}:d))}
  function removeCard(id,cardId){
    const deck=decks.find(d=>d.id===id);const card=deck?.cards.find(c=>c.id===cardId)
    setDecks(p=>p.map(d=>d.id===id?{...d,cards:d.cards.filter(c=>c.id!==cardId),updatedAt:Date.now()}:d))
    // Booster-sourced cards go back to the collection instead of being lost —
    // un-tombstone the id since it was marked deleted when it left the collection.
    if(card?.rarity){
      setCollection(p=>[...p,card])
      setDeletedCollectionIds(ids=>ids.filter(x=>x!==cardId))
    }
  }
  function updateCard(id,cardId,patch){setDecks(p=>p.map(d=>d.id===id?{...d,cards:d.cards.map(c=>c.id===cardId?{...c,...patch}:c),updatedAt:Date.now()}:d))}
  function moveCardToDeck(fromId,cardId,toId){
    setDecks(p=>{
      const from=p.find(d=>d.id===fromId);const card=from?.cards.find(c=>c.id===cardId)
      const to=p.find(d=>d.id===toId)
      if(!card||!to||to.cards.length>=DECK_MAX_CARDS)return p
      const now=Date.now()
      return p.map(d=>{
        if(d.id===fromId)return{...d,cards:d.cards.filter(c=>c.id!==cardId),updatedAt:now}
        if(d.id===toId)return{...d,cards:[...d.cards,card],updatedAt:now}
        return d
      })
    })
  }

  if(editing)return(
    <DeckEditor deck={editing} onBack={()=>setEditingId(null)} onRename={n=>renameDeck(editing.id,n)}
      onRemoveCard={cid=>removeCard(editing.id,cid)}
      onUpdateCard={(cid,patch)=>updateCard(editing.id,cid,patch)} onSetDefault={()=>setDefault(editing.id)}
      otherDecks={decks.filter(d=>d.id!==editing.id).map(d=>({id:d.id,name:d.name,cardCount:d.cards.length}))}
      onMoveCard={(cardId,toId)=>moveCardToDeck(editing.id,cardId,toId)} ownedSkins={ownedSkins} onGoToBooster={onBooster}/>
  )

  return(
    <div className="bg-charta min-h-screen pt-8 pb-28 px-4 flex flex-col items-center overflow-y-auto">
      {showDeckTutorial&&<TutorialOverlay onClose={handleDeckTutorialClose} steps={DECK_TUTORIAL_STEPS} finalLabel="Compris !"/>}
      <CoinBadge coins={coins} onClick={onShop}/>
      <div className="max-w-lg w-full">
        <BackButton onClick={onBack} className="mb-6">Menu</BackButton>
        <div className="flex items-center gap-2 mb-1">
          <h2 className="text-3xl font-black" style={{...CINZEL_DEC,background:'linear-gradient(to bottom,#ffe566,#c9a020)',WebkitBackgroundClip:'text',WebkitTextFillColor:'transparent',filter:'drop-shadow(0 1px 10px rgba(0,0,0,1))'}}>Deck Builder</h2>
          <button onClick={()=>setShowDeckTutorial(true)} title="Comment ça marche ?"
            className="wood-btn w-7 h-7 shrink-0 rounded-full flex items-center justify-center text-amber-300 font-black text-sm">?</button>
        </div>
        <p className="text-xs mb-5 text-slate-300 drop-shadow-[0_1px_3px_rgba(0,0,0,0.9)]">
          {user?`☁ Connecté (${user.displayName||user.email}) — decks synchronisés dans le cloud.`:'Connectez-vous depuis le menu (Mon Compte) pour synchroniser vos decks dans le cloud.'}
        </p>
        <div className="flex flex-col gap-3 mb-4">
          {decks.map(d=>{
            const total=deckTotalPts(d),valid=isDeckValid(d)
            return(
              <div key={d.id} className="rounded-xl p-4 border border-amber-900/40 flex items-center gap-3" style={{background:'rgba(8,5,2,0.78)'}}>
                <button onClick={()=>setEditingId(d.id)} className="flex-1 text-left min-w-0">
                  <div className="flex items-center gap-2">
                    {d.isDefault&&<Star size={14} className="text-amber-400 shrink-0" fill="currentColor"/>}
                    <span className="text-amber-200 font-bold truncate" style={CINZEL}>{d.name}</span>
                  </div>
                  <span className={`text-xs ${valid?'text-slate-400':'text-red-400'}`}>{d.cards.length} carte(s) · {total}/{DECK_MAX_POINTS} pts{!valid?' · invalide':''}</span>
                </button>
                <MedBtn onClick={()=>setDefault(d.id)} disabled={!valid} title="Définir par défaut"
                  color={d.isDefault?'#fbbf24':'#71717a'} icon={<Star size={16} fill={d.isDefault?'currentColor':'none'}/>} className="!p-2"/>
                <MedBtn onClick={()=>deleteDeck(d.id)} color="#ef4444" icon={<Trash2 size={16}/>} className="!p-2"/>
              </div>
            )
          })}
          {decks.length===0&&<p className="text-slate-300 text-sm text-center py-6 drop-shadow-[0_1px_3px_rgba(0,0,0,0.9)]">Aucun deck. Créez votre premier deck personnalisé.</p>}
        </div>
        <MedBtn onClick={createDeck} color="#34d399" icon={<Plus size={16}/>} className="w-full">Nouveau deck</MedBtn>
        <p className="text-slate-300 text-xs mt-4 text-center drop-shadow-[0_1px_3px_rgba(0,0,0,0.9)]">Max {CARD_MAX_POINTS} pts/carte · Max {DECK_MAX_POINTS} pts/deck · Le deck par défaut est utilisé en partie Locale et Solo vs IA.</p>
      </div>
      <BottomNav onDeckBuilder={onDeckBuilder} onBooster={onBooster} onRules={onRules} onAccount={onAccount} onShop={onShop} onSocial={onSocial} unreadCount={unreadCount} user={user}/>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
//  BOOSTER SCREEN — daily pack opening + card collection
// ═══════════════════════════════════════════════════════════════════════════════
const RARITY_THEME={
  common:   {label:'Commune',     color:'#94a3b8'},
  uncommon: {label:'Peu commune', color:'#34d399'},
  rare:     {label:'Rare',        color:'#60a5fa'},
  ultra:    {label:'Ultra rare',  color:'#c084fc'},
  legendary:{label:'Légendaire',  color:'#fbbf24'},
}
function BoosterCardFace({card,animate=false,revealed=true,size='normal',onClick}){
  const rarity=card.rarity||'common'
  const theme=RARITY_THEME[rarity]
  const isRare=rarity==='rare'||rarity==='ultra'||rarity==='legendary'
  const pts=FACE_KEYS.reduce((s,k)=>s+(card.values[k]||0),0)
  const animClass=animate?(revealed?(isRare?'card-reveal-rare':'card-reveal'):'opacity-0'):(isRare?'rare-glow':'')
  const dim=size==='small'?'w-[68px] h-[68px]':size==='large'?'w-[88vw] h-[88vw] max-w-[420px] max-h-[420px]':'w-[104px] h-[104px]'
  const textSz=size==='small'?'text-[9px]':size==='large'?'text-[30px]':'text-[11px]'
  const labelSz=size==='small'?'text-[7px]':size==='large'?'text-lg':'text-[9px]'
  const zoom=size==='large'
  return(
    <div onClick={onClick} className={`${dim} rounded-xl border-2 relative overflow-hidden shrink-0 ${animClass} ${onClick?'cursor-zoom-in':''}`}
      style={{borderColor:theme.color,background:'#1e293b'}}>
      <CardImageLayer imageUrl={card.imageUrl||DEFAULT_CARD_IMAGE} zoom={zoom} className="absolute inset-0 w-full h-full object-cover"/>
      <div className="absolute inset-0 bg-black/25"/>
      <div className={`absolute inset-0 grid grid-cols-3 grid-rows-3 ${textSz} p-0.5`}>
        {GRID_KEYS.map((row,ri)=>row.map((key,ci)=>(
          <div key={`${ri}-${ci}`} className="flex items-center justify-center">
            {key&&<span className="font-black text-white" style={{textShadow:'0 1px 4px #000,0 0 3px #000'}}>{card.values[key]}</span>}
          </div>
        )))}
      </div>
      <div className={`absolute bottom-0 left-0 right-0 text-center ${labelSz} font-black py-0.5`}
        style={{color:theme.color,background:'rgba(0,0,0,0.55)',textShadow:'0 1px 2px #000'}}>
        {theme.label} · {pts}pts
      </div>
    </div>
  )
}
function CardZoomOverlay({card,onClose,renderCard}){
  if(!card)return null
  // Parallax cards get the slow-tilt variant of the idle float (same keyframes,
  // longer duration) so the inner layers — synced to that exact same duration,
  // see .parallax-*-idle in index.css — stay locked to the card's own motion
  // instead of visibly running on their own separate rhythm.
  const resolvedFile=(card.imageUrl||(card.file?`/images/card/${card.file}`:'')).split('/').pop()
  const idleClass=PARALLAX_SKINS[resolvedFile]?'zoom-card-idle-slow':'zoom-card-idle'
  return(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm" onClick={onClose}>
      <div className="flex flex-col items-center gap-3 select-none">
        <div className="relative flex items-center justify-center zoom-card-perspective">
          <div className="absolute inset-0 m-auto zoom-aura rounded-full pointer-events-none" style={{width:'135%',height:'135%'}}/>
          <div className={idleClass}>
            {renderCard?renderCard(card):<BoosterCardFace card={card} size='large'/>}
          </div>
        </div>
        <span className="text-slate-400 text-xs">Appuyer pour fermer</span>
      </div>
    </div>
  )
}
function formatDuration(ms){
  const h=Math.floor(ms/3600000),m=Math.floor((ms%3600000)/60000),s=Math.floor((ms%60000)/1000)
  return `${h}h ${String(m).padStart(2,'0')}m ${String(s).padStart(2,'0')}s`
}
// Union by id (newest-edited side wins on a collision) — keeps cards/decks pulled
// on ANY device instead of one device's data silently replacing the other's on
// login. `deletedIds` is a tombstone set: a plain union can't represent "this was
// deliberately removed" (a sold/deleted item just looks like something the OTHER
// side hasn't seen yet), so without it a device that still has the item cached
// locally resurrects it on every login — which is exactly how a sold booster card
// could reappear on another browser.
function mergeById(localList,cloudList,deletedIds){
  const deleted=new Set(deletedIds||[])
  const map=new Map()
  ;(cloudList||[]).forEach(item=>{if(!deleted.has(item.id))map.set(item.id,item)})
  ;(localList||[]).forEach(item=>{
    if(deleted.has(item.id))return
    const existing=map.get(item.id)
    if(!existing||(item.updatedAt||0)>(existing.updatedAt||0))map.set(item.id,item)
  })
  return Array.from(map.values())
}
function BoosterScreen({onBack,user,ownedSkins,coins,onEarnCoins,onSellCard,onSpendCoins,soundEnabled,onDeckBuilder,onBooster,onRules,onAccount,onShop,onSocial,unreadCount}){
  const[collection,setCollection]=useState(()=>loadCollection())
  const[decks,setDecks]=useState(()=>loadDecks())
  const[deletedCollectionIds,setDeletedCollectionIds]=useState(()=>loadDeletedIds(DELETED_COLLECTION_KEY))
  const[deletedDeckIds,setDeletedDeckIds]=useState(()=>loadDeletedIds(DELETED_DECKS_KEY))
  const[lastBoosterAt,setLastBoosterAt]=useState(()=>loadLastBoosterAt())
  const[opening,setOpening]=useState(false)
  const[pendingCards,setPendingCards]=useState(null)
  const[revealCount,setRevealCount]=useState(0)
  const[coinToast,setCoinToast]=useState(null)
  const[,setNow]=useState(()=>Date.now())
  const[zoomedCard,setZoomedCard]=useState(null)
  // Until the cloud fetch resolves, lastBoosterAt only reflects THIS device's local
  // record — briefly showing the booster as openable even if it was already opened
  // elsewhere today. Gate canOpen on this so the button can't flash active.
  const[cloudReady,setCloudReady]=useState(!user)
  const timersRef=useRef([])
  const cloudReadyRef=useRef(false)

  useEffect(()=>{
    saveCollection(collection)
    if(user&&cloudReadyRef.current)saveCloudCollection(user.uid,collection).catch(()=>{})
  },[collection])
  useEffect(()=>{
    saveDecks(decks)
    if(user&&cloudReadyRef.current)saveCloudDecks(user.uid,decks).catch(()=>{})
  },[decks])
  useEffect(()=>{
    saveDeletedIds(DELETED_COLLECTION_KEY,deletedCollectionIds)
    if(user&&cloudReadyRef.current)saveCloudDeletedIds(user.uid,'deletedCollectionIds',deletedCollectionIds).catch(()=>{})
  },[deletedCollectionIds])
  useEffect(()=>{
    saveDeletedIds(DELETED_DECKS_KEY,deletedDeckIds)
    if(user&&cloudReadyRef.current)saveCloudDeletedIds(user.uid,'deletedDeckIds',deletedDeckIds).catch(()=>{})
  },[deletedDeckIds])
  useEffect(()=>{
    cloudReadyRef.current=false
    setCloudReady(false)
    if(!user){cloudReadyRef.current=true;setCloudReady(true);return}
    Promise.all([
      loadCloudCollection(user.uid),loadCloudDecks(user.uid),loadCloudLastBooster(user.uid),
      loadCloudDeletedIds(user.uid,'deletedCollectionIds'),loadCloudDeletedIds(user.uid,'deletedDeckIds'),
    ]).then(([cCollection,cDecks,cLast,cDeletedCollection,cDeletedDecks])=>{
      // Merge instead of overwrite — a device that pulled boosters offline (or
      // before ever logging in) must not have its cards wiped by another
      // device's cloud state; both converge to the union of both. Tombstones
      // (ids sold/deleted elsewhere) are unioned too — they only ever grow, so
      // that side of the merge can't lose data.
      const mergedDeletedCollection=Array.from(new Set([...deletedCollectionIds,...(cDeletedCollection||[])]))
      const mergedDeletedDecks=Array.from(new Set([...deletedDeckIds,...(cDeletedDecks||[])]))
      const mergedCollection=mergeById(collection,cCollection,mergedDeletedCollection)
      const mergedDecks=mergeById(decks,cDecks,mergedDeletedDecks)
      cloudReadyRef.current=true
      setCollection(mergedCollection)
      setDecks(mergedDecks)
      setDeletedCollectionIds(mergedDeletedCollection)
      setDeletedDeckIds(mergedDeletedDecks)
      saveCloudCollection(user.uid,mergedCollection).catch(()=>{})
      saveCloudDecks(user.uid,mergedDecks).catch(()=>{})
      saveCloudDeletedIds(user.uid,'deletedCollectionIds',mergedDeletedCollection).catch(()=>{})
      saveCloudDeletedIds(user.uid,'deletedDeckIds',mergedDeletedDecks).catch(()=>{})
      if(cLast)setLastBoosterAt(prev=>Math.max(prev,cLast))
      setCloudReady(true)
    }).catch(()=>{cloudReadyRef.current=true;setCloudReady(true)})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[user?.uid])
  useEffect(()=>{
    const t=setInterval(()=>setNow(Date.now()),1000)
    return()=>clearInterval(t)
  },[])
  useEffect(()=>()=>{timersRef.current.forEach(clearTimeout)},[])

  const remainingMs=msUntilNextBooster(lastBoosterAt)
  const canOpen=cloudReady&&remainingMs<=0&&!opening&&!pendingCards
  const allRevealed=pendingCards&&revealCount>=pendingCards.length
  const displayCollection=pendingCards?collection.filter(c=>!pendingCards.some(p=>p.id===c.id)):collection

  function handleOpenBooster(paid=false){
    if(paid){
      // A bought booster is extra — it doesn't touch the free daily slot, so it
      // can't be used to either skip or double up on today's free one.
      if(opening||pendingCards)return
      if(!onSpendCoins(BOOSTER_PURCHASE_PRICE))return
    }else if(!canOpen)return
    setOpening(true)
    timersRef.current.push(setTimeout(()=>{
      const cards=openBoosterPack(ownedSkins)
      setPendingCards(cards)
      setCollection(c=>[...c,...cards]) // persist immediately — nothing lost if the user navigates away mid-reveal
      setOpening(false)
      setRevealCount(0)
      cards.forEach((_,i)=>{
        timersRef.current.push(setTimeout(()=>setRevealCount(n=>Math.max(n,i+1)),i*650))
      })
      if(!paid){
        const ts=Date.now()
        setLastBoosterAt(ts);saveLastBoosterAt(ts)
        if(user)saveCloudLastBooster(user.uid,ts).catch(()=>{})
      }
      const reward=rnd(BOOSTER_COIN_MIN,BOOSTER_COIN_MAX)
      onEarnCoins(reward)
      setCoinToast(reward)
      timersRef.current.push(setTimeout(()=>setCoinToast(null),2500))
    },900))
  }
  function handleCloseReveal(){setPendingCards(null);setRevealCount(0)}
  function handleAssignToDeck(cardId,deckId){
    const card=collection.find(c=>c.id===cardId);if(!card)return
    const deck=decks.find(d=>d.id===deckId);if(!deck||deck.cards.length>=DECK_MAX_CARDS)return
    setCollection(c=>c.filter(x=>x.id!==cardId))
    setDeletedCollectionIds(ids=>ids.includes(cardId)?ids:[...ids,cardId])
    setDecks(ds=>ds.map(d=>d.id===deckId?{...d,cards:[...d.cards,card],updatedAt:Date.now()}:d))
  }
  function handleSellCard(cardId){
    const card=collection.find(c=>c.id===cardId);if(!card)return
    setCollection(c=>c.filter(x=>x.id!==cardId))
    setDeletedCollectionIds(ids=>ids.includes(cardId)?ids:[...ids,cardId])
    onSellCard(card.rarity)
    snd('coin',soundEnabled)
  }

  if(!user)return(
    <div className="bg-charta min-h-screen flex flex-col items-center justify-center gap-5 px-4">
      <div className="text-6xl select-none">🔒</div>
      <p className="text-amber-300 font-bold text-xl text-center drop-shadow-[0_1px_4px_rgba(0,0,0,0.9)]" style={CINZEL}>Connexion requise</p>
      <p className="text-slate-300 text-sm text-center max-w-xs drop-shadow-[0_1px_3px_rgba(0,0,0,0.9)]">Connectez-vous pour accéder aux boosters de cartes quotidiens et sauvegarder votre collection.</p>
      <BackButton onClick={onBack}>Menu</BackButton>
    </div>
  )

  return(
    <div className="min-h-screen relative">
      {/* Background is a fixed, viewport-sized layer — kept separate from the
          scrollable content below so "cover" sizing never stretches against
          the content's (potentially much taller) scroll height. */}
      <div className="bg-charta fixed inset-0 -z-10"/>
      <div className="min-h-screen pt-14 pb-28 px-4 flex flex-col items-center overflow-y-auto">
      {/* Fixed back button */}
      <BackButton onClick={onBack} compact className="fixed top-3 left-3 z-20">Menu</BackButton>
      <CoinBadge coins={coins} onClick={onShop}/>

      <CardZoomOverlay card={zoomedCard} onClose={()=>setZoomedCard(null)}/>

      <div className="max-w-lg w-full">
        <h2 className="text-3xl font-black mb-1" style={{...CINZEL_DEC,background:'linear-gradient(to bottom,#ffe566,#c9a020)',WebkitBackgroundClip:'text',WebkitTextFillColor:'transparent',filter:'drop-shadow(0 1px 10px rgba(0,0,0,1))'}}>Booster de Cartes</h2>
        <p className="text-xs mb-5 text-slate-300 drop-shadow-[0_1px_3px_rgba(0,0,0,0.9)]">
          Un booster gratuit de 4 cartes chaque jour, ou un booster supplémentaire à tout moment pour {BOOSTER_PURCHASE_PRICE} pièces. Très rarement (&lt;1%), une carte peut dépasser les {CARD_MAX_POINTS} pts habituels !
        </p>

        <div className="rounded-xl p-6 mb-6 border border-amber-900/40 flex flex-col items-center gap-4 min-h-[220px] justify-center" style={{background:'rgba(8,5,2,0.78)'}}>
          {!pendingCards&&(
            <>
              <button onClick={()=>handleOpenBooster(false)} disabled={!canOpen}
                className={`relative w-28 h-36 rounded-2xl border-4 flex items-center justify-center transition-transform ${
                  opening?'border-amber-400 booster-pack-opening'
                    :canOpen?'border-amber-400 booster-pack-idle cursor-pointer hover:scale-105'
                    :'border-slate-700 opacity-50 cursor-not-allowed'}`}
                style={{background:'linear-gradient(135deg,#3b0764,#1e1b4b)'}}>
                <Gift size={44} className={canOpen||opening?'text-amber-300':'text-slate-500'}/>
              </button>
              {!cloudReady
                ?<p className="text-slate-400 text-sm">Vérification…</p>
                :canOpen
                  ?<p className="text-amber-300 font-bold" style={CINZEL}>Ouvrir le booster du jour</p>
                  :<p className="text-slate-400 text-sm">Prochain booster dans {formatDuration(remainingMs)}</p>}
              <MedBtn onClick={()=>handleOpenBooster(true)} disabled={opening||coins<BOOSTER_PURCHASE_PRICE}
                color="#f59e0b" icon={<Coins size={14}/>}>
                Acheter un booster ({BOOSTER_PURCHASE_PRICE})
              </MedBtn>
            </>
          )}
          {pendingCards&&(
            <>
              <div className="flex gap-3 flex-wrap justify-center">
                {pendingCards.map((c,i)=>(
                  <BoosterCardFace key={c.id} card={c} animate revealed={i<revealCount} onClick={i<revealCount?()=>setZoomedCard(c):undefined}/>
                ))}
              </div>
              {allRevealed&&<MedBtn onClick={handleCloseReveal} color="#34d399" icon={<Sparkles size={14}/>}>Continuer</MedBtn>}
            </>
          )}
          {/* Rendered outside both branches above — the reward is set at the same time as
              pendingCards, so nesting this inside the `!pendingCards` block hid it for the
              entire reveal (it used to expire before the user ever got back to that view). */}
          {coinToast&&(
            <p className="text-amber-300 text-sm font-bold flex items-center gap-1.5 menu-fade-up" style={CINZEL}>
              <Coins size={14}/> +{coinToast} pièces
            </p>
          )}
        </div>

        <h3 className="text-amber-300 font-bold mb-3" style={CINZEL}>Ma Collection ({displayCollection.length})</h3>
        {displayCollection.length===0
          ?<p className="text-slate-300 text-sm text-center py-6 drop-shadow-[0_1px_3px_rgba(0,0,0,0.9)]">Aucune carte en attente. Ouvrez un booster pour en obtenir !</p>
          :(
            <div className="flex flex-col gap-2">
              {displayCollection.map(c=>(
                <div key={c.id} className="rounded-xl p-2.5 border border-amber-900/40 flex gap-3 items-center" style={{background:'rgba(8,5,2,0.78)'}}>
                  <div className="shrink-0 transition-transform duration-150 hover:scale-110 active:scale-110"
                    onClick={()=>setZoomedCard(c)}>
                    <BoosterCardFace card={c} size='small' onClick={()=>setZoomedCard(c)}/>
                  </div>
                  <div className="flex-1 min-w-0 flex flex-col gap-1.5 justify-center">
                    {decks.length>0?(
                      <>
                        <span className="text-slate-400 text-[11px]">Ajouter à un deck :</span>
                        <div className="flex flex-wrap gap-1.5">
                          {decks.map(d=>{
                            const full=d.cards.length>=DECK_MAX_CARDS
                            return(
                              <button key={d.id} onClick={()=>!full&&handleAssignToDeck(c.id,d.id)} disabled={full} title={full?`Deck complet (${DECK_MAX_CARDS} max)`:undefined}
                                className={`text-[11px] px-2 py-0.5 rounded-md border transition-colors ${full?'border-slate-700 text-slate-600 cursor-not-allowed':'border-slate-600 text-slate-300 hover:border-emerald-500 hover:text-emerald-300'}`}>
                                {d.name}{full?' (plein)':''}
                              </button>
                            )
                          })}
                        </div>
                      </>
                    ):<span className="text-slate-500 text-xs">Créez un deck dans le Deck Builder pour y ajouter cette carte.</span>}
                  </div>
                  <MedBtn onClick={()=>handleSellCard(c.id)} title={`Vendre pour ${SELL_VALUE[c.rarity]||0} pièces`} color="#f59e0b" icon={<Coins size={14}/>} className="!px-2.5 !py-2 shrink-0">
                    {SELL_VALUE[c.rarity]||0}
                  </MedBtn>
                </div>
              ))}
            </div>
          )}
      </div>
      <BottomNav onDeckBuilder={onDeckBuilder} onBooster={onBooster} onRules={onRules} onAccount={onAccount} onShop={onShop} onSocial={onSocial} unreadCount={unreadCount} user={user}/>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
//  SHOP SCREEN — spend coins on cosmetic card skins
// ═══════════════════════════════════════════════════════════════════════════════
function ShopScreen({onBack,coins,ownedSkins,onBuySkin,onDeckBuilder,onBooster,onRules,onAccount,onSocial,unreadCount,user}){
  const[zoomedSkin,setZoomedSkin]=useState(null)
  return(
    <div className="min-h-screen relative">
      <div className="bg-charta fixed inset-0 -z-10"/>
      <div className="min-h-screen pt-14 pb-28 px-4 flex flex-col items-center overflow-y-auto">
        <BackButton onClick={onBack} compact className="fixed top-3 left-3 z-20">Menu</BackButton>
        <CoinBadge coins={coins}/>
        <CardZoomOverlay card={zoomedSkin} onClose={()=>setZoomedSkin(null)} renderCard={s=>(
          <div className="w-[88vw] h-[88vw] max-w-[420px] max-h-[420px] rounded-2xl overflow-hidden border-4 relative"
            style={{borderColor:ownedSkins.includes(s.id)?'#34d399':'#8b6239'}}>
            <CardImageLayer imageUrl={`/images/card/${s.file}`} zoom className="absolute inset-0 w-full h-full object-cover"/>
            <div className="absolute bottom-0 inset-x-0 text-center py-3" style={{background:'rgba(0,0,0,0.65)'}}>
              <span className="text-amber-200 font-black text-xl" style={CINZEL_DEC}>{s.name}</span>
            </div>
          </div>
        )}/>

        <div className="max-w-lg w-full">
          <h2 className="text-3xl font-black mb-1" style={{...CINZEL_DEC,background:'linear-gradient(to bottom,#ffe566,#c9a020)',WebkitBackgroundClip:'text',WebkitTextFillColor:'transparent',filter:'drop-shadow(0 1px 10px rgba(0,0,0,1))'}}>Boutique</h2>
          <p className="text-xs mb-5 text-slate-300 drop-shadow-[0_1px_3px_rgba(0,0,0,0.9)]">
            Achetez des portraits exclusifs avec les pièces gagnées en ouvrant des boosters ou en vendant des cartes. Une fois possédé, un portrait est utilisable dans le Deck Builder et peut apparaître sur vos cartes générées aléatoirement.
          </p>

          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {SKIN_CATALOG.map(skin=>{
              const owned=ownedSkins.includes(skin.id)
              const afford=coins>=skin.price
              return(
                <div key={skin.id} className="rounded-xl p-3 border border-amber-900/40 flex flex-col items-center gap-2" style={{background:'rgba(8,5,2,0.78)'}}>
                  <div onClick={()=>setZoomedSkin(skin)}
                    className="w-20 h-20 rounded-lg overflow-hidden border-2 border-amber-800/50 relative cursor-zoom-in transition-transform hover:scale-105">
                    <CardImageLayer imageUrl={`/images/card/${skin.file}`} className={`w-full h-full object-cover ${owned?'':'opacity-60'}`}/>
                    {!owned&&<div className="absolute inset-0 flex items-center justify-center bg-black/30"><Lock size={20} className="text-slate-300"/></div>}
                  </div>
                  <span className="text-amber-200 font-bold text-sm text-center" style={CINZEL}>{skin.name}</span>
                  {owned
                    ?<span className="text-emerald-400 text-xs font-bold flex items-center gap-1"><Check size={12}/> Possédé</span>
                    :<MedBtn onClick={()=>onBuySkin(skin.id,skin.price)} disabled={!afford} color="#f59e0b" icon={<Coins size={13}/>}>{skin.price}</MedBtn>
                  }
                </div>
              )
            })}
          </div>
        </div>
        <BottomNav onDeckBuilder={onDeckBuilder} onBooster={onBooster} onRules={onRules} onAccount={onAccount} onShop={()=>{}} onSocial={onSocial} unreadCount={unreadCount} user={user}/>
      </div>
    </div>
  )
}

const DECKSELECT_SUBTITLE={
  ai:"Vous affronterez l'IA avec ce deck (l'IA joue avec un deck aléatoire).",
  local:'Ce deck sera utilisé par les deux joueurs de cette partie locale.',
  online:'Deck utilisé pour la partie que vous hébergez.',
}
function DeckSelectScreen({mode,onBack,onSelect}){
  const[decks]=useState(()=>loadDecks().filter(isDeckValid))
  return(
    <div className="bg-charta min-h-screen py-8 px-4 flex flex-col items-center overflow-y-auto">
      <div className="max-w-lg w-full">
        <BackButton onClick={onBack} className="mb-6">Menu</BackButton>
        <h2 className="text-3xl font-black mb-2" style={{...CINZEL_DEC,background:'linear-gradient(to bottom,#ffe566,#c9a020)',WebkitBackgroundClip:'text',WebkitTextFillColor:'transparent',filter:'drop-shadow(0 1px 10px rgba(0,0,0,1))'}}>Choisissez votre deck</h2>
        {DECKSELECT_SUBTITLE[mode]&&<p className="text-slate-300 text-sm mb-5 drop-shadow-[0_1px_3px_rgba(0,0,0,0.9)]">{DECKSELECT_SUBTITLE[mode]}</p>}
        <div className="flex flex-col gap-3">
          <button onClick={()=>onSelect(null)} className="rounded-xl p-4 border border-amber-900/40 text-left transition-all duration-200 hover:border-amber-500 hover:-translate-y-0.5 hover:scale-[1.015] active:scale-[0.99]" style={{background:'rgba(8,5,2,0.78)'}}>
            <span className="text-amber-200 font-bold" style={CINZEL}>Deck aléatoire</span>
            <p className="text-slate-400 text-xs mt-0.5">6 cartes générées aléatoirement (2 faibles, 2 moyennes, 2 fortes)</p>
          </button>
          {decks.map(d=>{
            const total=deckTotalPts(d)
            return(
              <button key={d.id} onClick={()=>onSelect(d)} className="rounded-xl p-4 border border-amber-900/40 text-left transition-all duration-200 hover:border-amber-500 hover:-translate-y-0.5 hover:scale-[1.015] active:scale-[0.99] flex items-center gap-2" style={{background:'rgba(8,5,2,0.78)'}}>
                {d.isDefault&&<Star size={14} className="text-amber-400 shrink-0" fill="currentColor"/>}
                <div className="min-w-0">
                  <span className="text-amber-200 font-bold truncate block" style={CINZEL}>{d.name}</span>
                  <span className="text-slate-400 text-xs">{d.cards.length} carte(s) · {total}/{DECK_MAX_POINTS} pts</span>
                </div>
              </button>
            )
          })}
          {decks.length===0&&<p className="text-slate-300 text-sm text-center py-6 drop-shadow-[0_1px_3px_rgba(0,0,0,0.9)]">Aucun deck valide. Créez-en un dans le Deck Builder, ou jouez avec un deck aléatoire.</p>}
        </div>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
//  ACCOUNT SCREEN — email/password + Google auth, stats, cache reset
// ═══════════════════════════════════════════════════════════════════════════════
function AccountScreen({onBack,user,stats,onProfileUpdated,onLegal,onDeleteAccount,onReauthenticate,onDeckBuilder,onBooster,onRules,onAccount,onShop,onSocial,unreadCount}){
  const[authMode,setAuthMode]=useState('login') // 'login'|'register'
  const[email,setEmail]=useState('');const[password,setPassword]=useState('')
  const[error,setError]=useState('');const[loading,setLoading]=useState(false)
  const[consent,setConsent]=useState(false)
  const[pseudo,setPseudo]=useState('')
  const[pseudoSaving,setPseudoSaving]=useState(false)
  const[pseudoSaved,setPseudoSaved]=useState(false)
  const[pseudoError,setPseudoError]=useState('')
  const[confirmDelete,setConfirmDelete]=useState(false)
  const[deleting,setDeleting]=useState(false)
  const[deleteError,setDeleteError]=useState('')
  const[needsReauth,setNeedsReauth]=useState(false)
  const[reauthPassword,setReauthPassword]=useState('')
  const isGoogleAccount=user?.providerId==='google.com'

  // Pre-fill with the current pseudo, defaulting to the email prefix if none is set yet
  useEffect(()=>{
    if(user)setPseudo(user.displayName||user.email?.split('@')[0]||'')
  },[user?.uid,user?.displayName])

  async function handleEmailSubmit(e){
    e.preventDefault()
    if(authMode==='register'&&!consent){setError('Merci d\'accepter les CGU et la politique de confidentialité pour créer un compte.');return}
    setError('');setLoading(true)
    try{authMode==='register'?await registerWithEmail(email,password):await loginWithEmail(email,password)}
    catch(err){setError(err.message)}
    setLoading(false)
  }
  async function handleGoogle(){
    if(authMode==='register'&&!consent){setError('Merci d\'accepter les CGU et la politique de confidentialité pour créer un compte.');return}
    setError('');setLoading(true)
    try{await loginWithGoogle()}catch(err){setError(err.message)}
    setLoading(false)
  }
  async function handleDeleteAccount(){
    setDeleting(true);setDeleteError('')
    try{await onDeleteAccount();setDeleting(false)}
    catch(e){
      if(e?.code==='auth/requires-recent-login'){setNeedsReauth(true);setDeleting(false)}
      else{setDeleteError(e.message);setDeleting(false);setConfirmDelete(false)}
    }
  }
  async function handleReauthAndDelete(){
    setDeleting(true);setDeleteError('')
    try{
      await onReauthenticate(reauthPassword)
      setNeedsReauth(false);setReauthPassword('')
      await onDeleteAccount()
    }catch(e){setDeleteError(e.message)}
    setDeleting(false)
  }
  async function handleSavePseudo(){
    const trimmed=pseudo.trim();if(!trimmed)return
    setPseudoSaving(true);setPseudoError('');setPseudoSaved(false)
    try{
      await claimUsername(user.uid,trimmed) // throws if already taken by someone else
      await updateDisplayName(trimmed)
      onProfileUpdated?.()
      setPseudoSaved(true);setTimeout(()=>setPseudoSaved(false),2000)
    }catch(e){setPseudoError(e.message)}
    setPseudoSaving(false)
  }
  const total=stats?.gamesPlayed||0
  return(
    <div className="bg-charta min-h-screen py-8 pb-28 px-4 flex flex-col items-center overflow-y-auto">
      <div className="max-w-sm w-full">
        <BackButton onClick={onBack} className="mb-6">Menu</BackButton>
        <h2 className="text-3xl font-black mb-5" style={{...CINZEL_DEC,background:'linear-gradient(to bottom,#ffe566,#c9a020)',WebkitBackgroundClip:'text',WebkitTextFillColor:'transparent',filter:'drop-shadow(0 1px 10px rgba(0,0,0,1))'}}>Mon Compte</h2>

        {user?(
          <div className="rounded-xl p-4 mb-4 border border-amber-900/40" style={{background:'rgba(8,5,2,0.78)'}}>
            <div className="flex items-center gap-2 mb-4">
              <UserCircle size={22} className="text-amber-400 shrink-0"/>
              <span className="text-amber-200 font-bold truncate" style={CINZEL}>{user.displayName||user.email}</span>
            </div>
            <label className="text-slate-400 text-[11px] mb-1 block">Pseudo (affiché en partie)</label>
            <div className="flex gap-2 mb-1">
              <input value={pseudo} onChange={e=>setPseudo(e.target.value)} maxLength={24} placeholder="Pseudo"
                className="flex-1 min-w-0 bg-slate-800 text-slate-200 text-sm border border-slate-700 rounded-lg px-3 py-2 outline-none focus:border-amber-500"/>
              <MedBtn onClick={handleSavePseudo} disabled={pseudoSaving||!pseudo.trim()||pseudo.trim()===(user.displayName||'')}
                color={pseudoSaved?'#34d399':'#c9a020'} icon={<Check size={14}/>} className="shrink-0">
                {pseudoSaving?'…':pseudoSaved?'Enregistré':'Valider'}
              </MedBtn>
            </div>
            {pseudoError&&<p className="text-red-400 text-xs mb-3">{pseudoError}</p>}
            <div className="grid grid-cols-3 gap-2 text-center mb-4 mt-3">
              <div><div className="text-xl font-black text-amber-300">{total}</div><div className="text-[10px] text-slate-400 uppercase tracking-wide">Parties</div></div>
              <div><div className="text-xl font-black text-emerald-400">{stats?.wins||0}</div><div className="text-[10px] text-slate-400 uppercase tracking-wide">Victoires</div></div>
              <div><div className="text-xl font-black text-red-400">{stats?.losses||0}</div><div className="text-[10px] text-slate-400 uppercase tracking-wide">Défaites</div></div>
            </div>
            <MedBtn onClick={()=>logout()} color="#ef4444" icon={<LogOut size={14}/>} className="w-full">Se déconnecter</MedBtn>
          </div>
        ):null}
        {user&&(
          <div className="rounded-xl p-4 mb-4 border border-red-900/40" style={{background:'rgba(20,4,4,0.6)'}}>
            <h3 className="text-red-400 font-bold mb-1 text-sm" style={CINZEL}>Zone dangereuse</h3>
            <p className="text-slate-400 text-xs mb-3">Supprime définitivement votre compte, vos decks, votre collection, vos pièces, vos amis et vos statistiques. Cette action est irréversible.</p>
            {deleteError&&<p className="text-red-400 text-xs mb-3">{deleteError}</p>}
            {needsReauth?(
              <div className="flex flex-col gap-2">
                <p className="text-amber-300 text-xs">Reconnexion requise pour confirmer une action aussi sensible.</p>
                {isGoogleAccount?(
                  <MedBtn onClick={handleReauthAndDelete} disabled={deleting} color="#ef4444" icon={<Trash2 size={14}/>} className="w-full justify-center">
                    {deleting?'Suppression…':'Se reconnecter avec Google et supprimer'}
                  </MedBtn>
                ):(
                  <>
                    <label className="flex items-center gap-2 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 focus-within:border-red-500">
                      <Lock size={14} className="text-slate-500 shrink-0"/>
                      <input type="password" autoComplete="current-password" value={reauthPassword} onChange={e=>setReauthPassword(e.target.value)} placeholder="Mot de passe" className="bg-transparent text-slate-200 text-sm outline-none flex-1 min-w-0"/>
                    </label>
                    <MedBtn onClick={handleReauthAndDelete} disabled={deleting||!reauthPassword} color="#ef4444" icon={<Trash2 size={14}/>} className="w-full justify-center">
                      {deleting?'Suppression…':'Confirmer et supprimer'}
                    </MedBtn>
                  </>
                )}
                <MedBtn onClick={()=>{setNeedsReauth(false);setConfirmDelete(false);setReauthPassword('')}} disabled={deleting} color="#a89484" className="w-full justify-center">Annuler</MedBtn>
              </div>
            ):confirmDelete?(
              <div className="flex gap-2">
                <MedBtn onClick={handleDeleteAccount} disabled={deleting} color="#ef4444" icon={<Trash2 size={14}/>} className="flex-1 justify-center">
                  {deleting?'Suppression…':'Confirmer la suppression'}
                </MedBtn>
                <MedBtn onClick={()=>setConfirmDelete(false)} disabled={deleting} color="#a89484" className="flex-1 justify-center">Annuler</MedBtn>
              </div>
            ):(
              <MedBtn onClick={()=>setConfirmDelete(true)} color="#ef4444" icon={<Trash2 size={14}/>} className="w-full">Supprimer mon compte</MedBtn>
            )}
          </div>
        )}
        {!user&&(
          <div className="rounded-xl p-4 mb-4 border border-amber-900/40" style={{background:'rgba(8,5,2,0.78)'}}>
            <div className="flex gap-2 mb-3">
              <button type="button" onClick={()=>setAuthMode('login')}
                className={`flex-1 text-xs font-bold py-1.5 rounded-lg transition-all duration-200 hover:scale-105 active:scale-95 ${authMode==='login'?'bg-amber-600/30 text-amber-300':'text-slate-400 hover:text-white'}`} style={CINZEL}>Connexion</button>
              <button type="button" onClick={()=>setAuthMode('register')}
                className={`flex-1 text-xs font-bold py-1.5 rounded-lg transition-all duration-200 hover:scale-105 active:scale-95 ${authMode==='register'?'bg-amber-600/30 text-amber-300':'text-slate-400 hover:text-white'}`} style={CINZEL}>Créer un compte</button>
            </div>
            <form onSubmit={handleEmailSubmit} className="flex flex-col gap-2 mb-3">
              <label className="flex items-center gap-2 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 focus-within:border-amber-500">
                <Mail size={14} className="text-slate-500 shrink-0"/>
                <input type="email" required autoComplete="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="Email" className="bg-transparent text-slate-200 text-sm outline-none flex-1 min-w-0"/>
              </label>
              <label className="flex items-center gap-2 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 focus-within:border-amber-500">
                <Lock size={14} className="text-slate-500 shrink-0"/>
                {/* Only register enforces the stronger 8-char minimum client-side — existing
                    accounts may have a shorter (still valid) password and must still be able
                    to log in, so login keeps Firebase's own 6-char floor. */}
                <input type="password" required minLength={authMode==='register'?8:6} autoComplete={authMode==='register'?'new-password':'current-password'} value={password} onChange={e=>setPassword(e.target.value)} placeholder="Mot de passe" className="bg-transparent text-slate-200 text-sm outline-none flex-1 min-w-0"/>
              </label>
              {authMode==='register'&&(
                <label className="flex items-start gap-2 text-slate-400 text-[11px] leading-snug cursor-pointer select-none">
                  <input type="checkbox" checked={consent} onChange={e=>setConsent(e.target.checked)} className="mt-0.5 shrink-0"/>
                  <span>
                    J'accepte les <button type="button" onClick={()=>onLegal('cgu')} className="text-amber-400 underline underline-offset-2">CGU</button> et la <button type="button" onClick={()=>onLegal('privacy')} className="text-amber-400 underline underline-offset-2">politique de confidentialité</button>.
                  </span>
                </label>
              )}
              {error&&<p className="text-red-400 text-xs">{error}</p>}
              <MedBtn color="#60a5fa" icon={<LogIn size={14}/>} className="w-full" disabled={loading||(authMode==='register'&&!consent)}>
                {authMode==='register'?'Créer mon compte':'Se connecter'}
              </MedBtn>
            </form>
            <div className="flex items-center gap-2 my-3"><div className="flex-1 h-px bg-slate-700"/><span className="text-slate-500 text-[10px] uppercase">ou</span><div className="flex-1 h-px bg-slate-700"/></div>
            <MedBtn onClick={handleGoogle} disabled={loading||(authMode==='register'&&!consent)} color="#e5e7eb" icon={<span className="text-sm font-black">G</span>} className="w-full">Continuer avec Google</MedBtn>
          </div>
        )}

        <div className="rounded-xl p-4 mb-4 border border-amber-900/40" style={{background:'rgba(8,5,2,0.78)'}}>
          <h3 className="text-amber-300 font-bold mb-1 text-sm" style={CINZEL}>Légal</h3>
          <div className="flex gap-2">
            <MedBtn onClick={()=>onLegal('cgu')} color="#a89484" className="flex-1 justify-center">CGU</MedBtn>
            <MedBtn onClick={()=>onLegal('privacy')} color="#a89484" className="flex-1 justify-center">Confidentialité</MedBtn>
          </div>
        </div>

        <div className="rounded-xl p-4 border border-amber-900/40" style={{background:'rgba(8,5,2,0.78)'}}>
          <h3 className="text-amber-300 font-bold mb-1 text-sm" style={CINZEL}>Application</h3>
          <p className="text-slate-400 text-xs mb-3">En cas d'affichage figé après une mise à jour du jeu, videz le cache pour forcer le rechargement de la dernière version.</p>
          <MedBtn onClick={forceClearCacheAndReload} color="#fbbf24" icon={<RefreshCw size={14}/>} className="w-full">Vider le cache & recharger</MedBtn>
        </div>
      </div>
      <BottomNav onDeckBuilder={onDeckBuilder} onBooster={onBooster} onRules={onRules} onAccount={onAccount} onShop={onShop} onSocial={onSocial} unreadCount={unreadCount} user={user}/>
    </div>
  )
}
// ═══════════════════════════════════════════════════════════════════════════════
//  SOCIAL SCREEN — friends, friend requests, notifications
// ═══════════════════════════════════════════════════════════════════════════════
const NOTIF_ICON={friend_request:UserPlus,friend_accept:Check,challenge:Swords,match_result:Bell}
function notifText(n){
  if(n.type==='friend_request')return `${n.fromPseudo} vous a envoyé une demande d'ami.`
  if(n.type==='friend_accept')return `${n.byPseudo} a accepté votre demande d'ami.`
  if(n.type==='challenge')return `${n.fromPseudo} vous défie en duel !`
  if(n.type==='match_result')return n.result==='draw'?`Partie nulle contre ${n.opponentPseudo}.`:n.result==='win'?`Victoire contre ${n.opponentPseudo} !`:`Défaite contre ${n.opponentPseudo}.`
  return ''
}
function SocialScreen({onBack,user,friends,friendRequests,notifications,onSendRequest,onRespondRequest,onChallengeFriend,onAcceptChallenge,onMarkAllRead,onDeckBuilder,onBooster,onRules,onAccount,onShop}){
  const[pseudoInput,setPseudoInput]=useState('')
  const[sendError,setSendError]=useState('')
  const[sendOk,setSendOk]=useState('')
  const[sending,setSending]=useState(false)

  // Opening this screen is the read receipt — simplest model that keeps the
  // BottomNav badge in sync without per-item "mark as read" bookkeeping.
  useEffect(()=>{if(user)onMarkAllRead()},[user])

  if(!user)return(
    <div className="bg-charta min-h-screen flex flex-col items-center justify-center gap-5 px-4">
      <div className="text-6xl select-none">🔒</div>
      <p className="text-amber-300 font-bold text-xl text-center drop-shadow-[0_1px_4px_rgba(0,0,0,0.9)]" style={CINZEL}>Connexion requise</p>
      <p className="text-slate-300 text-sm text-center max-w-xs drop-shadow-[0_1px_3px_rgba(0,0,0,0.9)]">Connectez-vous pour ajouter des amis, envoyer des défis et voir vos notifications.</p>
      <BackButton onClick={onBack}>Menu</BackButton>
    </div>
  )

  async function handleSend(e){
    e.preventDefault()
    const p=pseudoInput.trim();if(!p)return
    setSendError('');setSendOk('');setSending(true)
    try{await onSendRequest(p);setSendOk('Demande envoyée !');setPseudoInput('')}
    catch(err){setSendError(err.message)}
    setSending(false)
  }

  const sectionCls="rounded-xl p-4 mb-4 border border-amber-900/40"
  const sectionStyle={background:'rgba(8,5,2,0.78)'}

  return(
    <div className="bg-charta min-h-screen py-8 pb-28 px-4 flex flex-col items-center overflow-y-auto">
      <div className="max-w-sm w-full">
        <BackButton onClick={onBack} className="mb-6">Menu</BackButton>
        <h2 className="text-3xl font-black mb-5" style={{...CINZEL_DEC,background:'linear-gradient(to bottom,#ffe566,#c9a020)',WebkitBackgroundClip:'text',WebkitTextFillColor:'transparent',filter:'drop-shadow(0 1px 10px rgba(0,0,0,1))'}}>Amis</h2>

        <div className={sectionCls} style={sectionStyle}>
          <h3 className="text-amber-300 font-bold mb-2 flex items-center gap-1.5" style={CINZEL}><UserPlus size={15}/> Ajouter un ami</h3>
          <form onSubmit={handleSend} className="flex gap-2">
            <input value={pseudoInput} onChange={e=>setPseudoInput(e.target.value)} maxLength={24} placeholder="Pseudo"
              className="flex-1 min-w-0 bg-slate-800 text-slate-200 text-sm border border-slate-700 rounded-lg px-3 py-2 outline-none focus:border-amber-500"/>
            <MedBtn disabled={sending||!pseudoInput.trim()} color="#7cb87c" icon={<Send size={14}/>} className="shrink-0">Envoyer</MedBtn>
          </form>
          {sendError&&<p className="text-red-400 text-xs mt-2">{sendError}</p>}
          {sendOk&&<p className="text-emerald-400 text-xs mt-2">{sendOk}</p>}
        </div>

        {friendRequests.length>0&&(
          <div className={sectionCls} style={sectionStyle}>
            <h3 className="text-amber-300 font-bold mb-2" style={CINZEL}>Demandes reçues</h3>
            <div className="flex flex-col gap-2">
              {friendRequests.map(r=>(
                <div key={r.fromUid} className="flex items-center justify-between gap-2">
                  <span className="text-slate-200 text-sm truncate">{r.fromPseudo}</span>
                  <div className="flex gap-1.5 shrink-0">
                    <MedBtn onClick={()=>onRespondRequest(r.fromUid,r.fromPseudo,true)} color="#34d399" icon={<Check size={12}/>} className="!px-2 !py-1.5 !text-xs">Accepter</MedBtn>
                    <MedBtn onClick={()=>onRespondRequest(r.fromUid,r.fromPseudo,false)} color="#ef4444" icon={<X size={12}/>} className="!px-2 !py-1.5 !text-xs">Refuser</MedBtn>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className={sectionCls} style={sectionStyle}>
          <h3 className="text-amber-300 font-bold mb-2" style={CINZEL}>Mes amis ({friends.length})</h3>
          {friends.length===0
            ?<p className="text-slate-400 text-xs">Aucun ami pour l'instant — ajoutez-en un par pseudo ci-dessus.</p>
            :(
              <div className="flex flex-col gap-2">
                {friends.map(f=>(
                  <div key={f.uid} className="flex items-center justify-between gap-2">
                    <span className="text-slate-200 text-sm truncate">{f.pseudo}</span>
                    <MedBtn onClick={()=>onChallengeFriend(f.uid,f.pseudo)} color="#7cb87c" icon={<Swords size={12}/>} className="!px-2 !py-1.5 !text-xs shrink-0">Défier</MedBtn>
                  </div>
                ))}
              </div>
            )}
        </div>

        <div className={sectionCls} style={sectionStyle}>
          <h3 className="text-amber-300 font-bold mb-2 flex items-center gap-1.5" style={CINZEL}><Bell size={15}/> Notifications</h3>
          {notifications.length===0
            ?<p className="text-slate-400 text-xs">Aucune notification pour l'instant.</p>
            :(
              <div className="flex flex-col gap-2.5">
                {notifications.map(n=>{
                  const Icon=NOTIF_ICON[n.type]||Bell
                  return(
                    <div key={n.id} className={`flex items-start gap-2 pb-2.5 border-b border-amber-900/20 last:border-0 last:pb-0 ${n.read?'opacity-60':''}`}>
                      <Icon size={14} className="text-amber-400 shrink-0 mt-0.5"/>
                      <div className="min-w-0 flex-1">
                        <p className="text-slate-200 text-xs">{notifText(n)}</p>
                        {n.type==='challenge'&&(
                          <MedBtn onClick={()=>onAcceptChallenge(n.code)} color="#7cb87c" icon={<Swords size={12}/>} className="!px-2 !py-1.5 !text-xs mt-1.5">Accepter le défi</MedBtn>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
        </div>

        <BottomNav onDeckBuilder={onDeckBuilder} onBooster={onBooster} onRules={onRules} onAccount={onAccount} onShop={onShop} onSocial={()=>{}} unreadCount={0} user={user}/>
      </div>
    </div>
  )
}

// Surfaces the real Firebase error instead of a blanket "not configured" message,
// so a misconfigured security rule (the most common real-world cause of "nothing
// syncs") is actually visible instead of silently failing.
function friendlyFirebaseError(e){
  if(e?.message==='Firebase not configured')return 'Firebase non configuré — renseignez src/firebase.js'
  return `Erreur Firebase : ${e?.message||'inconnue'} — vérifiez les règles de sécurité de votre Realtime Database.`
}
function OnlineLobbyScreen({onBack,onGameStart,deck,ownedSkins,user,challengeTarget,autoJoinCode}){
  const[mode,setMode]=useState(null)
  const[code,setCode]=useState('')
  const[inputCode,setInputCode]=useState('')
  const[waiting,setWaiting]=useState(false)
  const[error,setError]=useState('')
  const[copied,setCopied]=useState(false)
  const[challengeSent,setChallengeSent]=useState(false)
  const[initialGame]=useState(()=>newGame(deck,null,ownedSkins))
  const unsubRef=useRef(null)
  const mmIdRef=useRef(null)
  const mmUnsubRef=useRef(null)

  function stopMatchmaking(){
    if(mmUnsubRef.current){mmUnsubRef.current();mmUnsubRef.current=null}
    if(mmIdRef.current){leaveMatchmaking(mmIdRef.current).catch(()=>{});mmIdRef.current=null}
  }
  useEffect(()=>()=>{if(unsubRef.current)unsubRef.current();stopMatchmaking()},[])

  async function handleCreate(){
    setError('');const c=genRoomCode();setCode(c);setMode('create')
    try{
      await createRoom(c,initialGame,user?.uid,user?.displayName);setWaiting(true)
      unsubRef.current=subscribeRoom(c,data=>{
        if(data.player2Joined){
          if(unsubRef.current){unsubRef.current();unsubRef.current=null}
          const opponent=data.guestUid?{uid:data.guestUid,pseudo:data.guestPseudo}:null
          onGameStart(data.state??initialGame,c,1,opponent)
        }
      })
    }catch(e){setError(friendlyFirebaseError(e))}
  }
  // Same as handleCreate, but also drops a notification in the friend's
  // mailbox with the room code so their "Accepter" button can auto-join.
  async function handleChallengeCreate(){
    setError('');const c=genRoomCode();setCode(c);setMode('create')
    try{
      await createRoom(c,initialGame,user?.uid,user?.displayName)
      await pushNotification(challengeTarget.uid,{type:'challenge',fromUid:user.uid,fromPseudo:user.displayName,code:c})
      setChallengeSent(true);setWaiting(true)
      unsubRef.current=subscribeRoom(c,data=>{
        if(data.player2Joined){
          if(unsubRef.current){unsubRef.current();unsubRef.current=null}
          const opponent=data.guestUid?{uid:data.guestUid,pseudo:data.guestPseudo}:{uid:challengeTarget.uid,pseudo:challengeTarget.pseudo}
          onGameStart(data.state??initialGame,c,1,opponent)
        }
      })
    }catch(e){setError(friendlyFirebaseError(e))}
  }
  async function handleJoin(codeOverride){
    setError('');const c=(codeOverride??inputCode).trim().toUpperCase()
    if(c.length!==6){setError('Code invalide.');return}
    try{
      const state=await joinRoom(c,user?.uid,user?.displayName)
      if(!state){setError('Partie introuvable.');return}
      setCode(c);setWaiting(true)
      unsubRef.current=subscribeRoom(c,data=>{
        if(data.state){
          if(unsubRef.current){unsubRef.current();unsubRef.current=null}
          const opponent=data.hostUid?{uid:data.hostUid,pseudo:data.hostPseudo}:null
          onGameStart(data.state,c,2,opponent)
        }
      })
    }catch(e){setError(friendlyFirebaseError(e))}
  }
  useEffect(()=>{
    if(challengeTarget)handleChallengeCreate()
    else if(autoJoinCode)handleJoin(autoJoinCode)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[])
  async function handleMatchmaking(){
    setError('');setMode('matchmaking')
    const myId=crypto.randomUUID()
    mmIdRef.current=myId
    try{
      const res=await joinMatchmaking(myId)
      if(mmIdRef.current!==myId)return // cancelled while the request was in flight
      if(res.role==='host'){
        const c=genRoomCode()
        await createRoom(c,initialGame,user?.uid,user?.displayName)
        await publishMatchResult(res.opponentId,c)
        mmIdRef.current=null
        onGameStart(initialGame,c,1)
      }else{
        mmUnsubRef.current=subscribeMatchResult(myId,async result=>{
          if(mmUnsubRef.current){mmUnsubRef.current();mmUnsubRef.current=null}
          mmIdRef.current=null
          clearMatchResult(myId).catch(()=>{})
          const joined=await joinRoom(result.code,user?.uid,user?.displayName)
          const opponent=joined?.hostUid?{uid:joined.hostUid,pseudo:joined.hostPseudo}:null
          onGameStart(joined?.state??initialGame,result.code,2,opponent)
        })
      }
    }catch(e){setError(friendlyFirebaseError(e));mmIdRef.current=null;setMode(null)}
  }
  function handleCancelMatchmaking(){stopMatchmaking();setMode(null)}
  function copyCode(){navigator.clipboard.writeText(code).then(()=>{setCopied(true);setTimeout(()=>setCopied(false),2000)})}

  if(waiting)return(
    <div className="bg-charta min-h-screen flex flex-col items-center justify-center gap-6 px-4 text-center">
      <div className="text-4xl animate-spin">⚙</div>
      {challengeSent
        ?<p className="text-white text-xl font-bold drop-shadow-[0_1px_3px_rgba(0,0,0,0.9)]">Défi envoyé à <span className="text-amber-300">{challengeTarget?.pseudo}</span></p>
        :<p className="text-white text-xl font-bold drop-shadow-[0_1px_3px_rgba(0,0,0,0.9)]">Code : <span className="text-amber-300 tracking-widest font-black">{code}</span></p>}
      <p className="text-slate-300 animate-pulse drop-shadow-[0_1px_3px_rgba(0,0,0,0.9)]">En attente {challengeSent?'que votre ami accepte':'du joueur 2'}…</p>
      {!challengeSent&&<MedBtn onClick={copyCode} color="#e8c766" icon={copied?<Check size={14}/>:<Copy size={14}/>}>{copied?'Copié !':'Copier le code'}</MedBtn>}
      <MedBtn onClick={()=>{setWaiting(false);setMode(null)}} color="#a89484">Annuler</MedBtn>
    </div>
  )

  if(mode==='matchmaking')return(
    <div className="bg-charta min-h-screen flex flex-col items-center justify-center gap-6 px-4 text-center">
      <div className="text-4xl animate-spin">⚔</div>
      <p className="text-white text-xl font-bold drop-shadow-[0_1px_3px_rgba(0,0,0,0.9)]">Recherche d'un adversaire…</p>
      <p className="text-slate-300 text-sm max-w-xs drop-shadow-[0_1px_3px_rgba(0,0,0,0.9)]">La partie démarre automatiquement dès qu'un autre joueur rejoint le matchmaking.</p>
      {error&&<p className="text-red-400 text-sm bg-red-900/30 px-4 py-2 rounded-lg text-center max-w-sm">{error}</p>}
      <MedBtn onClick={handleCancelMatchmaking} color="#a89484">Annuler</MedBtn>
    </div>
  )

  return(
    <div className="bg-charta min-h-screen flex flex-col items-center justify-center gap-6 px-4 relative">
      <BackButton onClick={onBack} compact className="absolute top-4 left-4">Menu</BackButton>
      <h2 className="text-3xl font-black" style={{...CINZEL_DEC,background:'linear-gradient(to bottom,#ffe566,#c9a020)',WebkitBackgroundClip:'text',WebkitTextFillColor:'transparent',filter:'drop-shadow(0 1px 10px rgba(0,0,0,1))'}}>Partie en Ligne</h2>
      {error&&<p className="text-red-400 text-sm bg-red-900/30 px-4 py-2 rounded-lg text-center max-w-sm">{error}</p>}
      {!mode&&(
        <div className="flex flex-col items-center gap-4">
          <MedBtn onClick={handleMatchmaking} color="#7cb87c" icon={<Swords size={18}/>} className="!py-3 !px-6 !text-base">Trouver une partie</MedBtn>
          <div className="flex gap-4">
            <MedBtn onClick={handleCreate} color="#7fa8d9" className="!py-3 !px-6 !text-base">Créer</MedBtn>
            <MedBtn onClick={()=>setMode('join')} color="#c9a5e0" className="!py-3 !px-6 !text-base">Rejoindre</MedBtn>
          </div>
        </div>
      )}
      {mode==='join'&&(
        <div className="wood-btn rounded-2xl p-6 w-72">
          <p className="text-amber-200/80 text-sm mb-2">Code de la partie :</p>
          <input value={inputCode} onChange={e=>setInputCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,6))} className="bg-black/40 text-white font-black text-2xl tracking-widest text-center border border-amber-800/50 rounded-lg px-4 py-2 w-full outline-none focus:border-amber-400 mb-3" placeholder="XXXXXX" maxLength={6}/>
          <MedBtn onClick={handleJoin} disabled={inputCode.length!==6} color="#c9a5e0" className="w-full">Rejoindre</MedBtn>
          <MedBtn onClick={()=>setMode(null)} color="#a89484" className="w-full mt-2">Retour</MedBtn>
        </div>
      )}
    </div>
  )
}
function GameOverScreen({winner,isAI,surrendered,onReplay,onMenu,coinsAwarded}){
  const isDraw=winner==='draw'
  const loser=winner===1?2:1
  const winLabel=isAI&&winner===2?'L\'IA':`Joueur ${winner}`
  const msg=isDraw
    ?'Les deux camps ont perdu leur dernière carte dans le même échange.'
    :surrendered
      ?`Joueur ${loser} a capitulé.`
      :isAI&&winner===2?'L\'IA a éliminé toutes vos cartes.':'L\'adversaire n\'a plus aucune carte.'
  // In Solo mode the human is always P1 — treat an AI win as the somber outcome
  const defeat=!isDraw&&isAI&&winner===2
  return(
    <div className="bg-charta relative min-h-screen flex flex-col items-center justify-center gap-5 px-4 overflow-hidden">
      {!defeat&&(
        <>
          <div className="menu-embers" aria-hidden="true">
            {MENU_EMBERS.map((e,i)=>(
              <span key={i} className="menu-ember" style={{
                left:`${e.left}%`, width:e.size, height:e.size,
                animationDuration:`${e.duration}s`, animationDelay:`${e.delay}s`,
                '--drift':`${e.drift}px`,
              }}/>
            ))}
          </div>
          <div className="menu-vignette-pulse" aria-hidden="true"/>
        </>
      )}
      <div className="relative z-10 flex flex-col items-center gap-5">
        <div className="text-7xl mb-2 animate-bounce">{isDraw?'⚖️':surrendered?'🏳️':defeat?'💀':'🏆'}</div>
        <h2 className="text-4xl sm:text-5xl font-black text-center leading-tight px-4"
          style={defeat
            ?{...CINZEL_DEC,color:'#cbd5e1',filter:'drop-shadow(0 2px 4px rgba(0,0,0,1)) drop-shadow(0 0 18px rgba(0,0,0,0.9))'}
            :isDraw
              ?{...CINZEL_DEC,color:'#93c5fd',filter:'drop-shadow(0 2px 4px rgba(0,0,0,1)) drop-shadow(0 0 18px rgba(0,0,0,0.85))'}
              :{...CINZEL_DEC,
                background:'linear-gradient(115deg,#7a5c0a 0%,#ffe566 20%,#fff8dc 32%,#ffe566 44%,#c9a020 60%,#7a5c0a 100%)',
                backgroundSize:'250% auto', WebkitBackgroundClip:'text', WebkitTextFillColor:'transparent',
                filter:'drop-shadow(0 2px 4px rgba(0,0,0,1)) drop-shadow(0 0 18px rgba(0,0,0,0.85))'}}>
          {isDraw?'Égalité !':`${winLabel} gagne !`}
        </h2>
        <p className="text-slate-100 font-bold text-center px-4 py-1.5 rounded-full bg-black/55 border border-amber-900/40 drop-shadow-[0_1px_3px_rgba(0,0,0,0.9)]">{msg}</p>
        {coinsAwarded&&(
          <p className="text-amber-300 text-sm font-bold flex items-center gap-1.5 menu-fade-up" style={CINZEL}>
            <Coins size={14}/> +{coinsAwarded} pièces
          </p>
        )}
        <div className="flex gap-3 mt-4">
          <MedBtn onClick={onReplay} icon={<Play size={16}/>} color="#60a5fa">Rejouer</MedBtn>
          <BackButton onClick={onMenu}>Menu</BackButton>
        </div>
      </div>
    </div>
  )
}
function SoundToggle({enabled,onToggle,volume,onVolumeChange}){
  return(
    <div className="fixed top-3 right-3 z-50 flex items-center gap-1.5 bg-slate-800/80 backdrop-blur-sm p-2 rounded-lg">
      <button onClick={onToggle} className="text-slate-400 hover:text-white transition-all duration-200 hover:scale-110 active:scale-90 shrink-0">
        {enabled?<Volume2 size={18}/>:<VolumeX size={18}/>}
      </button>
      <input type="range" min={0} max={1} step={0.05} value={volume} disabled={!enabled}
        onChange={e=>onVolumeChange(parseFloat(e.target.value))}
        title="Volume de la musique"
        className="w-16 accent-amber-500 disabled:opacity-30 cursor-pointer"/>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
//  MAIN APP
// ═══════════════════════════════════════════════════════════════════════════════
export default function App(){
  const[booted,setBooted]=useState(false)
  // Supports a direct link to the legal pages (e.g. https://…/#cgu) so they can
  // be set as the Play Console "Privacy policy" URL without needing a router.
  const[screen,setScreen]=useState(()=>{
    const h=typeof window!=='undefined'?window.location.hash.replace('#',''):''
    return h==='cgu'||h==='privacy'?h:'menu'
  })
  const[game,setGame]=useState(null)
  const[soundOn,setSoundOn]=useState(loadSoundPref)
  const[musicVolume,setMusicVolumeState]=useState(loadMusicVolumePref)
  const[gameMode,setGameMode]=useState('local') // 'local'|'ai'|'online'
  const[roomCode,setRoomCode]=useState(null)
  const[myPlayer,setMyPlayer]=useState(null)
  const[syncError,setSyncError]=useState(null)
  const[pendingMode,setPendingMode]=useState(null) // mode awaiting a deck choice
  const[chosenDeck,setChosenDeck]=useState(null) // deck selected for the next match (null = random)
  const[user,setUser]=useState(null)
  const[stats,setStats]=useState(null)
  const[lastAnim,setLastAnim]=useState(null)
  const[showTutorial,setShowTutorial]=useState(false)
  const[coins,setCoins]=useState(()=>loadCoins())
  const[ownedSkins,setOwnedSkins]=useState(()=>loadOwnedSkins())
  const[gameOverCoinsAwarded,setGameOverCoinsAwarded]=useState(null)
  const[friends,setFriends]=useState([])
  const[friendRequests,setFriendRequests]=useState([])
  const[notifications,setNotifications]=useState([])
  const[pendingChallenge,setPendingChallenge]=useState(null) // {uid,pseudo} — "Défier" was clicked, going through deck-select
  const[pendingJoinCode,setPendingJoinCode]=useState(null) // a challenge notification was accepted, going through deck-select
  const unreadCount=notifications.filter(n=>!n.read).length
  const ignoreNextRef=useRef(false)
  const unsubRef=useRef(null)
  const gameRef=useRef(game)
  const soundOnRef=useRef(soundOn)
  const aiTimerRef=useRef(null)
  const statsRecordedRef=useRef(false)
  const animSeqRef=useRef(0)
  const remoteAnimSeqRef=useRef(null) // last opponent lastActionAnim.seq already played, online mode
  const opponentRef=useRef(null) // {uid,pseudo} of the current online opponent, when known
  const coinsUpdatedAtRef=useRef(loadCoinsUpdatedAt())
  const economyCloudReadyRef=useRef(false)
  function nextAnimSeq(){animSeqRef.current+=1;return animSeqRef.current}

  // ── Economy — coins & owned cosmetic skins ─────────────────────
  function earnCoins(amount){coinsUpdatedAtRef.current=Date.now();setCoins(c=>c+amount)}
  function sellCard(rarity){const value=SELL_VALUE[rarity]||0;earnCoins(value);return value}
  function spendCoins(amount){
    if(coins<amount)return false
    coinsUpdatedAtRef.current=Date.now()
    setCoins(c=>c-amount)
    snd('coin',soundOnRef.current)
    return true
  }
  function buySkin(skinId,price){
    if(ownedSkins.includes(skinId)||coins<price)return false
    coinsUpdatedAtRef.current=Date.now()
    setCoins(c=>c-price)
    setOwnedSkins(s=>[...s,skinId])
    snd('coin',soundOnRef.current)
    return true
  }
  useEffect(()=>{saveCoins(coins);saveCoinsUpdatedAt(coinsUpdatedAtRef.current)},[coins])
  useEffect(()=>{saveOwnedSkins(ownedSkins)},[ownedSkins])
  useEffect(()=>{
    economyCloudReadyRef.current=false
    if(!user){economyCloudReadyRef.current=true;return}
    loadCloudEconomy(user.uid).then(cloud=>{
      economyCloudReadyRef.current=true
      if(!cloud)return
      // Coins: keep whichever side (local/cloud) was actually updated more recently —
      // same reasoning as the deck merge fix, a stale cloud snapshot must not silently
      // undo a spend/earn that already happened locally.
      if((cloud.coinsUpdatedAt||0)>coinsUpdatedAtRef.current){
        coinsUpdatedAtRef.current=cloud.coinsUpdatedAt||0
        setCoins(cloud.coins||0)
      }
      // Owned skins only ever grow — a plain union is always safe either direction.
      setOwnedSkins(prev=>Array.from(new Set([...prev,...(cloud.ownedSkins||[])])))
    }).catch(()=>{economyCloudReadyRef.current=true})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[user?.uid])
  useEffect(()=>{
    if(user&&economyCloudReadyRef.current)saveCloudEconomy(user.uid,{coins,coinsUpdatedAt:coinsUpdatedAtRef.current,ownedSkins}).catch(()=>{})
  },[coins,ownedSkins])

  useEffect(()=>{gameRef.current=game},[game])
  useEffect(()=>{soundOnRef.current=soundOn;saveSoundPref(soundOn)},[soundOn])
  useEffect(()=>()=>{if(unsubRef.current)unsubRef.current()},[])

  // ── Account ───────────────────────────────────────────────────
  useEffect(()=>onAuthChange(setUser),[])
  // Picks up the result of a signInWithRedirect (standalone/PWA Google login,
  // see firebase.js) that just navigated back into the app — onAuthChange above
  // already updates `user` once Firebase processes it, this just surfaces errors.
  useEffect(()=>{completeRedirectLogin().catch(()=>{})},[])
  useEffect(()=>{
    if(!user){setStats(null);return}
    return subscribeStats(user.uid,setStats)
  },[user?.uid])
  // Best-effort backfill: accounts created before the friends system existed
  // never claimed a `usernames/` slot, so they'd be unfindable by pseudo.
  // Silently (re-)claims the current displayName on every login; a no-op if
  // already owned, harmless to retry if it fails (e.g. name taken meanwhile).
  useEffect(()=>{
    if(user?.uid&&user?.displayName)claimUsername(user.uid,user.displayName).catch(()=>{})
  },[user?.uid])
  // ── Social — friends, pending requests, notifications ───────────
  useEffect(()=>{
    if(!user){setFriends([]);setFriendRequests([]);setNotifications([]);return}
    const unsubFriends=subscribeFriends(user.uid,setFriends)
    const unsubRequests=subscribeFriendRequests(user.uid,setFriendRequests)
    const unsubNotifs=subscribeNotifications(user.uid,setNotifications)
    return()=>{unsubFriends();unsubRequests();unsubNotifs()}
  },[user?.uid])
  // Record win/loss once a match tied to a real opponent (AI or online) ends
  useEffect(()=>{
    if(screen==='gameover'&&game?.winner&&!statsRecordedRef.current){
      statsRecordedRef.current=true
      if(user&&game.winner!=='draw'&&(gameMode==='ai'||gameMode==='online')){
        const iWon=gameMode==='ai'?game.winner===1:game.winner===myPlayer
        recordGameResult(user.uid,iWon).catch(()=>{})
        // Online and AI wins carry a coin reward — local hotseat practice matches
        // don't (no single "you" to reward when two people share the screen).
        if(iWon){
          const reward=gameMode==='online'?ONLINE_WIN_COIN_REWARD:AI_WIN_COIN_REWARD
          earnCoins(reward)
          setGameOverCoinsAwarded(reward)
        }
      }
      // Match history notification — every online game, win/loss/draw, against
      // whichever opponent identity the room happened to carry.
      if(user&&gameMode==='online'){
        const result=game.winner==='draw'?'draw':(game.winner===myPlayer?'win':'loss')
        pushNotification(user.uid,{
          type:'match_result',result,
          opponentUid:opponentRef.current?.uid||null,
          opponentPseudo:opponentRef.current?.pseudo||'Adversaire',
        }).catch(()=>{})
      }
    }
    if(screen!=='gameover'){statsRecordedRef.current=false;setGameOverCoinsAwarded(null)}
  },[screen])

  // ── Music ─────────────────────────────────────────────────────
  useEffect(()=>{
    if(screen==='game') startMusic(soundOn, false)
    else if(screen==='gameover'){
      // Only AI/online have a clear "did I win" perspective — local hotseat
      // matches have two real players sharing the screen, so no personal outcome.
      if(game?.winner==='draw')startMusic(soundOn,false,'defeat')
      else if(game?.winner&&(gameMode==='ai'||gameMode==='online')){
        const iWon=gameMode==='ai'?game.winner===1:game.winner===myPlayer
        startMusic(soundOn,false,iWon?'victory':'defeat')
      }else stopMusic()
    }
    else if(['menu','rules','online','deckselect','account','booster','deckbuilder','shop','social'].includes(screen)) startMusic(soundOn, true)
    else stopMusic()
  },[screen,soundOn,gameMode,myPlayer,game?.winner])
  useEffect(()=>()=>stopMusic(),[])

  // ── AI loop ──────────────────────────────────────────────────
  useEffect(()=>{
    if(gameMode!=='ai'||screen!=='game')return
    const g=gameRef.current
    if(!g||g.currentPlayer!==2||g.winner)return
    if(aiTimerRef.current)clearTimeout(aiTimerRef.current)
    aiTimerRef.current=setTimeout(()=>{
      aiTimerRef.current=null
      const current=gameRef.current
      if(!current||current.currentPlayer!==2||current.winner)return
      const action=computeAIAction(current)
      // computeAIAction only falls all the way through to 'endTurn' when every branch —
      // flee, kill, power, placement, attack, move — found nothing legal. If that happens
      // on a fresh turn (nothing spent yet), the AI is truly stuck and must surrender
      // instead of silently passing forever.
      if(action.type==='endTurn'&&!hasActedThisTurn(current.actionsLeft)){
        handleSurrender(2)
        return
      }
      const sfx=soundForAIAction(action,current)
      let cells=null,violent=false
      if(action?.type==='place'){
        cells=[{r:action.r,c:action.c,ghost:null,anim:'anim-place',dur:350}]
      }else if(action?.type==='move'){
        cells=[{r:action.tr,c:action.tc,ghost:null,anim:'anim-move',dur:220}]
      }else if(action?.type==='attack'){
        const{aDies,dDies,atk,def}=analyzeAttack(current,action.ar,action.ac,action.dr,action.dc)
        violent=aDies||dDies
        cells=[
          {r:action.dr,c:action.dc,ghost:dDies?def:null,anim:dDies?'anim-destroy':'anim-attack',dur:dDies?650:350},
          {r:action.ar,c:action.ac,ghost:aDies?atk:null,anim:aDies?'anim-destroy':'anim-attack',dur:aDies?650:350},
        ]
      }
      const newState=applyAIActionDirect(current,action)
      if(!newState){
        setGame(prev=>({...prev,currentPlayer:1,actionsLeft:{...FRESH_ACTIONS},turn:(prev?.turn||1)+1}))
        return
      }
      if(sfx)snd(sfx,soundOnRef.current)
      if(cells)setLastAnim({seq:nextAnimSeq(),cells,violent})
      const winner=checkWin(newState)
      if(winner){setGame({...newState,winner});setTimeout(()=>setScreen('gameover'),700)}
      else setGame(newState)
    },850)
    return()=>{if(aiTimerRef.current){clearTimeout(aiTimerRef.current);aiTimerRef.current=null}}
  },[game,gameMode,screen])

  function syncOnline(g){
    ignoreNextRef.current=true
    pushState(roomCode,g).then(()=>setSyncError(null)).catch(e=>{console.warn(e);setSyncError(e?.message||'Échec de synchronisation')})
  }

  // ── Action handler ───────────────────────────────────────────
  function handleAction({drag,targetR,targetC}){
    if(!game)return
    if(myPlayer!=null&&myPlayer!==game.currentPlayer)return // not this client's turn — reject even if the UI somehow allowed the drag
    let g=game;const cp=g.currentPlayer,al=g.actionsLeft;let cells=null,violent=false,sfx=null
    if(drag.from==='hand'){
      if(al.placement<=0||drag.player!==cp)return
      if(isCellBlocked(g,targetR,targetC)||!inZone(targetR,cp)||g.board[targetR][targetC])return
      const hand=[...g.players[cp].hand];const card=hand[drag.handIdx];if(!card)return
      hand.splice(drag.handIdx,1);const nb=g.board.map(r=>[...r]);nb[targetR][targetC]=card
      g={...g,board:nb,players:{...g.players,[cp]:{...g.players[cp],hand}},actionsLeft:{...al,placement:al.placement-1}}
      sfx='place-'+cardTier(card);snd(sfx,soundOn);cells=[{r:targetR,c:targetC,ghost:null,anim:'anim-place',dur:350}]
    }else if(drag.from==='board'){
      const{r:fr,c:fc}=drag;const moving=g.board[fr][fc]
      if(!moving||moving.owner!==cp)return
      const target=g.board[targetR][targetC]
      if(target){
        if(al.attack<=0||target.owner===cp||!isCardinal(fr,fc,targetR,targetC))return
        const{newBoard,aDead,dDead}=doAttack(g.board,fr,fc,targetR,targetC)
        g={...g,board:newBoard,actionsLeft:{...al,attack:al.attack-1}}
        sfx=aDead||dDead?'destroy':'attack';snd(sfx,soundOn)
        violent=aDead||dDead
        cells=[
          {r:targetR,c:targetC,ghost:dDead?target:null,anim:dDead?'anim-destroy':'anim-attack',dur:dDead?650:350},
          {r:fr,c:fc,ghost:aDead?moving:null,anim:aDead?'anim-destroy':'anim-attack',dur:aDead?650:350},
        ]
      }else{
        if(al.moves<=0||isCellBlocked(g,targetR,targetC)||!isAdjacent(fr,fc,targetR,targetC))return
        if(isBannedLastCardBacktrack(g,cp,moving,targetR,targetC))return
        const nb=g.board.map(r=>[...r]);nb[targetR][targetC]={...moving,prevPos:{r:fr,c:fc}};nb[fr][fc]=null
        g={...g,board:nb,actionsLeft:{...al,moves:al.moves-1}};sfx='move';snd(sfx,soundOn);cells=[{r:targetR,c:targetC,ghost:null,anim:'anim-move',dur:220}]
      }
    }
    if(cells){
      setLastAnim({seq:nextAnimSeq(),cells,violent})
      g={...g,lastActionAnim:{cells,violent,sfx,seq:Date.now()+Math.random()}}
    }
    const winner=checkWin(g)
    if(winner){
      const f={...g,winner};setGame(f)
      if(roomCode){syncOnline(f);setTimeout(()=>removeRoom(roomCode).catch(()=>{}),4000)}
      setTimeout(()=>setScreen('gameover'),650)
    }else{setGame(g);if(roomCode)syncOnline(g)}
  }

  function handlePowerAction(type,r,c){
    if(!game)return
    if(myPlayer!=null&&myPlayer!==game.currentPlayer)return
    // Local anim/sound for the acting player is triggered client-side in GameScreen
    // (handleCellClick); this descriptor is only for syncing it to the opponent.
    let g=applyPowerAction(game,type,r,c)
    g={...g,lastActionAnim:{cells:[{r,c,ghost:null,anim:'anim-power',dur:500}],violent:false,sfx:'power',seq:Date.now()+Math.random()}}
    const winner=checkWin(g)
    if(winner){const f={...g,winner};setGame(f);if(roomCode)syncOnline(f);setTimeout(()=>setScreen('gameover'),650)}
    else{setGame(g);if(roomCode)syncOnline(g)}
  }

  function handleSurrender(losingPlayer){
    if(!game)return
    const winningPlayer=losingPlayer===1?2:1
    const f={...game,winner:winningPlayer,surrendered:true}
    setGame(f)
    if(roomCode){syncOnline(f);setTimeout(()=>removeRoom(roomCode).catch(()=>{}),4000)}
    setTimeout(()=>setScreen('gameover'),300)
  }

  function handleEndTurn(){
    if(!game||!hasActedThisTurn(game.actionsLeft))return
    if(myPlayer!=null&&myPlayer!==game.currentPlayer)return
    const next=game.currentPlayer===1?2:1
    const g={...game,currentPlayer:next,actionsLeft:{...FRESH_ACTIONS},turn:game.turn+1}
    setGame(g);if(roomCode)syncOnline(g)
  }

  function startGame(mode,deck=chosenDeck){
    if(aiTimerRef.current){clearTimeout(aiTimerRef.current);aiTimerRef.current=null}
    const p1Deck=deck,p2Deck=mode==='local'?deck:null
    // Clear any leftover animation from a PREVIOUS match — otherwise a match that
    // ended on a kill (e.g. two cards dying at once) replays that same explosion
    // on the fresh board the instant the new GameScreen mounts, before anyone
    // has acted.
    setLastAnim(null)
    setGameMode(mode);setRoomCode(null);setMyPlayer(mode==='ai'?1:null);setGame(newGame(p1Deck,p2Deck,ownedSkins));setScreen('loading')
    if(mode==='ai'&&!loadTutorialSeen())setShowTutorial(true)
  }
  function handleTutorialClose(){saveTutorialSeen();setShowTutorial(false)}

  function goToDeckSelect(mode){setPendingMode(mode);setScreen('deckselect')}
  function handleDeckChosen(deck){
    setChosenDeck(deck)
    if(pendingMode==='online')setScreen('online')
    else startGame(pendingMode,deck)
  }

  // ── Friends / challenges ─────────────────────────────────────────
  function handleChallengeFriend(friendUid,friendPseudo){
    setPendingChallenge({uid:friendUid,pseudo:friendPseudo})
    setPendingJoinCode(null)
    goToDeckSelect('online')
  }
  function handleAcceptChallenge(code){
    setPendingJoinCode(code)
    setPendingChallenge(null)
    goToDeckSelect('online')
  }
  async function handleSendFriendRequest(toPseudo){
    await sendFriendRequest(user.uid,user.displayName,toPseudo)
  }
  async function handleRespondFriendRequest(fromUid,fromPseudo,accept){
    await respondFriendRequest(user.uid,user.displayName,fromUid,fromPseudo,accept)
  }
  function handleMarkAllNotifsRead(){
    const unreadIds=notifications.filter(n=>!n.read).map(n=>n.id)
    if(user&&unreadIds.length)markAllNotificationsRead(user.uid,unreadIds).catch(()=>{})
  }

  function handleOnlineStart(state,code,player,opponent){
    setLastAnim(null) // don't replay the previous match's death animation on the new board
    setGameMode('online');setRoomCode(code);setMyPlayer(player);setGame(state);setScreen('loading');setSyncError(null)
    setPendingChallenge(null);setPendingJoinCode(null)
    opponentRef.current=opponent||null
    remoteAnimSeqRef.current=state?.lastActionAnim?.seq??null
    if(unsubRef.current){unsubRef.current();unsubRef.current=null}
    unsubRef.current=subscribeRoom(code,data=>{
      if(ignoreNextRef.current){ignoreNextRef.current=false;return}
      if(!data.state)return
      const incoming=data.state
      const remoteAnim=incoming.lastActionAnim
      if(remoteAnim&&remoteAnim.seq!==remoteAnimSeqRef.current){
        remoteAnimSeqRef.current=remoteAnim.seq
        // Firebase RTDB doesn't always round-trip small arrays as real arrays
        const cells=Array.isArray(remoteAnim.cells)?remoteAnim.cells:Object.values(remoteAnim.cells||{})
        setLastAnim({seq:nextAnimSeq(),cells,violent:remoteAnim.violent})
        if(remoteAnim.sfx)snd(remoteAnim.sfx,soundOnRef.current)
      }
      setGame(incoming)
    },e=>{console.warn(e);setSyncError(e?.message||'Connexion perdue avec la partie en ligne')})
  }

  function closeGame(){
    if(aiTimerRef.current){clearTimeout(aiTimerRef.current);aiTimerRef.current=null}
    if(unsubRef.current){unsubRef.current();unsubRef.current=null}
    setScreen('menu')
  }

  // updateProfile() (pseudo change) doesn't trigger onAuthChange, so pull a fresh
  // snapshot manually after any profile edit to reflect it in the UI immediately.
  function refreshUser(){
    const u=currentUserSnapshot()
    if(u)setUser(u)
  }
  // RTDB data must be wiped BEFORE the Auth account is deleted — once deleteUser()
  // succeeds, auth.currentUser is gone and the database rules (uid-scoped) would
  // reject any further writes for this user. If deleteCurrentAccount() throws
  // auth/requires-recent-login, deleteAccountData has already run (harmless to
  // repeat) — AccountScreen catches that error, prompts reauthentication, and
  // calls this again.
  async function handleDeleteAccount(){
    if(!user)throw new Error('Non connecté')
    const uid=user.uid
    await deleteAccountData(uid)
    await deleteCurrentAccount()
    clearLocalAccountData()
    setCoins(0);setOwnedSkins([])
    setUser(null)
    setScreen('menu')
  }

  // App-boot preload — menu backgrounds, every match image and the menu track,
  // so the very first screen never pops in silently/blank.
  if(!booted)return <LoadingScreen onDone={()=>setBooted(true)} images={BOOT_IMAGES} audio={BOOT_AUDIO} title="Chargement de Charta Logica…" minDelayMs={800}/>

  return(
    <>
      <SoundToggle enabled={soundOn} onToggle={()=>setSoundOn(v=>!v)} volume={musicVolume} onVolumeChange={v=>{setMusicVolumeState(v);setMusicVolume(v)}}/>
      {screen==='menu'     && <MenuScreen onAI={()=>goToDeckSelect('ai')} onLocal={()=>goToDeckSelect('local')} onOnline={()=>{setPendingChallenge(null);setPendingJoinCode(null);goToDeckSelect('online')}} onRules={()=>setScreen('rules')} onDeckBuilder={()=>setScreen('deckbuilder')} onAccount={()=>setScreen('account')} onBooster={()=>setScreen('booster')} onShop={()=>setScreen('shop')} onSocial={()=>setScreen('social')} unreadCount={unreadCount} user={user} coins={coins}/>}
      {screen==='rules'    && <RulesScreen onBack={()=>setScreen('menu')} user={user} onDeckBuilder={()=>setScreen('deckbuilder')} onBooster={()=>setScreen('booster')} onRules={()=>setScreen('rules')} onAccount={()=>setScreen('account')} onShop={()=>setScreen('shop')} onSocial={()=>setScreen('social')} unreadCount={unreadCount}/>}
      {screen==='deckbuilder' && <DeckBuilderScreen onBack={()=>setScreen('menu')} user={user} ownedSkins={ownedSkins} coins={coins} onDeckBuilder={()=>setScreen('deckbuilder')} onBooster={()=>setScreen('booster')} onRules={()=>setScreen('rules')} onAccount={()=>setScreen('account')} onShop={()=>setScreen('shop')} onSocial={()=>setScreen('social')} unreadCount={unreadCount}/>}
      {screen==='booster'  && <BoosterScreen onBack={()=>setScreen('menu')} user={user} ownedSkins={ownedSkins} coins={coins} onEarnCoins={earnCoins} onSellCard={sellCard} onSpendCoins={spendCoins} soundEnabled={soundOn} onDeckBuilder={()=>setScreen('deckbuilder')} onBooster={()=>setScreen('booster')} onRules={()=>setScreen('rules')} onAccount={()=>setScreen('account')} onShop={()=>setScreen('shop')} onSocial={()=>setScreen('social')} unreadCount={unreadCount}/>}
      {screen==='shop'     && <ShopScreen onBack={()=>setScreen('menu')} user={user} coins={coins} ownedSkins={ownedSkins} onBuySkin={buySkin} onDeckBuilder={()=>setScreen('deckbuilder')} onBooster={()=>setScreen('booster')} onRules={()=>setScreen('rules')} onAccount={()=>setScreen('account')} onSocial={()=>setScreen('social')} unreadCount={unreadCount}/>}
      {screen==='deckselect' && <DeckSelectScreen mode={pendingMode} onBack={()=>setScreen('menu')} onSelect={handleDeckChosen}/>}
      {screen==='account'  && <AccountScreen onBack={()=>setScreen('menu')} user={user} stats={stats} onProfileUpdated={refreshUser} onLegal={type=>setScreen(type)} onDeleteAccount={handleDeleteAccount} onReauthenticate={reauthenticate} onDeckBuilder={()=>setScreen('deckbuilder')} onBooster={()=>setScreen('booster')} onRules={()=>setScreen('rules')} onAccount={()=>setScreen('account')} onShop={()=>setScreen('shop')} onSocial={()=>setScreen('social')} unreadCount={unreadCount}/>}
      {(screen==='cgu'||screen==='privacy') && <LegalScreen type={screen} onBack={()=>setScreen(user?'account':'menu')} user={user} onDeckBuilder={()=>setScreen('deckbuilder')} onBooster={()=>setScreen('booster')} onRules={()=>setScreen('rules')} onAccount={()=>setScreen('account')} onShop={()=>setScreen('shop')} onSocial={()=>setScreen('social')} unreadCount={unreadCount}/>}
      {screen==='social'   && <SocialScreen onBack={()=>setScreen('menu')} user={user} friends={friends} friendRequests={friendRequests} notifications={notifications} onSendRequest={handleSendFriendRequest} onRespondRequest={handleRespondFriendRequest} onChallengeFriend={handleChallengeFriend} onAcceptChallenge={handleAcceptChallenge} onMarkAllRead={handleMarkAllNotifsRead} onDeckBuilder={()=>setScreen('deckbuilder')} onBooster={()=>setScreen('booster')} onRules={()=>setScreen('rules')} onAccount={()=>setScreen('account')} onShop={()=>setScreen('shop')}/>}
      {screen==='online'   && <OnlineLobbyScreen onBack={()=>{setPendingChallenge(null);setPendingJoinCode(null);setScreen('menu')}} onGameStart={handleOnlineStart} deck={chosenDeck} ownedSkins={ownedSkins} user={user} challengeTarget={pendingChallenge} autoJoinCode={pendingJoinCode}/>}
      {screen==='loading'  && game && <LoadingScreen onDone={()=>setScreen('game')}/>}
      {screen==='game'     && game && <GameScreen game={game} soundEnabled={soundOn} myPlayer={myPlayer} isAI={gameMode==='ai'} onAction={handleAction} onEndTurn={handleEndTurn} onHome={closeGame} onPowerAction={handlePowerAction} onSurrender={handleSurrender} lastAnim={lastAnim} syncError={roomCode?syncError:null} showTutorial={gameMode==='ai'&&showTutorial} onTutorialClose={handleTutorialClose} pseudo={user?.displayName}/>}
      {screen==='gameover' && game && <GameOverScreen winner={game.winner} isAI={gameMode==='ai'} surrendered={!!game.surrendered} onReplay={()=>startGame(gameMode)} onMenu={()=>setScreen('menu')} coinsAwarded={gameOverCoinsAwarded}/>}
    </>
  )
}
