# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```
npm run dev         # Vite dev server
npm run build       # production build to dist/
npm run preview     # preview the production build locally
npm run cap:sync    # vite build + npx cap sync (copies dist/ into android/, ios/)
npm run cap:android # cap:sync + opens the native project in Android Studio
npm run cap:ios     # cap:sync + opens the native project in Xcode (macOS only)
```

There is no lint or test script configured beyond the ones above.

Firebase is optional at runtime: `src/firebase.js` wraps all calls in `if (!db)`/`if (!auth)` guards, so the app degrades gracefully (local-only, no auth) when `VITE_FIREBASE_*` env vars are absent. Required vars (see `.env.local`, gitignored — was previously committed with placeholder values only, now untracked; production values live in Netlify's env var settings): `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_DATABASE_URL`, `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_STORAGE_BUCKET`, `VITE_FIREBASE_MESSAGING_SENDER_ID`, `VITE_FIREBASE_APP_ID`.

A native Android/iOS build additionally needs (none of these are used by the Netlify web build, so none are committed): `android/app/google-services.json` and `android/keystore.properties` (from `android/keystore.properties.example`) for Android; `ios/App/App/GoogleService-Info.plist` for iOS; a real `projectId` in `.firebaserc` and an Apple APNs auth key uploaded to Firebase Console for iOS push specifically.

Deploy target is Netlify (`netlify.toml`): builds with `npm run build`, publishes `dist`, SPA fallback redirect to `/index.html`.

`database.rules.json` is the recommended Firebase Realtime Database security ruleset (not auto-deployed — paste into Firebase Console → Realtime Database → Rules, or deploy via the Firebase CLI). It's the actual access-control enforcement layer: everything in `firebase.js` assumes these rules (or equivalent) are live, since client code alone can't stop a direct SDK/REST call from bypassing app-level checks.

### Native apps (Capacitor) and push notifications

Android and iOS are packaged with **Capacitor** (`capacitor.config.json`, `android/`, `ios/`), replacing the previous Bubblewrap/TWA setup — Capacitor bundles `dist/` into the native binary at build time (not a live URL wrapper like the old TWA), so a content-only change reaches native users only after `npm run cap:sync` + a new store build/submission, unlike the instant-deploy web/PWA build on Netlify. The Android `applicationId` (`com.linereve.chartalogica.twa`) and signing keystore are carried over unchanged from the previously-published TWA listing so Play Store treats new uploads as updates, not a new app — see `android/keystore.properties.example`.

Push notifications piggyback on the existing in-app mailbox rather than replacing it: every `pushNotification(uid, payload)` call in `src/firebase.js`/`src/App.jsx` still writes to `notifications/{uid}` as before, and a Firebase Cloud Function (`functions/index.js`, `sendPushOnNotification`) triggers on that same write to additionally fan out an FCM push to every token in `fcmTokens/{uid}` (registered by `src/push.js`'s `initPush()`, called once a user logs in). `src/push.js` is a no-op on web/PWA (`Capacitor.isNativePlatform()` guards every call), so browser users keep the unchanged in-app bell/dropdown. Cloud Functions require their own deploy (`firebase deploy --only functions`, needs the Blaze billing plan and a real `projectId` in `.firebaserc`) — this is the one place in the project where RTDB writes now do trigger server-side code, an exception to the "no server functions available in RTDB" limitation noted below for the game/matchmaking logic.

## Architecture

"Charta Logica" is a 2-player tactical card game (5×5 board, Triple-Triad-style cardinal combat) built as a single-page React app with **no router and almost no component files** — nearly the entire app lives in `src/App.jsx` (~2100 lines), organized top-to-bottom by banner comments (`// ═══ SECTION ═══`) rather than split into modules:

1. **CONSTANTS / CARD GENERATION / DECK BUILDER** — board geometry, random deck/card generators, `localStorage`-backed deck persistence (`tacticalcards_decks`).
2. **CARD COLLECTION & BOOSTER PACKS** — daily booster pack opening with rarity rolls (`common`/`uncommon`/`rare`/`legendary`), 24h cooldown tracked in `localStorage`.
3. **POWER DECK** — the four special-action cards (`buff`, `recall`, `switch`, `block`) and their board-mutation logic (`applyPowerAction`).
4. **GAME STATE** — `newGame`, scoring (`playerPts`, `cardCount`), win check (`checkWin`).
5. **COMBAT** — `doAttack`/`getContactKeys`: adjacent-cell value subtraction combat, a card dies when any face value goes negative.
6. **SOUND / MUSIC** — procedural WebAudio SFX and an arpeggiated ambient music loop (no audio files for SFX; `public/musiques/*.mp3` for background tracks).
7. **AI** (`computeAIAction` and helpers) — pure functions that score placements/moves/attacks/power-card targets for the Player 2 bot; no ML, just heuristics over `getSituation`/`scoreAttack`/`scorePlacement`/`scoreMove`.
8. **Screen components** — `CardFace`, `Cell`, `PowerBar`, `GameScreen`, `MenuScreen`, `RulesScreen`, `DeckBuilderScreen`, `BoosterScreen`, `AccountScreen`, `OnlineLobbyScreen`, `GameOverScreen`. All screens live in this one file.
9. **`App` (default export)** — the entire app is one `screen` state string (`'menu'|'rules'|'deckbuilder'|'booster'|'deckselect'|'account'|'online'|'game'|'gameover'`) switched in a single JSX return; no react-router.

`src/firebase.js` is the only other real module: Firebase Realtime Database + Auth wrapper (auth, decks/collection/stats sync, and the online-multiplayer room/matchmaking protocol). Key things to know if touching it:
- **Room state serialization**: RTDB can't store `null` array entries or sparse arrays, so `serializeBoard`/`deserializeBoard` round-trip empty cells through the sentinel string `'__null__'`.
- **Matchmaking** is a single shared `matchmaking/waiting` slot plus a per-player `matchmaking/results/{id}` mailbox, coordinated with a `runTransaction` (no server functions available in RTDB) — first arrival waits, second arrival atomically claims the slot and becomes host.
- Local persistence (decks/collection/last-booster-time, all in `localStorage`) is the source of truth when logged out; on login it's merged with cloud data by id (`mergeById` in `App.jsx`) rather than one side overwriting the other.

There's no client-side game-state validation layer distinct from the mutation functions — `handleAction`/`handlePowerAction` in `App` both mutate and legality-check inline (e.g. `isCellBlocked`, `isCardinal`, `actionsLeft` counters) before calling `setGame`. When adding a new action type, follow that same pattern rather than introducing a separate validator.

PWA/offline support is via `vite-plugin-pwa` (see `vite.config.js`): JS/CSS/HTML precached, audio and images runtime-cached (`CacheFirst`) since they're large and rarely change.

## Approach
- Read existing files before writing. Don't re-read unless changed.
- Thorough in reasoning, concise in output.
- Skip files over 100KB unless required.
- No sycophantic openers or closing fluff.
- No emojis or em-dashes.
- Do not guess APIs, versions, flags, commit SHAs, or package names. Verify by reading code or docs before asserting.
