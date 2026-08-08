const { onValueCreated, onValueUpdated } = require('firebase-functions/v2/database')
const { setGlobalOptions } = require('firebase-functions/v2')
const admin = require('firebase-admin')

admin.initializeApp()
// us-central1 is the default and most broadly supported region for Realtime
// Database v2 triggers — change only if you've confirmed your target region
// supports RTDB event triggers and matches your database instance's location.
setGlobalOptions({ region: 'europe-west1' })

// Mirrors notifText()/NOTIF_ICON in src/App.jsx — Cloud Functions can't import
// from the React app, so the title/body text is duplicated here in plain JS.
// Keep both in sync when adding/changing a notification type.
const NOTIF_TEXT = {
  friend_request: n => `${n.fromPseudo} vous a envoyé une demande d'ami.`,
  friend_accept: n => `${n.byPseudo} a accepté votre demande d'ami.`,
  challenge: n => `${n.fromPseudo} vous défie en duel !`,
  match_result: n => n.result === 'draw'
    ? `Partie nulle contre ${n.opponentPseudo}.`
    : n.result === 'win' ? `Victoire contre ${n.opponentPseudo} !` : `Défaite contre ${n.opponentPseudo}.`,
  level_up: n => `Niveau ${n.level} atteint ! +${n.boosters} booster${n.boosters > 1 ? 's' : ''} gratuit${n.boosters > 1 ? 's' : ''} et ${n.coins} pièces.`,
  trade_offer: n => `${n.fromPseudo} vous propose un échange.`,
  trade_accepted: n => `Votre échange a été accepté.`,
  trade_declined: n => `Votre échange a été refusé.`,
}

const STALE_TOKEN_ERRORS = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
])

// Fires whenever pushNotification() (src/firebase.js) writes a new mailbox
// entry — fans that same event out to every registered device via FCM, on
// top of the existing in-app RTDB mailbox (which this does not replace).
exports.sendPushOnNotification = onValueCreated('/notifications/{uid}/{pushId}', async event => {
  const { uid } = event.params
  const notif = event.data.val()
  const textFn = NOTIF_TEXT[notif?.type]
  if (!textFn) return

  const tokensSnap = await admin.database().ref(`fcmTokens/${uid}`).get()
  const tokens = Object.keys(tokensSnap.val() || {})
  if (!tokens.length) return

  const message = {
    tokens,
    notification: { title: 'Charta Logica', body: textFn(notif) },
    data: { type: notif.type, ...(notif.code ? { code: notif.code } : {}), ...(notif.tradeId ? { tradeId: notif.tradeId } : {}) },
  }

  const res = await admin.messaging().sendEachForMulticast(message)
  const staleTokens = res.responses
    .map((r, i) => (!r.success && STALE_TOKEN_ERRORS.has(r.error?.code) ? tokens[i] : null))
    .filter(Boolean)
  await Promise.all(staleTokens.map(t => admin.database().ref(`fcmTokens/${uid}/${t}`).remove()))
})

function pushServerNotification(uid, payload) {
  return admin.database().ref(`notifications/${uid}`).push({ ...payload, at: Date.now(), read: false })
}
function toArray(v) {
  if (v == null) return []
  return Array.isArray(v) ? v : Object.values(v)
}

// Executes an accepted trade server-side — the Admin SDK bypasses
// database.rules.json entirely, which is the point: neither client is
// trusted to correctly apply both sides of a cross-account transfer (see the
// tradeOffers rule comment). Re-validates ownership/balances fresh at
// resolution time (a card may have been sold or already traded away since
// the offer was made) before a single atomic multi-path update.
exports.resolveTrade = onValueUpdated('/tradeOffers/{uid}/{tradeId}', async event => {
  const { uid: toUid, tradeId } = event.params
  const before = event.data.before.val()
  const after = event.data.after.val()
  if (!before || !after || before.status !== 'pending') return
  const { fromUid, fromPseudo, offerCardIds = [], offerCoins = 0, requestCardIds = [], requestCoins = 0 } = after
  const db = admin.database()

  if (after.status === 'declined') {
    await Promise.all([
      db.ref(`tradeOffersSent/${fromUid}/${tradeId}`).update({ status: 'declined' }).catch(() => {}),
      pushServerNotification(fromUid, { type: 'trade_declined', byUid: toUid }),
    ])
    return
  }
  if (after.status !== 'accepted') return

  const [fromCollSnap, toCollSnap, fromEcoSnap, toEcoSnap] = await Promise.all([
    db.ref(`users/${fromUid}/collection`).get(),
    db.ref(`users/${toUid}/collection`).get(),
    db.ref(`users/${fromUid}/economy`).get(),
    db.ref(`users/${toUid}/economy`).get(),
  ])
  const fromColl = toArray(fromCollSnap.val())
  const toColl = toArray(toCollSnap.val())
  const fromCoins = fromEcoSnap.val()?.coins || 0
  const toCoins = toEcoSnap.val()?.coins || 0

  const valid = offerCardIds.every(id => fromColl.some(c => c.id === id))
    && requestCardIds.every(id => toColl.some(c => c.id === id))
    && fromCoins >= offerCoins
    && toCoins >= requestCoins

  if (!valid) {
    await Promise.all([
      db.ref(`tradeOffers/${toUid}/${tradeId}`).update({ status: 'failed', resolvedAt: Date.now() }),
      db.ref(`tradeOffersSent/${fromUid}/${tradeId}`).update({ status: 'failed' }).catch(() => {}),
      pushServerNotification(fromUid, { type: 'trade_declined', byUid: toUid, fromPseudo }),
    ])
    return
  }

  const offeredSet = new Set(offerCardIds)
  const requestedSet = new Set(requestCardIds)
  const newFromColl = [...fromColl.filter(c => !offeredSet.has(c.id)), ...toColl.filter(c => requestedSet.has(c.id))]
  const newToColl = [...toColl.filter(c => !requestedSet.has(c.id)), ...fromColl.filter(c => offeredSet.has(c.id))]
  const now = Date.now()

  const updates = {
    [`users/${fromUid}/collection`]: newFromColl,
    [`users/${toUid}/collection`]: newToColl,
    [`users/${fromUid}/economy/coins`]: fromCoins - offerCoins + requestCoins,
    [`users/${fromUid}/economy/coinsUpdatedAt`]: now,
    [`users/${toUid}/economy/coins`]: toCoins - requestCoins + offerCoins,
    [`users/${toUid}/economy/coinsUpdatedAt`]: now,
    [`tradeOffers/${toUid}/${tradeId}/status`]: 'completed',
    [`tradeOffers/${toUid}/${tradeId}/resolvedAt`]: now,
    [`tradeOffersSent/${fromUid}/${tradeId}/status`]: 'completed',
  }
  await db.ref().update(updates)
  await pushServerNotification(fromUid, { type: 'trade_accepted', byUid: toUid })
})
