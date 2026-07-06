# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```
npm run dev       # Vite dev server
npm run build     # production build to dist/
npm run preview   # preview the production build locally
```

There is no lint or test script configured — `package.json` only defines `dev`, `build`, `preview`.

Firebase is optional at runtime: `src/firebase.js` wraps all calls in `if (!db)`/`if (!auth)` guards, so the app degrades gracefully (local-only, no auth) when `VITE_FIREBASE_*` env vars are absent. Required vars (see `.env.local`, which is currently committed — treat any key rotation as needed): `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_DATABASE_URL`, `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_STORAGE_BUCKET`, `VITE_FIREBASE_MESSAGING_SENDER_ID`, `VITE_FIREBASE_APP_ID`.

Deploy target is Netlify (`netlify.toml`): builds with `npm run build`, publishes `dist`, SPA fallback redirect to `/index.html`.

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
