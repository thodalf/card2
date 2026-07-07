// ─── Firebase Configuration ───────────────────────────────────
// Fill in your Firebase project credentials here.
// Create a project at https://console.firebase.google.com
// Enable Realtime Database, and in Authentication enable the
// "Email/Password" and "Google" sign-in providers.

import { initializeApp } from 'firebase/app'
import { getDatabase, ref, set, get, onValue, update, remove, runTransaction, onDisconnect } from 'firebase/database'
import {
  getAuth, onAuthStateChanged,
  createUserWithEmailAndPassword, signInWithEmailAndPassword,
  GoogleAuthProvider, signInWithPopup, signOut,
} from 'firebase/auth'

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  databaseURL: import.meta.env.VITE_FIREBASE_DATABASE_URL,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID
}

let db = null
let auth = null
try {
  const app = initializeApp(firebaseConfig)
  db = getDatabase(app)
  auth = getAuth(app)
} catch (e) {
  console.warn('Firebase not configured:', e.message)
}

export { db, auth }

// ─── Authentication ────────────────────────────────────────────
const AUTH_ERROR_MESSAGES = {
  'auth/email-already-in-use': 'Cet email est déjà utilisé.',
  'auth/invalid-email': 'Email invalide.',
  'auth/weak-password': 'Mot de passe trop faible (6 caractères minimum).',
  'auth/user-not-found': 'Aucun compte ne correspond à cet email.',
  'auth/wrong-password': 'Mot de passe incorrect.',
  'auth/invalid-credential': 'Email ou mot de passe incorrect.',
  'auth/popup-closed-by-user': 'Connexion annulée.',
  'auth/network-request-failed': 'Erreur réseau, réessayez.',
}
function authError(e) {
  return new Error(AUTH_ERROR_MESSAGES[e?.code] || 'Firebase non configuré — renseignez src/firebase.js')
}

export async function registerWithEmail(email, password) {
  if (!auth) throw authError()
  try { return (await createUserWithEmailAndPassword(auth, email, password)).user }
  catch (e) { throw authError(e) }
}
export async function loginWithEmail(email, password) {
  if (!auth) throw authError()
  try { return (await signInWithEmailAndPassword(auth, email, password)).user }
  catch (e) { throw authError(e) }
}
export async function loginWithGoogle() {
  if (!auth) throw authError()
  try { return (await signInWithPopup(auth, new GoogleAuthProvider())).user }
  catch (e) { throw authError(e) }
}
export async function logout() {
  if (!auth) return
  await signOut(auth)
}
export function onAuthChange(callback) {
  if (!auth) { callback(null); return () => {} }
  return onAuthStateChanged(auth, callback)
}

// ─── Player data (decks & stats), keyed by uid ─────────────────
function toArray(v) {
  if (v == null) return []
  return Array.isArray(v) ? v : Object.values(v)
}

export async function loadCloudDecks(uid) {
  if (!db) return null
  const snap = await get(ref(db, `users/${uid}/decks`))
  if (!snap.exists()) return null
  return toArray(snap.val()).map(d => ({ ...d, cards: toArray(d.cards) }))
}
export async function saveCloudDecks(uid, decks) {
  if (!db) return
  await set(ref(db, `users/${uid}/decks`), decks)
}
export async function loadCloudCollection(uid) {
  if (!db) return null
  const snap = await get(ref(db, `users/${uid}/collection`))
  if (!snap.exists()) return null
  return toArray(snap.val())
}
export async function saveCloudCollection(uid, cards) {
  if (!db) return
  await set(ref(db, `users/${uid}/collection`), cards)
}
export async function loadCloudLastBooster(uid) {
  if (!db) return null
  const snap = await get(ref(db, `users/${uid}/lastBoosterAt`))
  return snap.exists() ? snap.val() : null
}
export async function saveCloudLastBooster(uid, ts) {
  if (!db) return
  await set(ref(db, `users/${uid}/lastBoosterAt`), ts)
}

// ─── Economy — coins & owned cosmetic skins ────────────────────
export async function loadCloudEconomy(uid) {
  if (!db) return null
  const snap = await get(ref(db, `users/${uid}/economy`))
  if (!snap.exists()) return null
  const v = snap.val()
  return { coins: v.coins || 0, coinsUpdatedAt: v.coinsUpdatedAt || 0, ownedSkins: toArray(v.ownedSkins) }
}
export async function saveCloudEconomy(uid, economy) {
  if (!db) return
  await set(ref(db, `users/${uid}/economy`), economy)
}
export function subscribeStats(uid, callback) {
  if (!db) { callback({ gamesPlayed: 0, wins: 0, losses: 0 }); return () => {} }
  const r = ref(db, `users/${uid}/stats`)
  return onValue(r, snap => callback(snap.exists() ? snap.val() : { gamesPlayed: 0, wins: 0, losses: 0 }))
}
export async function recordGameResult(uid, won) {
  if (!db) return
  const statsRef = ref(db, `users/${uid}/stats`)
  const snap = await get(statsRef)
  const cur = snap.exists() ? snap.val() : { gamesPlayed: 0, wins: 0, losses: 0 }
  await set(statsRef, {
    gamesPlayed: (cur.gamesPlayed || 0) + 1,
    wins: (cur.wins || 0) + (won ? 1 : 0),
    losses: (cur.losses || 0) + (won ? 0 : 1),
    updatedAt: Date.now(),
  })
}

