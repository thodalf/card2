// Native push notifications (Android/iOS via Capacitor), wired into the same
// notification events already pushed to the RTDB mailbox (see firebase.js's
// pushNotification/subscribeNotifications and functions/index.js, which is
// what actually sends the FCM message once a mailbox entry is written).
// Every export here is a no-op on the web/PWA build — Capacitor.isNativePlatform()
// is false there, so browser users keep the existing in-app bell unchanged.
import { Capacitor } from '@capacitor/core'
import { PushNotifications } from '@capacitor/push-notifications'
import { FCM } from '@capacitor-community/fcm'
import { registerPushToken, removePushToken } from './firebase.js'

let listenersAttached = false
let currentToken = null
let onChallengeTapCb = null

export async function initPush(uid, { onChallengeTap } = {}) {
  if (!Capacitor.isNativePlatform() || !uid) return
  onChallengeTapCb = onChallengeTap || null

  if (!listenersAttached) {
    listenersAttached = true
    PushNotifications.addListener('registration', async () => {
      // The native 'registration' event's own token is the raw APNs token on
      // iOS, not usable with admin.messaging() — FCM.getToken() normalizes
      // both platforms to a real FCM registration token.
      try {
        const { token } = await FCM.getToken()
        currentToken = token
        await registerPushToken(uid, token)
      } catch (e) { console.warn('FCM getToken failed:', e.message) }
    })
    PushNotifications.addListener('registrationError', err => {
      console.warn('Push registration error:', err.error)
    })
    PushNotifications.addListener('pushNotificationActionPerformed', action => {
      const data = action.notification?.data
      if (data?.type === 'challenge' && data.code && onChallengeTapCb) onChallengeTapCb(data.code)
    })
  }

  const perm = await PushNotifications.requestPermissions()
  if (perm.receive !== 'granted') return
  await PushNotifications.register()
}

// Called before logout — after signOut() the RTDB rules would reject the
// write, so the token has to be removed while the user is still authenticated.
export async function teardownPush(uid) {
  if (!Capacitor.isNativePlatform() || !currentToken || !uid) return
  await removePushToken(uid, currentToken).catch(() => {})
  currentToken = null
}
