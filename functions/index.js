const { onValueCreated } = require('firebase-functions/v2/database')
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
    data: { type: notif.type, ...(notif.code ? { code: notif.code } : {}) },
  }

  const res = await admin.messaging().sendEachForMulticast(message)
  const staleTokens = res.responses
    .map((r, i) => (!r.success && STALE_TOKEN_ERRORS.has(r.error?.code) ? tokens[i] : null))
    .filter(Boolean)
  await Promise.all(staleTokens.map(t => admin.database().ref(`fcmTokens/${uid}/${t}`).remove()))
})
