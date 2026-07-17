// ─── Firebase Configuration ───────────────────────────────────
// Fill in your Firebase project credentials here.
// Create a project at https://console.firebase.google.com
// Enable Realtime Database, and in Authentication enable the
// "Email/Password" and "Google" sign-in providers.

import { initializeApp } from 'firebase/app'
import { getDatabase, ref, set, get, push, onValue, update, remove, runTransaction, onDisconnect, query, orderByChild, limitToLast } from 'firebase/database'
import {
  getAuth, onAuthStateChanged, updateProfile, deleteUser,
  createUserWithEmailAndPassword, signInWithEmailAndPassword,
  GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult, signOut,
  EmailAuthProvider, reauthenticateWithCredential, reauthenticateWithPopup, reauthenticateWithRedirect,
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
  'auth/weak-password': 'Mot de passe trop faible (8 caractères minimum).',
  'auth/user-not-found': 'Aucun compte ne correspond à cet email.',
  'auth/wrong-password': 'Mot de passe incorrect.',
  'auth/invalid-credential': 'Email ou mot de passe incorrect.',
  'auth/popup-closed-by-user': 'Connexion annulée.',
  'auth/network-request-failed': 'Erreur réseau, réessayez.',
  'auth/requires-recent-login': 'Merci de vous reconnecter pour confirmer cette action.',
}
// Keeps the original Firebase error code on the thrown Error (as `.code`) so
// callers can branch on specific cases (e.g. auth/requires-recent-login)
// while still getting a friendly, translated `.message` for display.
function authError(e) {
  const err = new Error(AUTH_ERROR_MESSAGES[e?.code] || 'Firebase non configuré — renseignez src/firebase.js')
  if (e?.code) err.code = e.code
  return err
}

