# Pixel Arcade Revamp — Visual Spec

Status legend: `[ ]` not started · `[~]` in progress · `[x]` done

A full visual overhaul of Rally into a **16-bit arcade** aesthetic, drawn
**procedurally on canvas** (no image/sprite-sheet assets). Everything renders on
a hard pixel grid with reactive character faces and a subtle CRT sheen.

> Companion doc to `MOMENTUM_SPEC` / `AI_SPEC`. All rendering lives in `index.html`.

---

## North Star

16-bit arcade sports (think *Super Tennis* / *Windjammers*): chunky pixel
athletes, limited palettes, hard edges, expressive faces that react shot-to-shot,
neon-lit pixel stadiums, and a **subtle** scanline + vignette pass that never
hurts gameplay readability.

## Locked decisions

| Decision | Choice |
|---|---|
| Art style | Pixel-art arcade (8/16-bit), faked procedurally |
| Rendering | Stay procedural canvas — no sprite/image pipeline |
| Faces | Reactive expressions (change with gameplay) |
| Screen FX | Subtle (faint scanlines + vignette; crisp gameplay) |
| Order | Phase 1 chars/faces → 2 stadium → 3 rackets/shuttle → 4 UI/FX/SFX |

## Key dimensions (for pixel math)

- Game canvas: `1300 × 730`
- Player figure: `PLAYER_W 40 × PLAYER_H 70` world units, `GROUND_Y 620`
- Chosen art-pixel unit: **`PX = 3`** screen px/art-pixel (tunable 2–4).
  A figure is then ~14 art-px wide × ~24 tall — chunky but readable.

---

## Foundation systems (built in Phase 1, reused by all later phases)

1. **Pixel grid + `px()` primitive** — global `PX` unit; `px(gx, gy, colorIdx)`
   fills grid-aligned `PX×PX` blocks. `imageSmoothingEnabled = false` globally.
   Nothing renders on sub-pixel boundaries.
2. **Sprite maps + palette swapping** — each body part is a compact pixel map of
   palette indices (`OUTLINE/SKIN/SHIRT/SHIRT2/SHORTS/SHOE/HAIR`). The existing
   15 characters ([index.html] `CHARACTERS`) are already color sets, so one body
   sprite recolors into all of them for free.
3. **Hybrid skeletal posing** — keep the existing physics-driven pose angles
   (`charging`, `swingTimer`, `onGround`, `legPhase` in `drawPlayer`/`drawHumanoid`)
   but render limbs as pixel blocks. All gameplay-reactive poses preserved.
4. **Reactive face layer** — tiny face-tile overlays (eyes/brow/mouth) keyed to
   state: `idle` (blink) · `focused` (charging) · `strain` (dive/stretch) ·
   `smash` (smash release) · `elated` (point won) · `dejected` (point lost).
   Each character has a distinct base face; expression swaps on top.

---

## Phase 1 — Characters & Faces  `[~]`

- [x] `px()` primitive + `PX` constant (=3) + `imageSmoothingEnabled=false` (offscreen buffer + nearest-neighbor blit)
- [x] Palette-index sprite system + per-character palette derivation from `CHARACTERS` (`pixPalette`)
- [x] Pixel-art body (torso/head/limbs) replacing `drawHumanoid` strokes (`buildPixFigure`)
- [x] Hybrid pixel limbs driven by existing pose angles (charge/swing/jump/run) (`_pxlimb`)
- [x] Reactive face layer with the 6 expression states (`drawPixFace`); in-rally states (idle/focused/strain/smash) wired via `drawPlayer`
- [x] Preserve special cases: Elijah fish racket, Benjamin plank + long nose, 7 hair styles (`drawPixHair`, `drawPixRacket`)
- [x] Scale review: previewed PX 2/3/4 — **locked PX 3**
- [x] In-game figures verified live in a real match (menu demo + match render, no console errors)
- [x] Pixelate `drawDetailedPortrait` — select-screen, VS, roster thumbnails, p1/p2 previews now render pixel head-and-shoulders (`buildPixPortrait`) with per-character expression
- [x] Legs render as shorts (thigh) + bare shin + shoe (`_pxleg`) — everyone clearly wears shorts
- [x] Per-character personalization: gray glasses (Sherman, Elijah), yellow-beige jacket (Elijah), `nonchalant` demeanor (Jordan, Liam, Lin Dan), goofy portrait (Sherman)
- [x] New expressions: `nonchalant` (heavy-lidded + smirk), `goofy` (derp eyes + grin/tongue); glasses overlay
- [x] Wire `elated`/`dejected` faces to point end (`pointCelebrateSide`: winner grins, loser slumps during pointPause/gameOver; cleared in `setupServe`)
- [x] Unframe the two top select-screen portraits (`bare` mode in `drawDetailedPortrait` — no box/border, larger, soft silhouette glow; CSS frame stripped)
- [ ] Distinct per-character base face shapes (currently shared base + palette/hair variety) — deferred/optional
- [ ] Remove dev scaffolding (`_pixel_preview.html`) before commit

