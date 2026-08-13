#!/usr/bin/env node
// webm-to-gif.mjs — convert a Playwright-recorded .webm into a small looping GIF.
//
// Why this exists: Playwright's *bundled* ffmpeg (used for `video` recording) is a
// stripped build — it has no GIF muxer and no palettegen/paletteuse/fps filters — and
// system `ffmpeg` / `gifski` / ImageMagick are frequently absent on CI + dev machines.
// Pipeline that always works: bundled ffmpeg extracts cropped+scaled PNG frames ->
// `sharp` decodes each to raw RGBA -> `gifenc` quantizes + encodes an animated GIF.
//
// Deps: `sharp` (already in this repo's node_modules) and `gifenc`
//   (`pnpm add -Dw gifenc` or run via `pnpm dlx`). Both are pure-JS friendly.
//
// Usage:
//   node webm-to-gif.mjs <in.webm> <out.gif> [--crop WxH+X+Y] [--scale W] [--fps 12] [--since 4.2]
//     --crop     ffmpeg crop filter geometry, e.g. 140x110+597+375 (w x h + x + y). Optional.
//     --scale    output width in px (height auto, aspect kept). Default 420.
//     --fps      frames per second. Default 12.
//     --since    seconds before end-of-file to start (grabs the tail). Default: whole clip.
//     --start    seconds from the start to begin (for slicing one recording into
//                several GIFs, e.g. a sidebar-select beat then a tab-switch beat).
//     --duration seconds to keep after --start. Default: to end of clip.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
// gifenc's CJS build (dist/gifenc.js) exports via a computed __export() helper
// that Node's cjs-module-lexer can't statically detect, so named imports fail
// ("Named export 'GIFEncoder' not found") even though the export exists at
// runtime. Import the default (whole CJS exports object) and destructure.
import gifencPkg from 'gifenc';
const { GIFEncoder, quantize, applyPalette } = gifencPkg;

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : def;
}

const [inWebm, outGif] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!inWebm || !outGif) {
  console.error('usage: node webm-to-gif.mjs <in.webm> <out.gif> [--crop WxH+X+Y] [--scale W] [--fps 12] [--since S]');
  process.exit(2);
}
const crop = arg('crop');            // e.g. "140x110+597+375"
const scaleW = Number(arg('scale', '420'));
const fps = Number(arg('fps', '12'));
const since = arg('since');          // seconds from end, optional
const start = arg('start');          // seconds from start, optional
const duration = arg('duration');    // seconds to keep after --start, optional

// Find Playwright's bundled ffmpeg (macOS/linux layouts).
function findFfmpeg() {
  const root = join(homedir(), 'Library', 'Caches', 'ms-playwright'); // macOS
  const roots = [root, join(homedir(), '.cache', 'ms-playwright')];    // linux
  for (const r of roots) {
    let dirs = [];
    try { dirs = readdirSync(r).filter((d) => d.startsWith('ffmpeg-')); } catch { /* skip */ }
    for (const d of dirs) {
      for (const name of ['ffmpeg-mac', 'ffmpeg-linux', 'ffmpeg']) {
        const p = join(r, d, name);
        try { execFileSync(p, ['-version'], { stdio: 'ignore' }); return p; } catch { /* try next */ }
      }
    }
  }
  // fall back to a system ffmpeg on PATH if the bundled one isn't found
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return 'ffmpeg'; } catch { /* none */ }
  throw new Error('No ffmpeg found (bundled Playwright ffmpeg or system ffmpeg).');
}

const ffmpeg = findFfmpeg();
const work = mkdtempSync(join(tmpdir(), 'webm2gif-'));
try {
  // Build the ffmpeg filter chain: optional tail seek -> crop -> scale -> fps.
  const filters = [];
  if (crop) {
    const m = /^(\d+)x(\d+)\+(\d+)\+(\d+)$/.exec(crop);
    if (!m) throw new Error(`bad --crop "${crop}" (want WxH+X+Y)`);
    filters.push(`crop=${m[1]}:${m[2]}:${m[3]}:${m[4]}`);
  }
  filters.push(`scale=${scaleW}:-1:flags=lanczos`);
  // NOT `fps=` as a -vf filter: Playwright's bundled ffmpeg is built with
  // --disable-everything and only enables crop/scale/pad (see `-filters`) —
  // the fps filter isn't compiled in and errors ("No option name near ...").
  // `-r` is a demuxer/muxer-level output option (frame drop/dup by PTS), not
  // a filtergraph filter, so it works without that filter being available.
  const pre = since
    ? ['-sseof', `-${since}`]
    : [...(start ? ['-ss', start] : []), ...(duration ? ['-t', duration] : [])];
  execFileSync(
    ffmpeg,
    [...pre, '-i', inWebm, '-vf', filters.join(','), '-r', String(fps), join(work, 'f-%04d.png')],
    { stdio: 'ignore' },
  );

  const frames = readdirSync(work).filter((f) => f.endsWith('.png')).sort();
  if (!frames.length) throw new Error('ffmpeg produced no frames');

  // Encode: decode each PNG to RGBA, quantize to a shared 256-colour palette per frame.
  const gif = GIFEncoder();
  const delay = Math.round(1000 / fps);
  let w = 0, h = 0;
  for (const f of frames) {
    const { data, info } = await sharp(join(work, f)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    w = info.width; h = info.height;
    const palette = quantize(data, 256, { format: 'rgba4444' });
    const index = applyPalette(data, palette, 'rgba4444');
    gif.writeFrame(index, w, h, { palette, delay });
  }
  gif.finish();
  writeFileSync(outGif, gif.bytes());
  const kb = (readFileSync(outGif).length / 1024).toFixed(0);
  console.log(`wrote ${outGif} — ${frames.length} frames, ${w}x${h}, ${kb}KB`);
  if (kb > 800) console.warn(`note: ${kb}KB > 800KB target — raise --fps interval, tighten --crop, or lower --scale`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