export async function registerWithEmail(email, password) {
  if (!auth) throw authError()
  try {
    const user = (await createUserWithEmailAndPassword(auth, email, password)).user
    // Default pseudo is the part of the email before "@" — the player can rename
    // later. Email local-parts routinely contain characters RTDB keys reject
    // (a dot is extremely common, e.g. "john.doe@…") so strip anything
    // claimUsername would bounce, not just the ones a raw copy would hit.
    // A common prefix (e.g. "john") may also already be claimed by someone
    // else, so fall back to a random-suffixed variant rather than ever blocking
    // registration on a name collision.
    let base = email.split('@')[0].replace(/[.#$[\]/\x00-\x1F\x7F]/g, '').slice(0, 20)
    if (base.length < 2) base = 'joueur' // too short/empty after stripping — claimUsername requires 2-24 chars
    let pseudo = base
    try { await claimUsername(user.uid, base) }
    catch {
      pseudo = `${base}${Math.floor(1000 + Math.random() * 9000)}`
      await claimUsername(user.uid, pseudo).catch(() => {})
    }
    await updateProfile(user, { displayName: pseudo }).catch(() => {})
    return user
  } catch (e) { throw authError(e) }
}
export async function updateDisplayName(name) {
  if (!auth?.currentUser) throw new Error('Non connecté')
  try { await updateProfile(auth.currentUser, { displayName: name }) }
  catch (e) { throw authError(e) }
}
// Trims a Firebase User down to the plain fields the UI actually needs —
// providerId (e.g. 'password' vs 'google.com') matters for account deletion,
// which needs to know whether to re-prompt for a password or for Google.
function toUserSnapshot(u) {
  return u ? { uid: u.uid, email: u.email, displayName: u.displayName, providerId: u.providerData[0]?.providerId || null } : null
}
// updateProfile() mutates auth.currentUser locally but does NOT re-fire
// onAuthStateChanged, so callers must pull a fresh snapshot to update UI state.
export function currentUserSnapshot() {
  return toUserSnapshot(auth?.currentUser)
}
export async function loginWithEmail(email, password) {
  if (!auth) throw authError()
  try { return (await signInWithEmailAndPassword(auth, email, password)).user }
  catch (e) { throw authError(e) }
}
// signInWithPopup needs a real browser window to open into — it silently fails
// (or the popup never returns) in an installed/standalone PWA, since there's no
// window chrome for the popup to live in. Redirect works everywhere instead, at
// the cost of a full navigation away and back, so it's only used when actually
// running standalone.
function isStandalonePwa() {
  return typeof window !== 'undefined' && (
    window.matchMedia?.('(display-mode: standalone)').matches ||
    window.navigator.standalone === true // iOS Safari "Add to Home Screen"
  )
}
export async function loginWithGoogle() {
  if (!auth) throw authError()
  const provider = new GoogleAuthProvider()
  try {
    if (isStandalonePwa()) {
      await signInWithRedirect(auth, provider)
      return null // page is navigating away — onAuthChange picks up the result after the redirect back
    }
    return (await signInWithPopup(auth, provider)).user
  } catch (e) { throw authError(e) }
}
// Call once at startup so a redirect-based Google login (see above) that just
// navigated back into the app surfaces its result/errors instead of failing silently.
export async function completeRedirectLogin() {
  if (!auth) return null
  try { return (await getRedirectResult(auth))?.user || null }
  catch (e) { console.warn('Redirect login failed:', e.message); return null }
}
export async function logout() {
  if (!auth) return
  await signOut(auth)
}
export function onAuthChange(callback) {
  if (!auth) { callback(null); return () => {} }
  return onAuthStateChanged(auth, u => callback(toUserSnapshot(u)))
}

// ─── Account deletion (Play Store / GDPR requirement) ───────────
// Firebase requires a "recent" login before a sensitive op like deleteUser —
// if the session is older than a few minutes this throws auth/requires-recent-login,
// which callers should catch and resolve with reauthenticate() below before retrying.
export async function reauthenticate(password) {
  if (!auth?.currentUser) throw new Error('Non connecté')
  const providerId = auth.currentUser.providerData[0]?.providerId
  if (providerId !== 'google.com' && !password) throw new Error('Mot de passe requis pour confirmer la suppression.')
  try {
    if (providerId === 'google.com') {
      const provider = new GoogleAuthProvider()
      if (isStandalonePwa()) { await reauthenticateWithRedirect(auth.currentUser, provider); return }
      await reauthenticateWithPopup(auth.currentUser, provider)
    } else {
      await reauthenticateWithCredential(auth.currentUser, EmailAuthProvider.credential(auth.currentUser.email, password))
    }
  } catch (e) { throw authError(e) }
}
// Best-effort purge of every Realtime Database path keyed by this uid, plus the
// reverse half of each friendship (friends/{uid}/x is only addressable from the
// uid side otherwise) and the username index slot. Each path is removed
// independently so one missing/blocked path can't stop the rest of the cleanup.
export async function deleteAccountData(uid) {
  if (!db) return
  const [friendsSnap, pseudoSnap] = await Promise.all([
    get(ref(db, `friends/${uid}`)).catch(() => null),
    get(ref(db, `users/${uid}/pseudoNormalized`)).catch(() => null),
  ])
  const friendUids = friendsSnap?.exists() ? Object.keys(friendsSnap.val()) : []
  await Promise.all(friendUids.map(fid => remove(ref(db, `friends/${fid}/${uid}`)).catch(() => {})))
  const normalized = pseudoSnap?.exists() ? pseudoSnap.val() : null
  if (normalized) await runTransaction(ref(db, `usernames/${normalized}`), current => (current === uid ? null : current)).catch(() => {})
  await Promise.all([
    remove(ref(db, `users/${uid}`)),
    remove(ref(db, `friends/${uid}`)),
    remove(ref(db, `friendRequests/${uid}`)),
    remove(ref(db, `notifications/${uid}`)),
  ].map(p => p.catch(() => {})))
}
export async function deleteCurrentAccount() {
  if (!auth?.currentUser) throw new Error('Non connecté')
  try { await deleteUser(auth.currentUser) }
  catch (e) { throw authError(e) }
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

// ─── Tombstones — ids of sold/deleted decks or collection cards ────
export async function loadCloudDeletedIds(uid, field) {
  if (!db) return null
  const snap = await get(ref(db, `users/${uid}/${field}`))
  if (!snap.exists()) return null
  return toArray(snap.val())
}
export async function saveCloudDeletedIds(uid, field, ids) {
  if (!db) return
  await set(ref(db, `users/${uid}/${field}`), ids)
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

// hostUid/guestUid (+ pseudo) are optional (anonymous online play is still
// allowed) — when present they let match-end notifications and friend
// challenges identify who actually played, without changing anything for
// logged-out participants.
export async function createRoom(code, state, hostUid, hostPseudo) {
  if (!db) throw new Error('Firebase not configured')
  await set(ref(db, `rooms/${code}`), {
    state: serializeState(state),
    player2Joined: false,
    createdAt: Date.now(),
    ...(hostUid ? { hostUid, hostPseudo: hostPseudo || null } : {}),
  })
}

// Returns { state, hostUid, hostPseudo } (not just the game state) so the
// joiner immediately knows who they're playing, without a second round-trip.
export async function joinRoom(code, guestUid, guestPseudo) {
  if (!db) throw new Error('Firebase not configured')
  const snap = await get(ref(db, `rooms/${code}`))
  if (!snap.exists()) return null
  const data = snap.val()
  await update(ref(db, `rooms/${code}`), { player2Joined: true, ...(guestUid ? { guestUid, guestPseudo: guestPseudo || null } : {}) })
  return { state: deserializeState(data.state), hostUid: data.hostUid || null, hostPseudo: data.hostPseudo || null }
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

// ─── Usernames — case-insensitive uniqueness index ─────────────
// `usernames/{normalized}: uid` is the source of truth for "is this pseudo
// taken", since Firebase Auth's displayName has no uniqueness constraint and
// can't be queried by value. `users/{uid}/pseudo` mirrors the *display* form
// (original casing) so other players can show it — Auth profiles of OTHER
// users are never readable client-side, only your own.
export function normalizePseudo(pseudo) {
  return (pseudo || '').trim().toLowerCase()
}
// Realtime Database keys can't contain . # $ [ ] / or ASCII control chars —
// reject those up front with a clear message instead of letting the SDK
// throw an opaque "Invalid path" error deep inside the transaction below.
const INVALID_PSEUDO_CHARS = /[.#$[\]/\x00-\x1F\x7F]/

// Claims `pseudo` for `uid`, atomically releasing whatever pseudo `uid` held
// before. Fails if the normalized name is already claimed by a different uid.
export async function claimUsername(uid, pseudo) {
  if (!db) throw new Error('Firebase not configured')
  const trimmed = (pseudo || '').trim()
  if (trimmed.length < 2 || trimmed.length > 24) throw new Error('Le pseudo doit contenir entre 2 et 24 caractères.')
  if (INVALID_PSEUDO_CHARS.test(trimmed)) throw new Error('Le pseudo ne peut pas contenir . # $ [ ] / ni de caractères de contrôle.')
  const normalized = normalizePseudo(trimmed)
  if (!normalized) throw new Error('Pseudo invalide.')
  const slotRef = ref(db, `usernames/${normalized}`)
  const result = await runTransaction(slotRef, current => {
    if (current && current !== uid) return // abort — taken by someone else
    return uid
  })
  if (!result.committed) throw new Error('Ce pseudo est déjà pris.')
  const prevSnap = await get(ref(db, `users/${uid}/pseudoNormalized`))
  const prevNormalized = prevSnap.exists() ? prevSnap.val() : null
  if (prevNormalized && prevNormalized !== normalized) {
    // Best-effort release of the old slot — only if it's still ours (guards
    // against a rare race with a concurrent rename on another device).
    await runTransaction(ref(db, `usernames/${prevNormalized}`), current => (current === uid ? null : current))
  }
  await set(ref(db, `users/${uid}/pseudo`), trimmed)
  await set(ref(db, `users/${uid}/pseudoNormalized`), normalized)
  return trimmed
}

export async function getUidByPseudo(pseudo) {
  if (!db) return null
  const snap = await get(ref(db, `usernames/${normalizePseudo(pseudo)}`))
  return snap.exists() ? snap.val() : null
}

// ─── Friends ─────────────────────────────────────────────────────
// `friends/{uid}/{friendUid}: {pseudo, since}` — bidirectional, one entry
// written to each side when a request is accepted. The friend's pseudo is
// denormalized here (can't read another user's live profile on demand) —
// it can go stale if they rename, which is an acceptable tradeoff for
// avoiding a lookup per friend on every render.
// `friendRequests/{uid}/{fromUid}: {fromPseudo, at}` — pending incoming
// requests mailbox, same one-user-writes-into-another's-path pattern
// already used by the matchmaking mailbox above.
export async function sendFriendRequest(fromUid, fromPseudo, toPseudo) {
  if (!db) throw new Error('Firebase not configured')
  const toUid = await getUidByPseudo(toPseudo)
  if (!toUid) throw new Error('Aucun joueur avec ce pseudo.')
  if (toUid === fromUid) throw new Error('Vous ne pouvez pas vous ajouter vous-même.')
  const [alreadyFriends, alreadyRequested] = await Promise.all([
    get(ref(db, `friends/${fromUid}/${toUid}`)),
    get(ref(db, `friendRequests/${toUid}/${fromUid}`)),
  ])
  if (alreadyFriends.exists()) throw new Error('Déjà dans vos amis.')
  if (alreadyRequested.exists()) throw new Error('Demande déjà envoyée.')
  await set(ref(db, `friendRequests/${toUid}/${fromUid}`), { fromPseudo, at: Date.now() })
  await pushNotification(toUid, { type: 'friend_request', fromUid, fromPseudo })
  return toUid
}

export async function respondFriendRequest(myUid, myPseudo, fromUid, fromPseudo, accept) {
  if (!db) return
  await remove(ref(db, `friendRequests/${myUid}/${fromUid}`))
  if (!accept) return
  const now = Date.now()
  await Promise.all([
    set(ref(db, `friends/${myUid}/${fromUid}`), { pseudo: fromPseudo, since: now }),
    set(ref(db, `friends/${fromUid}/${myUid}`), { pseudo: myPseudo, since: now }),
  ])
  await pushNotification(fromUid, { type: 'friend_accept', byUid: myUid, byPseudo: myPseudo })
}

export function subscribeFriends(uid, callback) {
  if (!db) { callback([]); return () => {} }
  return onValue(ref(db, `friends/${uid}`), snap => {
    const v = snap.val() || {}
    callback(Object.entries(v).map(([friendUid, f]) => ({ uid: friendUid, pseudo: f.pseudo, since: f.since })))
  })
}

export function subscribeFriendRequests(uid, callback) {
  if (!db) { callback([]); return () => {} }
  return onValue(ref(db, `friendRequests/${uid}`), snap => {
    const v = snap.val() || {}
    callback(Object.entries(v).map(([fromUid, r]) => ({ fromUid, fromPseudo: r.fromPseudo, at: r.at })))
  })
}

// ─── Notifications ───────────────────────────────────────────────
// `notifications/{uid}/{pushId}: {type, at, read, ...payload}`. Types:
// 'friend_request', 'friend_accept', 'challenge', 'match_result'. Capped to
// the most recent 50 per user on write — RTDB has no server-side cron here,
// so pruning has to happen opportunistically from a client that's already
// writing to the list.
const NOTIFICATIONS_CAP = 50

export async function pushNotification(uid, payload) {
  if (!db) return
  const listRef = ref(db, `notifications/${uid}`)
  await push(listRef, { ...payload, at: Date.now(), read: false })
  const snap = await get(query(listRef, orderByChild('at'), limitToLast(NOTIFICATIONS_CAP + 1)))
  const entries = snap.val()
  if (entries && Object.keys(entries).length > NOTIFICATIONS_CAP) {
    const oldestId = Object.entries(entries).sort((a, b) => (a[1].at || 0) - (b[1].at || 0))[0][0]
    await remove(ref(db, `notifications/${uid}/${oldestId}`)).catch(() => {})
  }
}

export function subscribeNotifications(uid, callback) {
  if (!db) { callback([]); return () => {} }
  const listRef = query(ref(db, `notifications/${uid}`), orderByChild('at'), limitToLast(NOTIFICATIONS_CAP))
  return onValue(listRef, snap => {
    const v = snap.val() || {}
    const list = Object.entries(v).map(([id, n]) => ({ id, ...n })).sort((a, b) => (b.at || 0) - (a.at || 0))
    callback(list)
  })
}

export async function markNotificationRead(uid, notifId) {
  if (!db) return
  await update(ref(db, `notifications/${uid}/${notifId}`), { read: true })
}

export async function markAllNotificationsRead(uid, ids) {
  if (!db || !ids?.length) return
  const updates = {}
  ids.forEach(id => { updates[`notifications/${uid}/${id}/read`] = true })
  await update(ref(db), updates)
}