**Phase 1 is functionally complete.** Only the optional per-character face-shape
variety and the pre-commit scaffolding cleanup remain.

**Per-character face traits** live as optional props on `CHARACTERS` entries:
`glasses:'#hex'`, `jacket:'#hex'`, `demeanor:'nonchalant'`, `portraitExpr:'goofy'`.

**Foundation code lives in `index.html` just above `drawHumanoid`** (`PX_ART`,
`pixPalette`, `_mkpx`/`_pxmap`/`_pxlimb`, `HEAD_SKIN`/`HAIR_TOP`, `drawPixFace`,
`drawPixRacket`, `buildPixFigure`). Old renderer kept as `_drawHumanoid_legacy`.

## Phase 2 — Stadiums  `[~]`

- [x] Subtle scanline + vignette post-pass (`drawRetroOverlay`, prebuilt `_scanCanvas` blit; toggle `RETRO_FX`)
- [x] Pixel crowd in the stands — colored blocky spectators that bob on scoring (`drawFansStand`)
- [x] Pixel spectators on the bleacher court floor (`drawBleacherFloor`) — coherent with the stands
- [x] **Offscreen "render small, upscale hard" pipeline** (`COURT_PIXEL_UNIT=3`, `ensureEnvCanvas`/`renderCourtEnv`, cached via `_envKey`) — whole environment layer pixelates uniformly; gameplay lines/net stay full-res on top (spec rule 0.2)
- [x] `decor()` moved into the pixelated pass
- [x] Crowd retint from theme line color (`crowdTonesFor`)
- [x] Revised palettes for the 6 existing courts (spec Part 2)
- [x] 5 new themes: `neonesports`, `volcanic`, `zengarden`, `aquarium`, `cosmic`
- [x] 2 signature courts: `ruins` (Diego), `castle` (Lin Dan) with checkered marble tread + red carpet (`opts.pattern:'checker'` in `drawBleacherFloor`, opt-in)
- [x] Character-select rescaled so it no longer scrolls (verified: 582px panel in 720px viewport)
- [ ] Runtime-verified (no errors, renders varied pixels); **visual aesthetic sign-off pending Browser pane display**
- [ ] Optional: Bayer-dither skies (spec Part 1.3) — only if a sky still looks too smooth in playtest
- [ ] Remove dev scaffolding (`_pixel_preview.html`) before commit

**Court count: 13** (6 original + 5 themes + ruins + castle).

## Phase 3 — Rackets & Shuttle  `[~]`

- [x] Pixel rackets — frame now **themed per character** (frame = shirt, grip = accent); Elijah's fish + Benjamin's cross plank preserved (`drawPixRacket`)
- [x] Pixel shuttlecock — authored sprite (`buildShuttleSprite`) blitted rotated with smoothing off (`drawShuttle`)
- [ ] Stepped/pixelated flight trail (still the smooth trail)

### Gameplay fixes bundled with this pass (not visual)
- [x] **Net pass-through / tunneling** — fast smashes could skip the thin net band in one frame; `updateShuttle` now does a **swept** crossing test with interpolated height at the net plane
- [x] **Ult out-of-bounds & "never reaches"** — `clampUltShotInBounds` is now **two-sided** (caps overshoot AND pushes short/vertical ults onto the opponent's half; skips Sofia's intentional dink)
- [x] **AI Rage Art cinematic too rare** — `chooseAIUltIntent` threshold 0.6 → 0.45 + small base, so the AI shows its Art (cinematic) far more often
- [ ] Same net-tunneling guard should be mirrored in `shared/simulation.js` for ONLINE play (this fix covers local/AI mode only)

## Phase 4 — UI / Menus, FX & SFX  `[ ]`

- [ ] Pixel/bitmap menu framing + HUD
- [ ] Pixelated ultimate/momentum FX (blocky auras, dithered bursts, hit-sparks)
- [ ] Chiptune-flavored SFX pass (hits, smashes, crowd, UI blips) — new addition

---

## Tuning knobs

- `PX` art-pixel size (default 3)
- Palette depth (shades per character)
- Face pixel resolution
- Scanline intensity / vignette strength
