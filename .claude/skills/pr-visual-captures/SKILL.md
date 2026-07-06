---
name: pr-visual-captures
description: >-
  Produce before/after visual proof for any PR that changes something a user can
  see, and embed it INSIDE the PR's Before/After table. Static change (colours,
  layout, component, exported output) -> before/after PNG screenshots; interaction
  or motion change (press, hover, transition, drag) -> a short GIF. Assets live on
  a dedicated chore/artifacts branch (never a branch that merges to main). Use when
  opening or updating a PR for a visual change, or when asked to "add before/after
  screenshots", "make a GIF of the change", or "capture the UI change".
---

# PR visual captures

Every PR that changes anything a user can **see** (colours, layout, components, flows,
exported/rendered output, interaction feel) ships **real before/after captures**,
embedded **inside the Before/After table cells** — not just a textual state-delta.
Docs-only / non-visual PRs are exempt: state "no visual change" in the PR.

## 1. Pick the medium
- **Static** change (colour, layout, component, exported output) -> before/after **PNG
  screenshots**, tight-cropped to the surface that changed.
- **Interaction / motion** change (press, hover, transition, drag) -> a short **GIF**.
  Motion is the point: a 3% press-scale is invisible in a still, so it must move.

## 2. Where assets live — the `chore/artifacts` branch (do not skip)
Never commit capture binaries to the feature branch — they would merge into `main`
history. Put them on a dedicated, never-merged **`chore/artifacts`** branch:

```sh
# first time only — branch it off main:
git worktree add -b chore/artifacts "$TMP/artifacts" origin/main
# thereafter just refresh it:
git -C "$TMP/artifacts" pull --ff-only --no-verify

mkdir -p "$TMP/artifacts/pr-assets/<task-id>"
cp <pngs-or-gifs> "$TMP/artifacts/pr-assets/<task-id>/"
git -C "$TMP/artifacts" add pr-assets/<task-id>
git -C "$TMP/artifacts" commit --no-verify -m "chore(artifacts): <task-id> captures"
git -C "$TMP/artifacts" push --no-verify -u origin chore/artifacts
```

Embed in the PR body via **raw blob URLs** (render on github.com, and work for private
repos when the viewer is logged in):

```html
<img width="300" src="https://github.com/<owner>/<repo>/blob/chore/artifacts/pr-assets/<task-id>/<file>?raw=true">
```

The branch name has a slash; github resolves `chore/artifacts` because no `chore`
branch exists — keep it that way. Verify the file resolves before embedding:
`gh api "repos/<owner>/<repo>/contents/pr-assets/<task-id>/<file>?ref=chore/artifacts"`.

## 3. Embed the images INSIDE the Before/After table
```md
## Before / After
| Behaviour | Before | After |
|---|---|---|
| <the headline change> | <img …before…><br>one-line delta | <img …after…><br>one-line delta |
| <secondary behaviour>  | text state delta | text state delta |
```
Put the images in the cells of the headline row(s); secondary rows can stay text.

## 4. Produce the captures (Playwright web e2e harness)
1. Write a **throwaway** spec `packages/web/e2e/_capture-*.spec.ts` — import from
   `./fixtures`, `SERVER` from the seed; seed the state you need (a db with tags/charts,
   or open the sample doc via `pnpm seed`). Drive the app to the surface. For a GIF,
   enable `video` recording; for stills, `element.screenshot()`.
2. **AFTER** = the branch state: `pnpm --filter @book.dev/ui build && rm -rf packages/web/.next`,
   run just this spec (chromium), collect the PNGs / webm.
3. **BEFORE** = revert only the changed files to the base, rebuild, re-run:
   ```sh
   BASE=<merge-base-or-main>
   CHANGED=$(git diff --name-only "$BASE"..HEAD -- packages)
   git checkout "$BASE" -- $CHANGED 2>/dev/null
   for f in $CHANGED; do git cat-file -e "$BASE:$f" 2>/dev/null || rm -f "$f"; done  # drop added files
   # rebuild ui + rm -rf packages/web/.next, run the spec -> before PNGs/webm
   git checkout HEAD -- $CHANGED   # RESTORE on ALL exit paths
   ```
4. Confirm `git status` shows **only** the new assets; `git diff HEAD -- packages` must be
   empty (the revert fully backed out). Delete the throwaway spec + any `test-results/`.

## 5. GIFs — no system ffmpeg required
Playwright records `video` as `.webm`, but its **bundled ffmpeg is stripped** (no GIF
muxer, no palettegen/paletteuse), and system `ffmpeg`/`gifski` are often absent. Convert
with `scripts/webm-to-gif.mjs` in this skill: the bundled ffmpeg extracts cropped+scaled
PNG frames, `sharp` decodes them, and `gifenc` encodes the GIF. Tight-crop to the control,
~12-15 fps, target <=~800KB. For a press, hold `mouse.down()` ~700ms then `mouse.up()`,
repeated once, so the shrink/no-shrink is legible under a tight crop.

## 6. Prove it (don't just eyeball)
Where a change is measurable, assert it in the capture: e.g. read the pressed vs resting
`getBoundingClientRect` (a press that no longer scales must be geometry-identical), or
compute WCAG contrast on real computed colours. Numbers in the PR beat "looks fine".

## 7. Enforcement
- The Manager does not open a visual PR without captures.
- The design reviewer (Devon) bounces any visual PR whose before/after is text-only.
- See the Notion way-of-working "Visual PR captures" and the PR-review playbook.
