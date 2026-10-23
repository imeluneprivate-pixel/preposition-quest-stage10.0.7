# Preposition Quest — Stage 9.3: World Entry Quizzes

Stage 9.3 builds on Stage 9.2 (responsive layout and Kenney sound effects) and makes each new world begin with a clear learning interaction.

## What changed
- Entering Mystery Cave triggers its first contextual quiz immediately after the player steps into the cave area, before reaching the MYSTERY CAVE sign.
- Entering Sky Temple triggers its first contextual quiz immediately after the player steps into the temple area, before reaching the SKY TEMPLE sign.
- Quiz header identifies the current world (Forest Trail, Mystery Cave, or Sky Temple).
- Follow-up challenges remain within each world, and the existing controls, sound controls, lives, coins, checkpoint, scoring, pause/restart, and finish-gate flow are retained.

## Run locally
1. Extract the ZIP to a new folder.
2. Open a terminal in that folder and run `python -m http.server 8000`.
3. Visit `http://localhost:8000`.
4. Keep an internet connection for Phaser 3.80.1 from jsDelivr.

## Focused test plan
1. Start a fresh game and complete the four Forest Trail quizzes.
2. Walk into Mystery Cave. Confirm a quiz appears before the MYSTERY CAVE sign is reached.
3. Continue after answering; confirm a second cave challenge appears farther into the cave.
4. Walk into Sky Temple. Confirm a quiz appears before the SKY TEMPLE sign is reached.
5. Continue and finish the final temple challenge, then verify the Finish Gate requires all eight quizzes.
6. Recheck sound/mute/volume, keyboard movement, touch controls, pause/resume, restart, checkpoint, lives, and scoring.

Static syntax and archive checks do not replace live browser/device testing. Keep the previously tested Stage 9.2 ZIP as a fallback until this build passes gameplay checks.


Stage 9.3.1 fix: attached the cave bat visual parts to its Phaser container so the enemy renders at its intended position in Mystery Cave.


## Stage 9.4 — Quiz Manager Foundation

- Added `js/quiz-manager.js` as a shared compatibility layer for quiz validation, answer normalization, score calculation, and world labels.
- Added stable IDs, world metadata, and explicit `multiple-choice` mode metadata to the existing eight challenges.
- Existing multiple-choice UI and gameplay behavior are intentionally preserved. Picture-to-sentence, drag-and-drop, typing, and speaking are registered as future supported modes but are not implemented in this stage.
- Keep `index.html`, `style.css`, `js/game.js`, `js/quiz-manager.js`, and the full `assets/` folder together when deploying.


## Stage 9.6 — Sentence Builder
- Challenge 03 now uses a sentence builder with tap-to-add word tiles, tap-to-remove words, Undo, Reset, and Check Sentence.
- On desktop, words can also be dragged into the sentence area; tap/click works on touch devices and mouse.
- The accepted sentence is checked through the shared Quiz Manager; scoring and challenge completion use the existing game flow.
- Run `index.html` from the extracted project folder while connected to the internet (Phaser is loaded from a CDN).

## Stage 9.7 — Speaking Challenge
- Challenge 06 (BETWEEN) now uses browser speech recognition where available.
- Speech recognition requests English (en-US), displays the recognized transcript, and allows up to three speech attempts (initial attempt plus two retries).
- Microphone/service errors do not count as incorrect language answers. If speech recognition is unsupported, denied, or the attempts are exhausted, the learner can type an answer instead.
- Speech recognition generally requires HTTPS or localhost and browser/microphone permission. The game still loads Phaser from a CDN, so an internet connection is required.
- Static checks cover JavaScript syntax, challenge count, and referenced HTML IDs. Live microphone/browser testing has not been performed in this build.


## Stage 9.8 — Quiz-mode integration QA

This stage retains the Stage 9.7 game and adds repeatable local tests for the quiz manager and project structure. It checks answer normalization, accepted answer variants, scoring, supported quiz modes, the eight challenge records, required UI controls, clue assets, and audio assets.

### Run automated checks
Requires Node.js 18 or newer. From the extracted project folder run:

```bash
node --check js/game.js
node --check js/quiz-manager.js
node tests/quiz-manager.test.cjs
node tests/project-integrity.test.cjs
```

These checks do not replace live browser testing. Please test movement, each quiz mode, keyboard/touch controls, restart, and microphone permission in a real browser. Speech Recognition depends on browser support and secure-context permissions.


## Stage 9.9 — Gameplay QA preparation

- Added an explicit picture-to-sentence typing challenge for BEHIND so all five quiz modes are represented in the challenge data.
- Added integrity assertions for mode coverage and the accepted sentence answer.
- Run static regression checks from the project root with Node.js:
  - `node --check js/game.js`
  - `node --check js/quiz-manager.js`
  - `node tests/quiz-manager.test.cjs`
  - `node tests/project-integrity.test.cjs`

Note: these are automated code/data checks, not a substitute for testing gameplay, touch input, and microphone permissions in a real browser. Phaser is loaded from a CDN, so internet access is required.


## Stage 10.0 — Typing input key-capture fix
- Fixed keyboard-event handling so Phaser gameplay keys (including Space and A) are not swallowed while the typing-answer input is focused.
- Added a regression test: `node tests/typing-input-regression.test.cjs`.
- This is a code-level fix; please verify in browser that spaces and the letter `a` can be typed in the quiz input.


## Stage 10.0.1 — Start Adventure button fix
- Bound the Start Adventure click handler at the beginning of app initialization.
- Explicitly placed the start overlay and button above the Phaser canvas to prevent pointer interception.
- Start remains idempotent, preventing duplicate game creation if clicked more than once.


## Stage 10.0.2 — activeChallenge initialization fix
- Moved `activeChallenge` initialization to the top-level state declarations so it is initialized before any game scene can access it.
- This addresses the reported `Cannot access 'activeChallenge' before initialization` runtime error.
- Static checks were run; live browser verification is still required.


## Stage 10.0.4 initialization fix

Moved `speechAttempts`, `MAX_SPEECH_ATTEMPTS`, and `speechFallbackShown` into the early shared-state declarations to avoid initialization-order errors during game startup. Browser verification is still required.
\n\n## Stage 10.0.5 quiz click fix\n\nAdded explicit stacking and pointer-event rules for the quiz panel and answer controls, and hardened answer-button click handling. Browser verification is still required.\n\n\n## Stage 10.0.6 quiz input fix\n\nChanged answer handling to document-level capture delegation and made the visible quiz panel the state source for answer interactions. Added explicit touch-action and pointer-event rules. Browser verification is still required.\n

## Stage 10.0.7 direct quiz answer handlers

Changed multiple-choice options to explicit `type="button"` and bound click listeners directly to the answer buttons instead of relying on document-level event delegation. JavaScript syntax check passed with Node.js; interactive browser testing is still required.
\n\n## Stage 10.0.8 quiz state synchronization fix\n\nThe answer-button handler now treats a visible quiz panel as authoritative and restores quizOpen if the UI and internal state drift apart, rather than silently discarding the click. Browser verification is still required.\n