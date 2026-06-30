// ─── Firebase Configuration ───────────────────────────────────
// Fill in your Firebase project credentials here.
// Create a project at https://console.firebase.google.com
// Enable Realtime Database and copy the config below.

import { initializeApp } from 'firebase/app'
import { getDatabase, ref, set, get, onValue, update, remove } from 'firebase/database'

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
try {
  const app = initializeApp(firebaseConfig)
  db = getDatabase(app)
} catch (e) {
  console.warn('Firebase not configured:', e.message)
}

export { db }

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

export function subscribeRoom(code, callback) {
  if (!db) return () => {}
  const r = ref(db, `rooms/${code}`)
  const unsub = onValue(r, snap => {
    if (snap.exists()) {
      const data = snap.val()
      callback({ ...data, state: data.state ? deserializeState(data.state) : null })
    }
  })
  return unsub
}

export async function removeRoom(code) {
  if (!db) return
  await remove(ref(db, `rooms/${code}`))
}
