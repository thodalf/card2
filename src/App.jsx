import { useState, useEffect, useRef } from 'react'
import { Copy, Volume2, VolumeX, Home, BookOpen, Wifi, Play, Users, Check, X, Zap, Bot, Layers, Plus, Trash2, Star, ImagePlus, UserCircle, LogIn, LogOut, Mail, Lock, RefreshCw, Swords, Gift, ArrowRightLeft, Sparkles } from 'lucide-react'
import {
  genRoomCode, createRoom, joinRoom, pushState, subscribeRoom, removeRoom,
  onAuthChange, registerWithEmail, loginWithEmail, loginWithGoogle, logout,
  loadCloudDecks, saveCloudDecks, subscribeStats, recordGameResult,
  joinMatchmaking, leaveMatchmaking, publishMatchResult, subscribeMatchResult, clearMatchResult,
  loadCloudCollection, saveCloudCollection, loadCloudLastBooster, saveCloudLastBooster,
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

// Each points tier draws its portrait from a small pool for visual variety
const CARD_IMAGE_TIERS = {
  weak:   ['gnome.png', 'hobbit.png'],
  medium: ['elf.png', 'elf_noir.png', 'orc.png'],
  strong: ['roi.png', 'dragon.png'],
}
function pickCardImage(total){
  const pool=total<=20?CARD_IMAGE_TIERS.weak:total<=28?CARD_IMAGE_TIERS.medium:CARD_IMAGE_TIERS.strong
  return `/images/card/${pool[rnd(0,pool.length-1)]}`
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
function genDeck(owner) {
  return shuf(genDeckTotals()).map((total,i)=>{
    const values=genValues(total)
    const imageUrl=pickCardImage(total)
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

const SOUND_PREF_KEY='tacticalcards_sound_on'
function loadSoundPref(){
  try{const v=localStorage.getItem(SOUND_PREF_KEY);return v===null?true:v==='1'}catch{return true}
}
function saveSoundPref(on){
  try{localStorage.setItem(SOUND_PREF_KEY,on?'1':'0')}catch{}
}
function emptyCardValues(){
  return Object.fromEntries(FACE_KEYS.map(k=>[k,0]))
}
const DEFAULT_CARD_IMAGE='/images/card/gnome.png'
function newCustomCard(){
  return{id:`c-${Date.now()}-${Math.random().toString(36).slice(2)}`,values:emptyCardValues(),imageUrl:null}
}
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
function loadLastBoosterAt(){
  try{return Number(localStorage.getItem(LAST_BOOSTER_KEY)||0)}catch{return 0}
}
function saveLastBoosterAt(ts){
  try{localStorage.setItem(LAST_BOOSTER_KEY,String(ts))}catch{}
}
function msUntilNextBooster(lastAt){
  return Math.max(0,BOOSTER_COOLDOWN_MS-(Date.now()-(lastAt||0)))
}
function boosterCardRarity(total){
  return total>CARD_MAX_POINTS?'legendary':total>=33?'rare':total>=25?'uncommon':'common'
}
function genBoosterCardTotal(){
  const roll=Math.random()
  if(roll<0.007)return rnd(41,64)  // legendary — breaks the normal 40-pt cap, <1% chance
  if(roll<0.10)return rnd(33,40)   // rare
  if(roll<0.35)return rnd(25,32)   // uncommon
  return rnd(8,24)                 // common
}
function genBoosterCard(){
  const total=genBoosterCardTotal()
  const values=genValues(total)
  const rarity=boosterCardRarity(total)
  const imageUrl=pickCardImage(total)
  return{id:`bc-${Date.now()}-${Math.random().toString(36).slice(2)}`,values,imageUrl,rarity,total,obtainedAt:Date.now()}
}
function openBoosterPack(){
  return Array.from({length:4},()=>genBoosterCard())
}

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
function newGame(p1Deck,p2Deck) {
  return {
    board:Array(5).fill(null).map(()=>Array(5).fill(null)),
    players:{
      1:{hand:isDeckValid(p1Deck)?deckToHandCards(p1Deck,1):genDeck(1)},
      2:{hand:isDeckValid(p2Deck)?deckToHandCards(p2Deck,2):genDeck(2)},
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
function checkWin(game){if(cardCount(game,1)===0)return 2;if(cardCount(game,2)===0)return 1;return null}

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
  }catch(e){}
}

// ═══════════════════════════════════════════════════════════════════════════════
//  MUSIC — procedural ambient loop (A natural minor, arpeggiated)
// ═══════════════════════════════════════════════════════════════════════════════
let _audio = null
let _gameTrackIdx = 0
let _currentMode = null
const GAME_TRACKS = ['/musiques/music1.mp3', '/musiques/music2.mp3']

function _playNextGameTrack() {
  if (!_audio) return
  _audio.src = GAME_TRACKS[_gameTrackIdx]
  _audio.play().catch(() => {})
}

function startMusic(enabled, isMenu = false) {
  if (!enabled) { stopMusic(); return }
  const mode = isMenu ? 'menu' : 'game'
  if (_currentMode === mode && _audio && !_audio.paused) return
  stopMusic()
  _currentMode = mode
  _audio = new Audio()
  _audio.volume = 0.5
  if (isMenu) {
    _audio.src = '/musiques/menu.mp3'
    _audio.loop = true
    const tryPlay = () => _audio && _audio.play().catch(() => {})
    tryPlay()
    document.addEventListener('pointerdown', tryPlay, { once: true })
  } else {
    _audio.addEventListener('ended', () => {
      _gameTrackIdx = (_gameTrackIdx + 1) % GAME_TRACKS.length
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

// Snapshot of the board situation from cp's perspective
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
  return{myPts,oppPts,ptDelta:myPts-oppPts,myCards,oppCards,cardDelta:myCards-oppCards,cardsInDanger}
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

  // Hard rules — never suicide for nothing
  if(aDies&&!dDies) return -99999
  if(aDies&&dDies){
    if((sit?.myCards??9)<=2) return -99999           // can't afford card loss right now
    const stillValuable=cardPts(atk)>20               // our card still carries a lot of points
    if(!stillValuable) return 200+def.total*2         // take the kill even though we lose our card
    const gain=def.total-atk.total
    if(gain<10) return -99999                         // don't sacrifice a valuable card for a bad trade
    return gain*3                                     // only if clearly outvalued
  }

  let s=0
  if(dDies){
    s+=180+def.total*2
    if(cardTier(def)==='strong')s+=200  // huge bonus: killing a strong card is always worth it
    if((sit?.oppCards??9)<=2)s+=100
  } else {
    // Reward hitting low-value faces — brings them closer to death
    dk.forEach(k=>{
      const v=def.values[k]
      if(v===1)s+=95   // → 0 next attack kills
      else if(v===2)s+=50
      else if(v===3)s+=20
      else if(v<=5)s+=7
    })
  }
  // Penalise risk to attacker's own faces (slightly relaxed)
  ak.forEach(k=>{
    const v=atk.values[k]
    if(v===1)s-=45   // face becomes 0 = vulnerable next turn
    else if(v===2)s-=18
    else if(v===3)s-=6
  })
  // Slight aggression bonus when losing on points
  if((sit?.ptDelta??0)<-20)s+=18
  return s
}

function findBestAttack(game,cp,sit){
  let best=null,bestS=-25  // allow moderately risky non-lethal attacks
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
  let s=0
  // Row 3 = attack row, row 4 = safe back row
  s+=r===3?20:0
  // Center columns are more flexible
  s+=(2-Math.abs(c-2))*4
  // Hard penalty: don't place where opponent can instantly destroy a face
  if(wouldBePlacedInDanger(game,card,r,c))s-=150
  // Evaluate attack opportunity from this cell
  for(const[dr,dc]of[[-1,0],[1,0],[0,-1],[0,1]]){
    const nr=r+dr,nc=c+dc;if(nr<0||nr>=5||nc<0||nc>=5)continue
    const nb=game.board[nr][nc];if(!nb||nb.owner===card.owner)continue
    // Check damage we could deal next turn
    const[ourAtkFaces,theirFaces]=getContactKeys(r,c,nr,nc)
    theirFaces.forEach(k=>{
      const v=nb.values[k]
      if(v===0)s+=80
      else if(v===1)s+=40
      else if(v<=2)s+=15
    })
    // But also penalise risky exposure (less severe than instant death)
    const[_,ourExp]=getContactKeys(nr,nc,r,c)
    ourExp.forEach(k=>{
      const v=card.values[k]
      if(v===1)s-=30
      else if(v===2)s-=10
    })
  }
  s+=card.total*0.4
  // More aggressive when losing
  if((sit?.ptDelta??0)<-30&&r===3)s+=25
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

function scoreMove(game,fr,fc,tr,tc,card,cp){
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
  let s=dangerBefore-dangerAfter       // reward escaping danger
  s+=atkAfter*0.5                      // bonus for reaching attack position
  if(tr<fr)s+=8                        // slight bias toward advancing
  s-=5                                 // baseline cost so AI only moves for a reason
  return s
}

function findBestMove(game,cp){
  let best=null,bestS=-8  // move if marginally beneficial or to escape danger
  for(let fr=0;fr<5;fr++)for(let fc=0;fc<5;fc++){
    const card=game.board[fr][fc];if(!card||card.owner!==cp)continue
    for(let dr=-1;dr<=1;dr++)for(let dc=-1;dc<=1;dc++){
      if(dr===0&&dc===0)continue
      const tr=fr+dr,tc=fc+dc
      if(tr<0||tr>=5||tc<0||tc>=5)continue
      if(isCellBlocked(game,tr,tc)||game.board[tr][tc])continue
      const s=scoreMove(game,fr,fc,tr,tc,card,cp)
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

function computePowerTarget(game,cp,type,sit){
  if(type==='buff'){
    let best=null,bestS=-Infinity
    for(let r=0;r<5;r++)for(let c=0;c<5;c++){
      if(!isValidPowerTarget(game,'buff',cp,r,c))continue
      const card=game.board[r][c]
      const lost=Object.entries(card.values).reduce((sum,[k,v])=>sum+((card.baseValues?.[k]??v)-v),0)
      const danger=cardDangerScore(game,r,c,cp)
      const s=lost*15+danger*0.8+card.total*0.3
      if(s>10&&s>bestS){bestS=s;best={r,c}}
    }
    return best?{type:'power',powerType:'buff',...best}:null
  }
  if(type==='recall'){
    // Only recall a card that is genuinely in mortal danger
    let best=null,bestS=-Infinity
    for(let r=0;r<5;r++)for(let c=0;c<5;c++){
      if(!isValidPowerTarget(game,'recall',cp,r,c))continue
      const d=cardDangerScore(game,r,c,cp)
      if(d<50)continue   // not endangered enough
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
    return best&&bestS>25?{type:'power',powerType:'switch',...best}:null
  }
  if(type==='block'){
    // Only block once enemy has deployed — no point blocking an empty board
    const enemyDeployed=game.board.some(row=>row.some(c=>c&&c.owner!==cp))
    if(!enemyDeployed)return null
    for(const c of[2,1,3,0,4])for(const r of P1_ROWS)
      if(isValidPowerTarget(game,'block',cp,r,c))
        return{type:'power',powerType:'block',r,c}
    return null
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
        const s=d+scoreMove(game,fr,fc,tr,tc,card,cp)
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

  // Power cards
  if(powerCards.length>0){
    for(const type of['recall','buff','switch','block']){
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
    const m=findBestMove(game,cp)
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
      const nb=g.board.map(row=>[...row]);nb[tr][tc]=card;nb[fr][fc]=null
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
      {hasImg&&<img src={card.imageUrl} alt="" className="absolute inset-0 w-full h-full object-cover"/>}
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
function Cell({r,c,card,currentPlayer,actionsLeft,onDragStart,onDrop,onCellClick,onZoom,animKey,ghost,violent,targeting,game,onBoardTouchStart,compact=false}){
  const[over,setOver]=useState(false)
  const corner=isCorner(r,c),dynBlocked=isDynBlock(game,r,c),blocked=corner||dynBlocked
  const validTarget=targeting?isValidPowerTarget(game,targeting,currentPlayer,r,c):false
  let bg=blocked?'bg-slate-900/70':' bg-transparent'
  if(!blocked){
    if(targeting){if(!validTarget)bg='opacity-40';if(validTarget&&!over)bg='ring-1 ring-yellow-500/50';if(validTarget&&over)bg='bg-yellow-400/20 ring-2 ring-yellow-400 shadow-[0_0_16px_rgba(234,179,8,0.55)]'}
    else if(over)bg='bg-yellow-400/15 ring-1 ring-yellow-400/40'
  }
  const canDrag=!targeting&&card&&card.owner===currentPlayer&&(actionsLeft.moves>0||actionsLeft.attack>0)
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
      className={`${w} border-2 ${info.border} ${info.glow} rounded-xl bg-gradient-to-br ${info.bg} flex flex-col items-center justify-center gap-0.5 p-1 cursor-pointer select-none transition-all hover:scale-105 hover:brightness-110 ${isActive?'ring-2 ring-yellow-400 ring-offset-1 ring-offset-slate-900 scale-105':''} ${animClass}`}>
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
//  GAME SCREEN
// ═══════════════════════════════════════════════════════════════════════════════
function GameScreen({game,soundEnabled,myPlayer,isAI,onAction,onEndTurn,onHome,onPowerAction,onSurrender,lastAnim}){
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
  useEffect(()=>{
    if(!lastAnim)return
    const timers=[]
    lastAnim.cells.forEach(({r,c,ghost,anim,dur})=>{
      const key=`${r},${c}`
      if(ghost){
        setGhosts(p=>({...p,[key]:{card:ghost,anim}}))
        timers.push(setTimeout(()=>setGhosts(p=>{const n={...p};delete n[key];return n}),dur))
      }else{
        setAnims(p=>({...p,[key]:anim}))
        timers.push(setTimeout(()=>setAnims(p=>{const n={...p};delete n[key];return n}),dur))
      }
    })
    if(lastAnim.violent){
      const keys=lastAnim.cells.filter(c=>c.ghost).map(c=>`${c.r},${c.c}`)
      setViolentKeys(p=>{const n={...p};keys.forEach(k=>n[k]=true);return n})
      timers.push(setTimeout(()=>setViolentKeys(p=>{const n={...p};keys.forEach(k=>delete n[k]);return n}),700))
    }
    return()=>timers.forEach(clearTimeout)
  },[lastAnim])
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
  const badge=(label,count,color)=>`px-2.5 py-1 rounded-full text-xs font-bold border ${count>0?`bg-${color}-900/50 text-${color}-300 border-${color}-700`:'bg-slate-800/60 text-slate-600 border-slate-700/50'}`

  // Render function (not a component) — avoids remount-on-render which kills drag events
  const renderHand=(player,canDrag)=>{
    const isP1=player===1
    const activeColor=isP1?'text-blue-400':'text-red-400'
    const pts=isP1?p1pts:p2pts
    const label=isP1?'J1':(isAI?<span className="flex items-center gap-1"><Bot size={11}/>IA</span>:'J2')
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
          {!(players[player]?.hand?.length)&&<span className={`text-slate-600 text-xs ${compact?'w-[64px] py-3':'w-[142px] py-8'} text-center`}>vide</span>}
        </div>
      </div>
    )
  }

  return(
    <div className="game-outer min-h-screen bg-gradient-to-br from-slate-900 via-slate-900 to-slate-800 overflow-y-auto relative">
      <CardZoomOverlay card={zoomedCard} onClose={()=>setZoomedCard(null)} renderCard={c=><CardFace card={c} zoom/>}/>
      <button onClick={onHome} className="absolute top-3 left-3 z-10 text-slate-500 hover:text-white transition-colors"><Home size={18}/></button>
      <div className={`game-inner flex flex-col items-center ${compact?'gap-2 py-2':'gap-3 py-4'} px-2`} style={{zoom:gameScale,transformOrigin:'top center'}}>

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
              <Cell key={`${r}-${c}`} r={r} c={c} card={cell} currentPlayer={currentPlayer} actionsLeft={actionsLeft}
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
                className={`font-bold py-1.5 px-4 rounded-lg text-sm transition-colors ${canEndTurn?'bg-emerald-700 hover:bg-emerald-600 text-white':'bg-slate-700 text-slate-400 cursor-not-allowed opacity-60'}`}>
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
                  <button onClick={()=>{onSurrender(myPlayer??currentPlayer);setConfirmSurrender(false)}} className="bg-red-700 hover:bg-red-600 text-white font-bold py-0.5 px-2 rounded text-xs transition-colors">Oui</button>
                  <button onClick={()=>setConfirmSurrender(false)} className="bg-slate-700 hover:bg-slate-600 text-white font-bold py-0.5 px-2 rounded text-xs transition-colors">Non</button>
                </span>
              ):(
                <button onClick={()=>setConfirmSurrender(true)} className="text-slate-500 hover:text-red-400 text-xs transition-colors">⚑ Cap.</button>
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
      className="menu-fade-up w-full flex items-center gap-3 px-5 py-3.5 sm:py-3 rounded-lg transition-all duration-200 hover:scale-105 active:scale-95 select-none cursor-pointer"
      style={{...CINZEL, fontSize:'0.88rem', letterSpacing:'0.08em', animationDelay:delay,
        background:'linear-gradient(135deg,rgba(12,8,3,0.90),rgba(28,18,6,0.88))',
        border:`2px solid ${color}`, color,
        textShadow:`0 0 10px ${color}99`,
        boxShadow:`0 4px 18px rgba(0,0,0,0.65), inset 0 1px 0 rgba(255,255,255,0.06), 0 0 8px ${color}33`}}>
      {icon}<span>{children}</span>
    </button>
  )
}

// Small medieval-styled action button reused across the Deck Builder
function MedBtn({onClick, icon, color='#c9a020', children, className='', disabled=false, title, as='button'}){
  const Tag = as
  return(
    <Tag onClick={onClick} title={title} disabled={as==='button'?disabled:undefined}
      className={`inline-flex items-center justify-center gap-2 rounded-lg transition-all duration-200 select-none ${disabled?'opacity-40 cursor-not-allowed':'hover:scale-105 active:scale-95 cursor-pointer'} ${className}`}
      style={{...CINZEL, fontSize:'0.8rem', letterSpacing:'0.06em', padding:'0.55rem 1.1rem',
        background:'linear-gradient(135deg,rgba(12,8,3,0.90),rgba(28,18,6,0.88))',
        border:`2px solid ${color}`, color,
        textShadow:`0 0 8px ${color}99`,
        boxShadow:`0 3px 14px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.06), 0 0 6px ${color}33`}}>
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
      <span className="w-10 h-10 flex items-center justify-center rounded-full border-2"
        style={{borderColor:color, color, background:'rgba(10,7,3,0.8)', boxShadow:`0 0 10px ${color}55, inset 0 1px 0 rgba(255,255,255,0.06)`}}>
        {icon}
      </span>
      <span className="text-[10px] font-bold tracking-wide truncate max-w-full" style={{...CINZEL, color}}>{label}</span>
    </button>
  )
}

function MenuScreen({onLocal,onAI,onOnline,onRules,onDeckBuilder,onAccount,onBooster,user}){
  return(
    <div className="menu-screen relative flex flex-col items-center gap-4 px-4 overflow-hidden"
      style={{backgroundImage:'linear-gradient(rgba(6,6,10,0.20),rgba(6,6,10,0.20)),url(/images/menu.png)',backgroundSize:'cover',backgroundPosition:'center'}}>

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

      <div className="relative z-10 w-full max-w-md flex items-stretch justify-around gap-1 mb-1 px-2 py-2 rounded-2xl border border-amber-900/50"
        style={{background:'linear-gradient(135deg,rgba(10,7,3,0.85),rgba(20,13,5,0.82))', boxShadow:'0 4px 20px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.05)'}}>
        <MenuIconBtn onClick={onDeckBuilder} icon={<Layers size={18}/>} label="Decks" color="#34d399" delay="0.20s"/>
        {user
          ?<MenuIconBtn onClick={onBooster} icon={<Gift size={18}/>} label="Booster" color="#f472b6" delay="0.25s"/>
          :<MenuIconBtn onClick={onAccount} icon={<Lock size={16}/>} label="Booster" color="#64748b" delay="0.25s"/>
        }
        <MenuIconBtn onClick={onRules}   icon={<BookOpen size={18}/>}   label="Règles" color="#fbbf24" delay="0.30s"/>
        <MenuIconBtn onClick={onAccount} icon={<UserCircle size={18}/>} label={user?'Compte':'Connexion'} color="#38bdf8" delay="0.35s" title={user?(user.displayName||user.email):undefined}/>
      </div>
    </div>
  )
}
function RulesScreen({onBack}){
  const S=[
    ['🎴 Les cartes','Chaque carte a un chiffre sur chacune de ses 8 faces (haut, bas, les côtés, et les diagonales). Votre deck compte 6 cartes : deux plutôt faibles, deux moyennes et deux très puissantes. Vous pouvez créer les vôtres dans le Deck Builder, avec vos propres chiffres et même votre propre image.'],
    ['🎲 Le plateau','On joue sur une grille de 5 cases sur 5. Les 4 coins sont bloqués : personne ne peut y poser de carte. Vous démarrez en haut du plateau, votre adversaire en bas.'],
    ['⚡ Pendant votre tour','À chaque tour, vous pouvez poser une carte depuis votre main dans votre camp, déplacer deux cartes déjà en jeu (les déplacements en diagonale sont autorisés), et attaquer une fois une carte adverse juste à côté de la vôtre (seulement en haut, en bas, à gauche ou à droite — pas en diagonale). Vos pouvoirs spéciaux sont gratuits et ne comptent pas dans ces actions.'],
    ['💥 Le combat','Quand vous attaquez une carte voisine, vos deux cartes s\'affrontent sur les faces qui se touchent : chacune y perd 1 point. Si un chiffre tombe sous zéro, la carte est détruite.'],
    ['🃏 Les pouvoirs','En plus de vos cartes classiques, vous disposez de pouvoirs gratuits, à utiliser quand vous le souhaitez : Amplification renforce une carte alliée, Rappel la ramène dans votre main, Rotation fait tourner ses chiffres, et Barrage bloque définitivement une case vide du plateau.'],
    ['🤖 Face à l\'ordinateur','En mode Solo, votre adversaire est joué par une intelligence artificielle : elle pose, déplace, attaque et utilise ses pouvoirs toute seule.'],
    ['🏆 Comment gagner','Dès qu\'un joueur n\'a plus aucune carte, ni en main ni sur le plateau, la partie s\'arrête et son adversaire remporte la victoire.'],
  ]
  return(
    <div className="relative min-h-screen">
      <div className="fixed inset-0" aria-hidden="true"
        style={{backgroundImage:'linear-gradient(rgba(6,6,10,0.20),rgba(6,6,10,0.20)),url(/images/menu.png)',backgroundSize:'cover',backgroundPosition:'center'}}/>
      <div className="relative scrollbar-hide min-h-screen overflow-y-auto py-8 px-4 flex flex-col items-center">
        <div className="max-w-lg w-full">
          <button onClick={onBack} className="flex items-center gap-2 text-amber-400/80 hover:text-amber-300 drop-shadow-[0_1px_3px_rgba(0,0,0,0.9)] mb-6 transition-colors" style={CINZEL}><Home size={16}/> Menu</button>
          <h2 className="text-3xl font-black mb-5" style={{...CINZEL_DEC,background:'linear-gradient(to bottom,#ffe566,#c9a020)',WebkitBackgroundClip:'text',WebkitTextFillColor:'transparent',filter:'drop-shadow(0 1px 10px rgba(0,0,0,1))'}}>Règles du jeu</h2>
          {S.map(([t,d])=>(
            <div key={t} className="rounded-xl p-4 mb-3 border border-amber-900/40" style={{background:'rgba(8,5,2,0.78)'}}>
              <h3 className="text-amber-300 font-bold mb-1" style={CINZEL}>{t}</h3>
              <p className="text-slate-300 text-sm leading-relaxed">{d}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
//  DECK BUILDER SCREEN
// ═══════════════════════════════════════════════════════════════════════════════
function CardEditor({card,onUpdate,onRemove,otherDecks,onMoveCard,onZoom}){
  const isBooster=!!card.rarity
  const pts=customCardPts(card),over=!isBooster&&pts>CARD_MAX_POINTS
  const rarityTheme=isBooster?RARITY_THEME[card.rarity]:null
  function setVal(key,v){
    const n=Math.max(0,Math.min(9,Number(v)||0))
    onUpdate({values:{...card.values,[key]:n}})
  }
  function handleFile(e){
    const file=e.target.files?.[0];if(!file)return
    const reader=new FileReader()
    reader.onload=()=>{
      const img=new window.Image()
      img.onload=()=>{
        // Downscale to keep the stored data URI well under the localStorage quota —
        // raw phone photos (several MB) silently blow past it and saveDecks() then
        // fails without the image ever having actually persisted.
        const maxDim=480
        const scale=Math.min(1,maxDim/Math.max(img.width,img.height))
        const w=Math.max(1,Math.round(img.width*scale)),h=Math.max(1,Math.round(img.height*scale))
        const canvas=document.createElement('canvas')
        canvas.width=w;canvas.height=h
        canvas.getContext('2d').drawImage(img,0,0,w,h)
        onUpdate({imageUrl:canvas.toDataURL('image/jpeg',0.85)})
      }
      img.src=reader.result
    }
    reader.readAsDataURL(file)
  }
  return(
    <div className={`rounded-xl p-3 border ${over?'border-red-600':'border-amber-900/40'}`} style={{background:'rgba(8,5,2,0.78)'}}>
      <div className="flex gap-4">
        <div onClick={()=>onZoom?.(card)}
          className="w-[150px] h-[150px] shrink-0 rounded-lg border-2 border-amber-800/50 overflow-hidden relative bg-slate-800 cursor-zoom-in">
          <img src={card.imageUrl||DEFAULT_CARD_IMAGE} alt="" className="absolute inset-0 w-full h-full object-cover"/>
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
              <MedBtn as="label" color="#60a5fa" icon={<ImagePlus size={14}/>} className="w-fit">
                Image de fond
                <input type="file" accept="image/*" onChange={handleFile} className="hidden"/>
              </MedBtn>
              <input type="text" placeholder="...ou URL d'image" value={card.imageUrl&&!card.imageUrl.startsWith('data:')?card.imageUrl:''}
                onChange={e=>onUpdate({imageUrl:e.target.value||null})}
                className="bg-slate-800 text-slate-200 text-xs border border-slate-700 rounded px-2 py-1.5 outline-none focus:border-amber-500"/>
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
                    className={`text-[11px] px-2 py-0.5 rounded-md border transition-colors ${full?'border-slate-700 text-slate-600 cursor-not-allowed':'border-slate-600 text-slate-300 hover:border-amber-500 hover:text-amber-300'}`}>
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
function DeckEditor({deck,onBack,onRename,onAddCard,onRemoveCard,onUpdateCard,onSetDefault,otherDecks,onMoveCard}){
  const total=deckTotalPts(deck),overTotal=total>DECK_MAX_POINTS,valid=isDeckValid(deck)
  const atMaxCards=deck.cards.length>=DECK_MAX_CARDS
  const[zoomedCard,setZoomedCard]=useState(null)
  return(
    <div className="min-h-screen py-8 px-4 flex flex-col items-center overflow-y-auto"
      style={{backgroundImage:'linear-gradient(rgba(6,6,10,0.20),rgba(6,6,10,0.20)),url(/images/menu.png)',backgroundSize:'cover',backgroundPosition:'center'}}>
      <CardZoomOverlay card={zoomedCard} onClose={()=>setZoomedCard(null)}/>
      <div className="max-w-lg w-full">
        <button onClick={onBack} className="flex items-center gap-2 text-amber-400/80 hover:text-amber-300 drop-shadow-[0_1px_3px_rgba(0,0,0,0.9)] mb-4 transition-colors" style={CINZEL}><Home size={16}/> Decks</button>
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
              otherDecks={otherDecks} onMoveCard={toDeckId=>onMoveCard(c.id,toDeckId)} onZoom={setZoomedCard}/>
          ))}
          {deck.cards.length===0&&<p className="text-slate-300 text-sm text-center py-6 drop-shadow-[0_1px_3px_rgba(0,0,0,0.9)]">Aucune carte. Ajoutez-en une.</p>}
        </div>
        <MedBtn onClick={onAddCard} disabled={atMaxCards} color="#34d399" icon={<Plus size={16}/>} className="w-full">
          {atMaxCards?`Deck complet (${DECK_MAX_CARDS} max)`:'Ajouter une carte'}
        </MedBtn>
      </div>
    </div>
  )
}
function DeckBuilderScreen({onBack,user}){
  const[decks,setDecks]=useState(()=>loadDecks())
  const[editingId,setEditingId]=useState(null)
  const cloudReadyRef=useRef(false)
  useEffect(()=>{
    saveDecks(decks)
    if(user&&cloudReadyRef.current)saveCloudDecks(user.uid,decks).catch(()=>{})
  },[decks])
  useEffect(()=>{
    cloudReadyRef.current=false
    if(!user){cloudReadyRef.current=true;return}
    loadCloudDecks(user.uid).then(cloud=>{
      // Merge instead of overwrite — decks created on another device (or before
      // ever logging in here) must not be wiped by this device's cloud fetch.
      const merged=mergeById(decks,cloud)
      cloudReadyRef.current=true
      setDecks(merged)
      saveCloudDecks(user.uid,merged).catch(()=>{})
    }).catch(()=>{cloudReadyRef.current=true})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[user?.uid])
  const editing=decks.find(d=>d.id===editingId)

  function createDeck(){
    const d={id:`d-${Date.now()}`,name:`Deck ${decks.length+1}`,cards:[],isDefault:false,updatedAt:Date.now()}
    setDecks(p=>[...p,d]);setEditingId(d.id)
  }
  function deleteDeck(id){setDecks(p=>p.filter(d=>d.id!==id))}
  function setDefault(id){setDecks(p=>p.map(d=>({...d,isDefault:d.id===id,updatedAt:Date.now()})))}
  function renameDeck(id,name){setDecks(p=>p.map(d=>d.id===id?{...d,name,updatedAt:Date.now()}:d))}
  function addCard(id){setDecks(p=>p.map(d=>d.id===id&&d.cards.length<DECK_MAX_CARDS?{...d,cards:[...d.cards,newCustomCard()],updatedAt:Date.now()}:d))}
  function removeCard(id,cardId){setDecks(p=>p.map(d=>d.id===id?{...d,cards:d.cards.filter(c=>c.id!==cardId),updatedAt:Date.now()}:d))}
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
      onAddCard={()=>addCard(editing.id)} onRemoveCard={cid=>removeCard(editing.id,cid)}
      onUpdateCard={(cid,patch)=>updateCard(editing.id,cid,patch)} onSetDefault={()=>setDefault(editing.id)}
      otherDecks={decks.filter(d=>d.id!==editing.id).map(d=>({id:d.id,name:d.name,cardCount:d.cards.length}))}
      onMoveCard={(cardId,toId)=>moveCardToDeck(editing.id,cardId,toId)}/>
  )

  return(
    <div className="min-h-screen py-8 px-4 flex flex-col items-center overflow-y-auto"
      style={{backgroundImage:'linear-gradient(rgba(6,6,10,0.20),rgba(6,6,10,0.20)),url(/images/menu.png)',backgroundSize:'cover',backgroundPosition:'center'}}>
      <div className="max-w-lg w-full">
        <button onClick={onBack} className="flex items-center gap-2 text-amber-400/80 hover:text-amber-300 drop-shadow-[0_1px_3px_rgba(0,0,0,0.9)] mb-6 transition-colors" style={CINZEL}><Home size={16}/> Menu</button>
        <h2 className="text-3xl font-black mb-1" style={{...CINZEL_DEC,background:'linear-gradient(to bottom,#ffe566,#c9a020)',WebkitBackgroundClip:'text',WebkitTextFillColor:'transparent',filter:'drop-shadow(0 1px 10px rgba(0,0,0,1))'}}>Deck Builder</h2>
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
  legendary:{label:'Légendaire',  color:'#fbbf24'},
}
function BoosterCardFace({card,animate=false,revealed=true,size='normal',onClick}){
  const rarity=card.rarity||'common'
  const theme=RARITY_THEME[rarity]
  const isRare=rarity==='rare'||rarity==='legendary'
  const pts=FACE_KEYS.reduce((s,k)=>s+(card.values[k]||0),0)
  const animClass=animate?(revealed?(isRare?'card-reveal-rare':'card-reveal'):'opacity-0'):(isRare?'rare-glow':'')
  const dim=size==='small'?'w-[68px] h-[68px]':size==='large'?'w-[88vw] h-[88vw] max-w-[420px] max-h-[420px]':'w-[104px] h-[104px]'
  const textSz=size==='small'?'text-[9px]':size==='large'?'text-[30px]':'text-[11px]'
  const labelSz=size==='small'?'text-[7px]':size==='large'?'text-lg':'text-[9px]'
  return(
    <div onClick={onClick} className={`${dim} rounded-xl border-2 relative overflow-hidden shrink-0 ${animClass} ${onClick?'cursor-zoom-in':''}`}
      style={{borderColor:theme.color,background:'#1e293b'}}>
      <img src={card.imageUrl||DEFAULT_CARD_IMAGE} alt="" className="absolute inset-0 w-full h-full object-cover"/>
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
  return(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm" onClick={onClose}>
      <div className="flex flex-col items-center gap-3 select-none">
        <div className="relative flex items-center justify-center zoom-card-perspective">
          <div className="absolute inset-0 m-auto zoom-aura rounded-full pointer-events-none" style={{width:'135%',height:'135%'}}/>
          <div className="zoom-card-idle">
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
// Union by id (cloud wins on a collision) — keeps cards/decks pulled on ANY device
// instead of one device's data silently replacing the other's on login.
function mergeById(localList,cloudList){
  const map=new Map()
  ;(cloudList||[]).forEach(item=>map.set(item.id,item))
  // On a collision, keep whichever side was actually edited more recently instead of
  // always trusting the cloud — otherwise a cloud snapshot that's merely OLDER (e.g.
  // synced just before this device's last edit went out) permanently wipes that edit,
  // which is exactly how a freshly added custom card image could vanish.
  ;(localList||[]).forEach(item=>{
    const existing=map.get(item.id)
    if(!existing||(item.updatedAt||0)>(existing.updatedAt||0))map.set(item.id,item)
  })
  return Array.from(map.values())
}
function BoosterScreen({onBack,user}){
  const[collection,setCollection]=useState(()=>loadCollection())
  const[decks,setDecks]=useState(()=>loadDecks())
  const[lastBoosterAt,setLastBoosterAt]=useState(()=>loadLastBoosterAt())
  const[opening,setOpening]=useState(false)
  const[pendingCards,setPendingCards]=useState(null)
  const[revealCount,setRevealCount]=useState(0)
  const[,setNow]=useState(()=>Date.now())
  const[zoomedCard,setZoomedCard]=useState(null)
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
    cloudReadyRef.current=false
    if(!user){cloudReadyRef.current=true;return}
    Promise.all([loadCloudCollection(user.uid),loadCloudDecks(user.uid),loadCloudLastBooster(user.uid)]).then(([cCollection,cDecks,cLast])=>{
      // Merge instead of overwrite — a device that pulled boosters offline (or
      // before ever logging in) must not have its cards wiped by another
      // device's cloud state; both converge to the union of both.
      const mergedCollection=mergeById(collection,cCollection)
      const mergedDecks=mergeById(decks,cDecks)
      cloudReadyRef.current=true
      setCollection(mergedCollection)
      setDecks(mergedDecks)
      saveCloudCollection(user.uid,mergedCollection).catch(()=>{})
      saveCloudDecks(user.uid,mergedDecks).catch(()=>{})
      if(cLast)setLastBoosterAt(prev=>Math.max(prev,cLast))
    }).catch(()=>{cloudReadyRef.current=true})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[user?.uid])
  useEffect(()=>{
    const t=setInterval(()=>setNow(Date.now()),1000)
    return()=>clearInterval(t)
  },[])
  useEffect(()=>()=>{timersRef.current.forEach(clearTimeout)},[])

  const remainingMs=msUntilNextBooster(lastBoosterAt)
  const canOpen=remainingMs<=0&&!opening&&!pendingCards
  const allRevealed=pendingCards&&revealCount>=pendingCards.length
  const displayCollection=pendingCards?collection.filter(c=>!pendingCards.some(p=>p.id===c.id)):collection

  function handleOpenBooster(){
    if(!canOpen)return
    setOpening(true)
    timersRef.current.push(setTimeout(()=>{
      const cards=openBoosterPack()
      setPendingCards(cards)
      setCollection(c=>[...c,...cards]) // persist immediately — nothing lost if the user navigates away mid-reveal
      setOpening(false)
      setRevealCount(0)
      cards.forEach((_,i)=>{
        timersRef.current.push(setTimeout(()=>setRevealCount(n=>Math.max(n,i+1)),i*650))
      })
      const ts=Date.now()
      setLastBoosterAt(ts);saveLastBoosterAt(ts)
      if(user)saveCloudLastBooster(user.uid,ts).catch(()=>{})
    },900))
  }
  function handleCloseReveal(){setPendingCards(null);setRevealCount(0)}
  function handleAssignToDeck(cardId,deckId){
    const card=collection.find(c=>c.id===cardId);if(!card)return
    const deck=decks.find(d=>d.id===deckId);if(!deck||deck.cards.length>=DECK_MAX_CARDS)return
    setCollection(c=>c.filter(x=>x.id!==cardId))
    setDecks(ds=>ds.map(d=>d.id===deckId?{...d,cards:[...d.cards,card],updatedAt:Date.now()}:d))
  }

  const bg={backgroundImage:'linear-gradient(rgba(6,6,10,0.20),rgba(6,6,10,0.20)),url(/images/menu.png)',backgroundSize:'cover',backgroundPosition:'center'}

  if(!user)return(
    <div className="min-h-screen flex flex-col items-center justify-center gap-5 px-4" style={bg}>
      <div className="text-6xl select-none">🔒</div>
      <p className="text-amber-300 font-bold text-xl text-center drop-shadow-[0_1px_4px_rgba(0,0,0,0.9)]" style={CINZEL}>Connexion requise</p>
      <p className="text-slate-300 text-sm text-center max-w-xs drop-shadow-[0_1px_3px_rgba(0,0,0,0.9)]">Connectez-vous pour accéder aux boosters de cartes quotidiens et sauvegarder votre collection.</p>
      <MedBtn onClick={onBack} color="#c9a020" icon={<Home size={14}/>}>Retour au menu</MedBtn>
    </div>
  )

  return(
    <div className="min-h-screen pt-14 pb-8 px-4 flex flex-col items-center overflow-y-auto" style={bg}>
      {/* Fixed back button */}
      <button onClick={onBack} className="fixed top-3 left-3 z-20 flex items-center gap-1.5 text-amber-400/90 hover:text-amber-300 drop-shadow-[0_1px_3px_rgba(0,0,0,0.9)] transition-colors rounded-lg px-2.5 py-1.5" style={{...CINZEL,background:'rgba(0,0,0,0.55)',backdropFilter:'blur(6px)'}}><Home size={15}/> Menu</button>

      <CardZoomOverlay card={zoomedCard} onClose={()=>setZoomedCard(null)}/>

      <div className="max-w-lg w-full">
        <h2 className="text-3xl font-black mb-1" style={{...CINZEL_DEC,background:'linear-gradient(to bottom,#ffe566,#c9a020)',WebkitBackgroundClip:'text',WebkitTextFillColor:'transparent',filter:'drop-shadow(0 1px 10px rgba(0,0,0,1))'}}>Booster de Cartes</h2>
        <p className="text-xs mb-5 text-slate-300 drop-shadow-[0_1px_3px_rgba(0,0,0,0.9)]">
          Un booster gratuit de 4 cartes chaque jour. Très rarement (&lt;1%), une carte peut dépasser les {CARD_MAX_POINTS} pts habituels !
        </p>

        <div className="rounded-xl p-6 mb-6 border border-amber-900/40 flex flex-col items-center gap-4 min-h-[220px] justify-center" style={{background:'rgba(8,5,2,0.78)'}}>
          {!pendingCards&&(
            <>
              <button onClick={handleOpenBooster} disabled={!canOpen}
                className={`relative w-28 h-36 rounded-2xl border-4 flex items-center justify-center transition-transform ${
                  opening?'border-amber-400 booster-pack-opening'
                    :canOpen?'border-amber-400 booster-pack-idle cursor-pointer hover:scale-105'
                    :'border-slate-700 opacity-50 cursor-not-allowed'}`}
                style={{background:'linear-gradient(135deg,#3b0764,#1e1b4b)'}}>
                <Gift size={44} className={canOpen||opening?'text-amber-300':'text-slate-500'}/>
              </button>
              {canOpen
                ?<p className="text-amber-300 font-bold" style={CINZEL}>Ouvrir le booster du jour</p>
                :<p className="text-slate-400 text-sm">Prochain booster dans {formatDuration(remainingMs)}</p>}
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
                </div>
              ))}
            </div>
          )}
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
    <div className="min-h-screen py-8 px-4 flex flex-col items-center overflow-y-auto"
      style={{backgroundImage:'linear-gradient(rgba(6,6,10,0.20),rgba(6,6,10,0.20)),url(/images/menu.png)',backgroundSize:'cover',backgroundPosition:'center'}}>
      <div className="max-w-lg w-full">
        <button onClick={onBack} className="flex items-center gap-2 text-amber-400/80 hover:text-amber-300 drop-shadow-[0_1px_3px_rgba(0,0,0,0.9)] mb-6 transition-colors" style={CINZEL}><Home size={16}/> Menu</button>
        <h2 className="text-3xl font-black mb-2" style={{...CINZEL_DEC,background:'linear-gradient(to bottom,#ffe566,#c9a020)',WebkitBackgroundClip:'text',WebkitTextFillColor:'transparent',filter:'drop-shadow(0 1px 10px rgba(0,0,0,1))'}}>Choisissez votre deck</h2>
        {DECKSELECT_SUBTITLE[mode]&&<p className="text-slate-300 text-sm mb-5 drop-shadow-[0_1px_3px_rgba(0,0,0,0.9)]">{DECKSELECT_SUBTITLE[mode]}</p>}
        <div className="flex flex-col gap-3">
          <button onClick={()=>onSelect(null)} className="rounded-xl p-4 border border-amber-900/40 text-left transition-colors hover:border-amber-500" style={{background:'rgba(8,5,2,0.78)'}}>
            <span className="text-amber-200 font-bold" style={CINZEL}>Deck aléatoire</span>
            <p className="text-slate-400 text-xs mt-0.5">6 cartes générées aléatoirement (2 faibles, 2 moyennes, 2 fortes)</p>
          </button>
          {decks.map(d=>{
            const total=deckTotalPts(d)
            return(
              <button key={d.id} onClick={()=>onSelect(d)} className="rounded-xl p-4 border border-amber-900/40 text-left transition-colors hover:border-amber-500 flex items-center gap-2" style={{background:'rgba(8,5,2,0.78)'}}>
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
function AccountScreen({onBack,user,stats}){
  const[authMode,setAuthMode]=useState('login') // 'login'|'register'
  const[email,setEmail]=useState('');const[password,setPassword]=useState('')
  const[error,setError]=useState('');const[loading,setLoading]=useState(false)

  async function handleEmailSubmit(e){
    e.preventDefault();setError('');setLoading(true)
    try{authMode==='register'?await registerWithEmail(email,password):await loginWithEmail(email,password)}
    catch(err){setError(err.message)}
    setLoading(false)
  }
  async function handleGoogle(){
    setError('');setLoading(true)
    try{await loginWithGoogle()}catch(err){setError(err.message)}
    setLoading(false)
  }
  const total=stats?.gamesPlayed||0
  return(
    <div className="min-h-screen py-8 px-4 flex flex-col items-center overflow-y-auto"
      style={{backgroundImage:'linear-gradient(rgba(6,6,10,0.20),rgba(6,6,10,0.20)),url(/images/menu.png)',backgroundSize:'cover',backgroundPosition:'center'}}>
      <div className="max-w-sm w-full">
        <button onClick={onBack} className="flex items-center gap-2 text-amber-400/80 hover:text-amber-300 drop-shadow-[0_1px_3px_rgba(0,0,0,0.9)] mb-6 transition-colors" style={CINZEL}><Home size={16}/> Menu</button>
        <h2 className="text-3xl font-black mb-5" style={{...CINZEL_DEC,background:'linear-gradient(to bottom,#ffe566,#c9a020)',WebkitBackgroundClip:'text',WebkitTextFillColor:'transparent',filter:'drop-shadow(0 1px 10px rgba(0,0,0,1))'}}>Mon Compte</h2>

        {user?(
          <div className="rounded-xl p-4 mb-4 border border-amber-900/40" style={{background:'rgba(8,5,2,0.78)'}}>
            <div className="flex items-center gap-2 mb-4">
              <UserCircle size={22} className="text-amber-400 shrink-0"/>
              <span className="text-amber-200 font-bold truncate" style={CINZEL}>{user.displayName||user.email}</span>
            </div>
            <div className="grid grid-cols-3 gap-2 text-center mb-4">
              <div><div className="text-xl font-black text-amber-300">{total}</div><div className="text-[10px] text-slate-400 uppercase tracking-wide">Parties</div></div>
              <div><div className="text-xl font-black text-emerald-400">{stats?.wins||0}</div><div className="text-[10px] text-slate-400 uppercase tracking-wide">Victoires</div></div>
              <div><div className="text-xl font-black text-red-400">{stats?.losses||0}</div><div className="text-[10px] text-slate-400 uppercase tracking-wide">Défaites</div></div>
            </div>
            <MedBtn onClick={()=>logout()} color="#ef4444" icon={<LogOut size={14}/>} className="w-full">Se déconnecter</MedBtn>
          </div>
        ):(
          <div className="rounded-xl p-4 mb-4 border border-amber-900/40" style={{background:'rgba(8,5,2,0.78)'}}>
            <div className="flex gap-2 mb-3">
              <button type="button" onClick={()=>setAuthMode('login')}
                className={`flex-1 text-xs font-bold py-1.5 rounded-lg transition-colors ${authMode==='login'?'bg-amber-600/30 text-amber-300':'text-slate-400 hover:text-white'}`} style={CINZEL}>Connexion</button>
              <button type="button" onClick={()=>setAuthMode('register')}
                className={`flex-1 text-xs font-bold py-1.5 rounded-lg transition-colors ${authMode==='register'?'bg-amber-600/30 text-amber-300':'text-slate-400 hover:text-white'}`} style={CINZEL}>Créer un compte</button>
            </div>
            <form onSubmit={handleEmailSubmit} className="flex flex-col gap-2 mb-3">
              <label className="flex items-center gap-2 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 focus-within:border-amber-500">
                <Mail size={14} className="text-slate-500 shrink-0"/>
                <input type="email" required autoComplete="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="Email" className="bg-transparent text-slate-200 text-sm outline-none flex-1 min-w-0"/>
              </label>
              <label className="flex items-center gap-2 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 focus-within:border-amber-500">
                <Lock size={14} className="text-slate-500 shrink-0"/>
                <input type="password" required minLength={6} autoComplete={authMode==='register'?'new-password':'current-password'} value={password} onChange={e=>setPassword(e.target.value)} placeholder="Mot de passe" className="bg-transparent text-slate-200 text-sm outline-none flex-1 min-w-0"/>
              </label>
              {error&&<p className="text-red-400 text-xs">{error}</p>}
              <MedBtn color="#60a5fa" icon={<LogIn size={14}/>} className="w-full" disabled={loading}>
                {authMode==='register'?'Créer mon compte':'Se connecter'}
              </MedBtn>
            </form>
            <div className="flex items-center gap-2 my-3"><div className="flex-1 h-px bg-slate-700"/><span className="text-slate-500 text-[10px] uppercase">ou</span><div className="flex-1 h-px bg-slate-700"/></div>
            <MedBtn onClick={handleGoogle} disabled={loading} color="#e5e7eb" icon={<span className="text-sm font-black">G</span>} className="w-full">Continuer avec Google</MedBtn>
          </div>
        )}

        <div className="rounded-xl p-4 border border-amber-900/40" style={{background:'rgba(8,5,2,0.78)'}}>
          <h3 className="text-amber-300 font-bold mb-1 text-sm" style={CINZEL}>Application</h3>
          <p className="text-slate-400 text-xs mb-3">En cas d'affichage figé après une mise à jour du jeu, videz le cache pour forcer le rechargement de la dernière version.</p>
          <MedBtn onClick={forceClearCacheAndReload} color="#fbbf24" icon={<RefreshCw size={14}/>} className="w-full">Vider le cache & recharger</MedBtn>
        </div>
      </div>
    </div>
  )
}
function OnlineLobbyScreen({onBack,onGameStart,deck}){
  const[mode,setMode]=useState(null)
  const[code,setCode]=useState('')
  const[inputCode,setInputCode]=useState('')
  const[waiting,setWaiting]=useState(false)
  const[error,setError]=useState('')
  const[copied,setCopied]=useState(false)
  const[initialGame]=useState(()=>newGame(deck,null))
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
      await createRoom(c,initialGame);setWaiting(true)
      unsubRef.current=subscribeRoom(c,data=>{
        if(data.player2Joined){
          if(unsubRef.current){unsubRef.current();unsubRef.current=null}
          onGameStart(data.state??initialGame,c,1)
        }
      })
    }catch(e){setError('Firebase non configuré — renseignez src/firebase.js')}
  }
  async function handleJoin(){
    setError('');const c=inputCode.trim().toUpperCase()
    if(c.length!==6){setError('Code invalide.');return}
    try{
      const state=await joinRoom(c)
      if(!state){setError('Partie introuvable.');return}
      setCode(c);setWaiting(true)
      unsubRef.current=subscribeRoom(c,data=>{
        if(data.state){
          if(unsubRef.current){unsubRef.current();unsubRef.current=null}
          onGameStart(data.state,c,2)
        }
      })
    }catch(e){setError('Firebase non configuré — renseignez src/firebase.js')}
  }
  async function handleMatchmaking(){
    setError('');setMode('matchmaking')
    const myId=crypto.randomUUID()
    mmIdRef.current=myId
    try{
      const res=await joinMatchmaking(myId)
      if(mmIdRef.current!==myId)return // cancelled while the request was in flight
      if(res.role==='host'){
        const c=genRoomCode()
        await createRoom(c,initialGame)
        await publishMatchResult(res.opponentId,c)
        mmIdRef.current=null
        onGameStart(initialGame,c,1)
      }else{
        mmUnsubRef.current=subscribeMatchResult(myId,async result=>{
          if(mmUnsubRef.current){mmUnsubRef.current();mmUnsubRef.current=null}
          mmIdRef.current=null
          clearMatchResult(myId).catch(()=>{})
          const state=await joinRoom(result.code)
          onGameStart(state??initialGame,result.code,2)
        })
      }
    }catch(e){setError('Firebase non configuré — renseignez src/firebase.js');mmIdRef.current=null;setMode(null)}
  }
  function handleCancelMatchmaking(){stopMatchmaking();setMode(null)}
  function copyCode(){navigator.clipboard.writeText(code).then(()=>{setCopied(true);setTimeout(()=>setCopied(false),2000)})}

  const bg={backgroundImage:'linear-gradient(rgba(6,6,10,0.20),rgba(6,6,10,0.20)),url(/images/menu.png)',backgroundSize:'cover',backgroundPosition:'center'}

  if(waiting)return(
    <div className="min-h-screen flex flex-col items-center justify-center gap-6" style={bg}>
      <div className="text-4xl animate-spin">⚙</div>
      <p className="text-white text-xl font-bold drop-shadow-[0_1px_3px_rgba(0,0,0,0.9)]">Code : <span className="text-purple-400 tracking-widest font-black">{code}</span></p>
      <p className="text-slate-300 animate-pulse drop-shadow-[0_1px_3px_rgba(0,0,0,0.9)]">En attente du joueur 2…</p>
      <button onClick={copyCode} className="flex items-center gap-2 text-slate-300 hover:text-white bg-slate-700 hover:bg-slate-600 py-2 px-4 rounded-lg transition-colors text-sm">{copied?<><Check size={14}/> Copié !</>:<><Copy size={14}/> Copier le code</>}</button>
      <button onClick={()=>{setWaiting(false);setMode(null)}} className="text-slate-300 hover:text-slate-100 text-sm drop-shadow-[0_1px_3px_rgba(0,0,0,0.9)]">Annuler</button>
    </div>
  )

  if(mode==='matchmaking')return(
    <div className="min-h-screen flex flex-col items-center justify-center gap-6 px-4 text-center" style={bg}>
      <div className="text-4xl animate-spin">⚔</div>
      <p className="text-white text-xl font-bold drop-shadow-[0_1px_3px_rgba(0,0,0,0.9)]">Recherche d'un adversaire…</p>
      <p className="text-slate-300 text-sm max-w-xs drop-shadow-[0_1px_3px_rgba(0,0,0,0.9)]">La partie démarre automatiquement dès qu'un autre joueur rejoint le matchmaking.</p>
      {error&&<p className="text-red-400 text-sm bg-red-900/30 px-4 py-2 rounded-lg text-center max-w-sm">{error}</p>}
      <button onClick={handleCancelMatchmaking} className="text-slate-300 hover:text-slate-100 text-sm drop-shadow-[0_1px_3px_rgba(0,0,0,0.9)]">Annuler</button>
    </div>
  )

  return(
    <div className="min-h-screen flex flex-col items-center justify-center gap-6 px-4 relative" style={bg}>
      <button onClick={onBack} className="absolute top-4 left-4 text-amber-400/80 hover:text-amber-300 drop-shadow-[0_1px_3px_rgba(0,0,0,0.9)] transition-colors"><Home size={20}/></button>
      <h2 className="text-3xl font-black" style={{...CINZEL_DEC,background:'linear-gradient(to bottom,#ffe566,#c9a020)',WebkitBackgroundClip:'text',WebkitTextFillColor:'transparent',filter:'drop-shadow(0 1px 10px rgba(0,0,0,1))'}}>Partie en Ligne</h2>
      {error&&<p className="text-red-400 text-sm bg-red-900/30 px-4 py-2 rounded-lg text-center max-w-sm">{error}</p>}
      {!mode&&(
        <div className="flex flex-col items-center gap-4">
          <button onClick={handleMatchmaking} className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-3 px-6 rounded-xl transition-all hover:scale-105"><Swords size={18}/> Trouver une partie</button>
          <div className="flex gap-4">
            <button onClick={handleCreate} className="bg-blue-600 hover:bg-blue-500 text-white font-bold py-3 px-6 rounded-xl transition-all hover:scale-105">Créer</button>
            <button onClick={()=>setMode('join')} className="bg-purple-600 hover:bg-purple-500 text-white font-bold py-3 px-6 rounded-xl transition-all hover:scale-105">Rejoindre</button>
          </div>
        </div>
      )}
      {mode==='join'&&(
        <div className="bg-slate-800 rounded-2xl p-6 border border-slate-700 w-72">
          <p className="text-slate-400 text-sm mb-2">Code de la partie :</p>
          <input value={inputCode} onChange={e=>setInputCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,6))} className="bg-slate-700 text-white font-black text-2xl tracking-widest text-center border border-slate-600 rounded-lg px-4 py-2 w-full outline-none focus:border-purple-500 mb-3" placeholder="XXXXXX" maxLength={6}/>
          <button onClick={handleJoin} disabled={inputCode.length!==6} className="w-full bg-purple-600 hover:bg-purple-500 disabled:opacity-40 text-white font-bold py-2 rounded-lg transition-colors">Rejoindre</button>
          <button onClick={()=>setMode(null)} className="w-full text-slate-500 hover:text-slate-300 text-sm mt-2">Retour</button>
        </div>
      )}
    </div>
  )
}
function GameOverScreen({winner,isAI,surrendered,onReplay,onMenu}){
  const loser=winner===1?2:1
  const winLabel=isAI&&winner===2?'L\'IA':`Joueur ${winner}`
  const msg=surrendered
    ?`Joueur ${loser} a capitulé.`
    :isAI&&winner===2?'L\'IA a éliminé toutes vos cartes.':'L\'adversaire n\'a plus aucune carte.'
  return(<div className="min-h-screen bg-gradient-to-br from-slate-900 to-slate-800 flex flex-col items-center justify-center gap-5"><div className="text-7xl mb-2 animate-bounce">{surrendered?'🏳️':'🏆'}</div><h2 className="text-4xl font-black text-white"><span className={winner===1?'text-blue-400':'text-red-400'}>{winLabel}</span> gagne !</h2><p className="text-slate-400">{msg}</p><div className="flex gap-4 mt-4"><button onClick={onReplay} className="bg-blue-600 hover:bg-blue-500 text-white font-bold py-3 px-7 rounded-xl transition-all hover:scale-105 flex items-center gap-2 shadow-lg"><Play size={18}/> Rejouer</button><button onClick={onMenu} className="bg-slate-700 hover:bg-slate-600 text-white font-bold py-3 px-7 rounded-xl transition-all hover:scale-105 flex items-center gap-2 shadow-lg"><Home size={18}/> Menu</button></div></div>)
}
function SoundToggle({enabled,onToggle}){
  return(<button onClick={onToggle} className="fixed top-3 right-3 z-50 text-slate-400 hover:text-white bg-slate-800/80 backdrop-blur-sm p-2 rounded-lg transition-colors">{enabled?<Volume2 size={18}/>:<VolumeX size={18}/>}</button>)
}

// ═══════════════════════════════════════════════════════════════════════════════
//  MAIN APP
// ═══════════════════════════════════════════════════════════════════════════════
export default function App(){
  const[screen,setScreen]=useState('menu')
  const[game,setGame]=useState(null)
  const[soundOn,setSoundOn]=useState(loadSoundPref)
  const[gameMode,setGameMode]=useState('local') // 'local'|'ai'|'online'
  const[roomCode,setRoomCode]=useState(null)
  const[myPlayer,setMyPlayer]=useState(null)
  const[pendingMode,setPendingMode]=useState(null) // mode awaiting a deck choice
  const[chosenDeck,setChosenDeck]=useState(null) // deck selected for the next match (null = random)
  const[user,setUser]=useState(null)
  const[stats,setStats]=useState(null)
  const[lastAnim,setLastAnim]=useState(null)
  const ignoreNextRef=useRef(false)
  const unsubRef=useRef(null)
  const gameRef=useRef(game)
  const soundOnRef=useRef(soundOn)
  const aiTimerRef=useRef(null)
  const statsRecordedRef=useRef(false)
  const animSeqRef=useRef(0)
  function nextAnimSeq(){animSeqRef.current+=1;return animSeqRef.current}

  useEffect(()=>{gameRef.current=game},[game])
  useEffect(()=>{soundOnRef.current=soundOn;saveSoundPref(soundOn)},[soundOn])
  useEffect(()=>()=>{if(unsubRef.current)unsubRef.current()},[])

  // ── Account ───────────────────────────────────────────────────
  useEffect(()=>onAuthChange(setUser),[])
  useEffect(()=>{
    if(!user){setStats(null);return}
    return subscribeStats(user.uid,setStats)
  },[user?.uid])
  // Record win/loss once a match tied to a real opponent (AI or online) ends
  useEffect(()=>{
    if(screen==='gameover'&&game?.winner&&!statsRecordedRef.current){
      statsRecordedRef.current=true
      if(user&&(gameMode==='ai'||gameMode==='online')){
        const iWon=gameMode==='ai'?game.winner===1:game.winner===myPlayer
        recordGameResult(user.uid,iWon).catch(()=>{})
      }
    }
    if(screen!=='gameover')statsRecordedRef.current=false
  },[screen])

  // ── Music ─────────────────────────────────────────────────────
  useEffect(()=>{
    if(screen==='game') startMusic(soundOn, false)
    else if(['menu','rules','online','deckselect','account','booster','deckbuilder'].includes(screen)) startMusic(soundOn, true)
    else stopMusic()
  },[screen,soundOn])
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

  function syncOnline(g){ignoreNextRef.current=true;pushState(roomCode,g).catch(console.warn)}

  // ── Action handler ───────────────────────────────────────────
  function handleAction({drag,targetR,targetC}){
    if(!game)return
    let g=game;const cp=g.currentPlayer,al=g.actionsLeft;let cells=null,violent=false
    if(drag.from==='hand'){
      if(al.placement<=0||drag.player!==cp)return
      if(isCellBlocked(g,targetR,targetC)||!inZone(targetR,cp)||g.board[targetR][targetC])return
      const hand=[...g.players[cp].hand];const card=hand[drag.handIdx];if(!card)return
      hand.splice(drag.handIdx,1);const nb=g.board.map(r=>[...r]);nb[targetR][targetC]=card
      g={...g,board:nb,players:{...g.players,[cp]:{...g.players[cp],hand}},actionsLeft:{...al,placement:al.placement-1}}
      snd('place-'+cardTier(card),soundOn);cells=[{r:targetR,c:targetC,ghost:null,anim:'anim-place',dur:350}]
    }else if(drag.from==='board'){
      const{r:fr,c:fc}=drag;const moving=g.board[fr][fc]
      if(!moving||moving.owner!==cp)return
      const target=g.board[targetR][targetC]
      if(target){
        if(al.attack<=0||target.owner===cp||!isCardinal(fr,fc,targetR,targetC))return
        const{newBoard,aDead,dDead}=doAttack(g.board,fr,fc,targetR,targetC)
        g={...g,board:newBoard,actionsLeft:{...al,attack:al.attack-1}}
        snd(aDead||dDead?'destroy':'attack',soundOn)
        violent=aDead||dDead
        cells=[
          {r:targetR,c:targetC,ghost:dDead?target:null,anim:dDead?'anim-destroy':'anim-attack',dur:dDead?650:350},
          {r:fr,c:fc,ghost:aDead?moving:null,anim:aDead?'anim-destroy':'anim-attack',dur:aDead?650:350},
        ]
      }else{
        if(al.moves<=0||isCellBlocked(g,targetR,targetC)||!isAdjacent(fr,fc,targetR,targetC))return
        const nb=g.board.map(r=>[...r]);nb[targetR][targetC]=moving;nb[fr][fc]=null
        g={...g,board:nb,actionsLeft:{...al,moves:al.moves-1}};snd('move',soundOn);cells=[{r:targetR,c:targetC,ghost:null,anim:'anim-move',dur:220}]
      }
    }
    if(cells)setLastAnim({seq:nextAnimSeq(),cells,violent})
    const winner=checkWin(g)
    if(winner){
      const f={...g,winner};setGame(f)
      if(roomCode){syncOnline(f);setTimeout(()=>removeRoom(roomCode).catch(()=>{}),4000)}
      setTimeout(()=>setScreen('gameover'),650)
    }else{setGame(g);if(roomCode)syncOnline(g)}
  }

  function handlePowerAction(type,r,c){
    if(!game)return
    const g=applyPowerAction(game,type,r,c)
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
    const next=game.currentPlayer===1?2:1
    const g={...game,currentPlayer:next,actionsLeft:{...FRESH_ACTIONS},turn:game.turn+1}
    setGame(g);if(roomCode)syncOnline(g)
  }

  function startGame(mode,deck=chosenDeck){
    if(aiTimerRef.current){clearTimeout(aiTimerRef.current);aiTimerRef.current=null}
    const p1Deck=deck,p2Deck=mode==='local'?deck:null
    setGameMode(mode);setRoomCode(null);setMyPlayer(mode==='ai'?1:null);setGame(newGame(p1Deck,p2Deck));setScreen('game')
  }

  function goToDeckSelect(mode){setPendingMode(mode);setScreen('deckselect')}
  function handleDeckChosen(deck){
    setChosenDeck(deck)
    if(pendingMode==='online')setScreen('online')
    else startGame(pendingMode,deck)
  }

  function handleOnlineStart(state,code,player){
    setGameMode('online');setRoomCode(code);setMyPlayer(player);setGame(state);setScreen('game')
    if(unsubRef.current){unsubRef.current();unsubRef.current=null}
    unsubRef.current=subscribeRoom(code,data=>{
      if(ignoreNextRef.current){ignoreNextRef.current=false;return}
      if(data.state)setGame(data.state)
    })
  }

  function closeGame(){
    if(aiTimerRef.current){clearTimeout(aiTimerRef.current);aiTimerRef.current=null}
    if(unsubRef.current){unsubRef.current();unsubRef.current=null}
    setScreen('menu')
  }

  return(
    <>
      <SoundToggle enabled={soundOn} onToggle={()=>setSoundOn(v=>!v)}/>
      {screen==='menu'     && <MenuScreen onAI={()=>goToDeckSelect('ai')} onLocal={()=>goToDeckSelect('local')} onOnline={()=>goToDeckSelect('online')} onRules={()=>setScreen('rules')} onDeckBuilder={()=>setScreen('deckbuilder')} onAccount={()=>setScreen('account')} onBooster={()=>setScreen('booster')} user={user}/>}
      {screen==='rules'    && <RulesScreen onBack={()=>setScreen('menu')}/>}
      {screen==='deckbuilder' && <DeckBuilderScreen onBack={()=>setScreen('menu')} user={user}/>}
      {screen==='booster'  && <BoosterScreen onBack={()=>setScreen('menu')} user={user}/>}
      {screen==='deckselect' && <DeckSelectScreen mode={pendingMode} onBack={()=>setScreen('menu')} onSelect={handleDeckChosen}/>}
      {screen==='account'  && <AccountScreen onBack={()=>setScreen('menu')} user={user} stats={stats}/>}
      {screen==='online'   && <OnlineLobbyScreen onBack={()=>setScreen('menu')} onGameStart={handleOnlineStart} deck={chosenDeck}/>}
      {screen==='game'     && game && <GameScreen game={game} soundEnabled={soundOn} myPlayer={myPlayer} isAI={gameMode==='ai'} onAction={handleAction} onEndTurn={handleEndTurn} onHome={closeGame} onPowerAction={handlePowerAction} onSurrender={handleSurrender} lastAnim={lastAnim}/>}
      {screen==='gameover' && game && <GameOverScreen winner={game.winner} isAI={gameMode==='ai'} surrendered={!!game.surrendered} onReplay={()=>startGame(gameMode)} onMenu={()=>setScreen('menu')}/>}
    </>
  )
}