export const GEN_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

export function genRoomCode() {
  return Array.from({ length: 6 }, () => GEN_CHARS[Math.floor(Math.random() * GEN_CHARS.length)]).join('')
}

function serializeBoard(board) {
  return board.map(row => row.map(cell => cell ?? '__null__'))
}

function deserializeBoard(board) {
  if (!board) return Array(5).fill(null).map(() => Array(5).fill(null))
  const rows = Array.isArray(board) ? board : Object.values(board)
  return rows.map(row => {
    const cells = Array.isArray(row) ? row : Object.values(row)
    return cells.map(c => c === '__null__' ? null : c)
  })
}

function serializeState(state) {
  return { ...state, board: serializeBoard(state.board) }
}

function deserializePlayers(players) {
  const result = { 1: { hand: [] }, 2: { hand: [] } }
  if (!players) return result
  for (const id of Object.keys(players)) {
    const p = players[id] || {}
    result[id] = { ...p, hand: Array.isArray(p.hand) ? p.hand : Object.values(p.hand ?? {}) }
  }
  return result
}

function deserializeState(raw) {
  if (!raw) return null
  return { ...raw, board: deserializeBoard(raw.board), players: deserializePlayers(raw.players) }
}

export async function createRoom(code, state) {
  if (!db) throw new Error('Firebase not configured')
  await set(ref(db, `rooms/${code}`), {
    state: serializeState(state),
    player2Joined: false,
    createdAt: Date.now(),
  })
}

export async function joinRoom(code) {
  if (!db) throw new Error('Firebase not configured')
  const snap = await get(ref(db, `rooms/${code}`))
  if (!snap.exists()) return null
  const data = snap.val()
  await update(ref(db, `rooms/${code}`), { player2Joined: true })
  return deserializeState(data.state)
}

export async function pushState(code, state) {
  if (!db) return
  await set(ref(db, `rooms/${code}/state`), serializeState(state))
}

export function subscribeRoom(code, callback, onError) {
  if (!db) return () => {}
  const r = ref(db, `rooms/${code}`)
  const unsub = onValue(r, snap => {
    if (snap.exists()) {
      const data = snap.val()
      callback({ ...data, state: data.state ? deserializeState(data.state) : null })
    }
  }, onError)
  return unsub
}

export async function removeRoom(code) {
  if (!db) return
  await remove(ref(db, `rooms/${code}`))
}

// ─── Matchmaking — single-slot queue + per-player mailbox ──────
// One shared "waiting" slot: the first player to arrive claims it and
// waits; the next player to arrive finds it occupied, clears it (atomic
// transaction — Realtime Database has no server functions here) and
// becomes the room host, notifying the original waiter via their mailbox.
const MM_WAITING_PATH = 'matchmaking/waiting'
const mmResultPath = id => `matchmaking/results/${id}`

export async function joinMatchmaking(myId, attempt = 0) {
  if (!db) throw new Error('Firebase not configured')
  const waitingRef = ref(db, MM_WAITING_PATH)
  let opponentId = null
  const result = await runTransaction(waitingRef, current => {
    if (!current || !current.id) return { id: myId, ts: Date.now() }
    if (current.id === myId) return current
    opponentId = current.id
    return null
  })
  if (opponentId) return { role: 'host', opponentId }
  if (result.committed && result.snapshot.val()?.id === myId) {
    onDisconnect(waitingRef).remove()
    return { role: 'waiting' }
  }
  if (attempt >= 3) return { role: 'waiting' }
  return joinMatchmaking(myId, attempt + 1)
}

export async function leaveMatchmaking(myId) {
  if (!db) return
  const waitingRef = ref(db, MM_WAITING_PATH)
  onDisconnect(waitingRef).cancel()
  await runTransaction(waitingRef, current => (current && current.id === myId ? null : current))
}

export async function publishMatchResult(opponentId, code) {
  if (!db) return
  await set(ref(db, mmResultPath(opponentId)), { code, at: Date.now() })
}

export function subscribeMatchResult(myId, callback) {
  if (!db) return () => {}
  return onValue(ref(db, mmResultPath(myId)), snap => { if (snap.exists()) callback(snap.val()) })
}

export async function clearMatchResult(myId) {
  if (!db) return
  await remove(ref(db, mmResultPath(myId)))
}
