// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// What a terminal tab draws in front of its label. The backend (`repoicon.rs`)
// answers "which repo, and does it ship a logo"; this is the half that decides
// what appears when it doesn't — which, across a real `~`, is most of the time.
//
// The fallback is therefore not an error state, it is the common state, and it
// gets treated as a design surface: each logo-less repo is given its own
// **Julia set**, derived from its name. The repo's name hashes to a point `c`
// inside the Mandelbrot set, and the mark is the filled Julia set of z → z² + c.
//
// Why Julia rather than a zoom of the Mandelbrot set itself: almost every
// location in a Mandelbrot zoom looks like the same black edge, so tiles would
// be near-indistinguishable. Julia sets vary enormously with `c` — fat lobes,
// dendrites, spirals, winged forms — and every one of them is 2-fold
// symmetric about the origin, which is what makes them read as an *emblem*
// rather than an arbitrary crop.
//
// Two properties are enforced rather than hoped for:
//
//   * **Connected.** A `c` outside the Mandelbrot set gives Cantor dust — a
//     scatter of specks that reads as noise at 14 px. Candidates are tested for
//     membership and dust is never selected. (This is Fatou's dichotomy: the
//     Julia set is connected exactly when `c` is in the Mandelbrot set.)
//   * **Legible at tile size.** Candidates are scored on the rendered tile, and
//     the winner is the one with the most boundary structure that still has
//     enough body to see. The view window is then fitted to the set's own
//     extent, so every mark is centered and fills its tile instead of floating
//     in a margin or being clipped.
//
// Everything here is deterministic: the same repo name always produces the same
// mark. `markFor` is memoized because the tab strip re-derives its entries
// often and the search is ~1 ms of arithmetic.

import { fnv1a32Hex } from "./thumbs";

/** `repo_icon`'s reply. `dataUrl` is null when the repo ships no usable logo. */
export interface RepoIconResult {
  root: string;
  name: string;
  dataUrl: string | null;
}

/** The generated mark for one repo: a Julia set and the window to draw it in. */
export interface RepoMark {
  /** Real part of the Julia constant. Always inside the Mandelbrot set. */
  cx: number;
  /** Imaginary part of the Julia constant. */
  cy: number;
  /** Half-width of the complex-plane window, fitted to this set's extent. */
  view: number;
  /** Window rotation in radians.
   *
   *  A filled Julia set is symmetric under z → −z and nothing more, so turning
   *  the window genuinely turns the silhouette. That is a second axis of
   *  distinctness for free: two repos whose sets happen to land on a similar
   *  form still read apart when one of them is on its side. */
  rot: number;
  /** Base hue, 0–359. */
  hue: number;
}

/** The mark for one tab.
 *
 *  Note the flat shape rather than a discriminated union: the generated mark is
 *  populated even when `src` is set, so an `<img>`'s `onError` can swap to it in
 *  place without a second lookup. */
export interface TabIcon {
  /** The repo's own logo as a `data:` URL, or null → draw the Julia mark. */
  src: string | null;
  /** The generated fallback, always present. */
  mark: RepoMark;
  /** A flat fill for the last resort where no canvas is available at all. */
  tint: string;
}

/** Escape-time iteration cap. Also the "this point never escaped" sentinel —
 *  at tile size a slightly generous cap reads as a pleasantly solid body rather
 *  than a thin one, so there is no reason to go higher. */
const ITERATIONS = 64;

/** How many `c` candidates a name is scored over. The search is the only thing
 *  standing between "a striking emblem" and "a beige blob", and at ~1 ms for
 *  the whole sweep — once per repo, then cached — there is no reason to be
 *  stingy. Measured over 1500 names, this never once fell through to the
 *  cardioid fallback below. */
const CANDIDATES = 28;

/** Iterations used to decide Mandelbrot membership. Enough to reject dust
 *  reliably without paying for boundary precision nobody can see at 14 px. */
const MEMBERSHIP_ITERATIONS = 200;

/** Resolution of the two throwaway passes: one to measure a set's extent, one
 *  to score it. Deliberately coarse — they are decisions, not pictures. */
const PROBE_SIZE = 40;
const SCORE_SIZE = 32;

/** Escape time of one orbit: how many steps of z → z² + c it takes to leave the
 *  radius-2 disk, or `max` if it never does. Shared by both readings we need —
 *  Julia (start at the pixel) and Mandelbrot membership (start at the origin) —
 *  because they are the same iteration with a different starting point. */
function escapeTime(
  cx: number,
  cy: number,
  zx0: number,
  zy0: number,
  max: number,
): number {
  let zx = zx0;
  let zy = zy0;
  let i = 0;
  while (i < max && zx * zx + zy * zy <= 4) {
    const next = zx * zx - zy * zy + cx;
    zy = 2 * zx * zy + cy;
    zx = next;
    i++;
  }
  return i;
}

/** Is `c` in the Mandelbrot set — i.e. would its Julia set be connected? */
function inMandelbrot(cx: number, cy: number): boolean {
  return (
    escapeTime(cx, cy, 0, 0, MEMBERSHIP_ITERATIONS) === MEMBERSHIP_ITERATIONS
  );
}

/** The filled Julia set for `c` lies entirely inside this radius. Standard
 *  bound, so the extent probe below never has to guess a window. */
function escapeRadius(cx: number, cy: number): number {
  return (1 + Math.sqrt(1 + 4 * Math.hypot(cx, cy))) / 2;
}

/** Escape times over a square window, row-major. The window is centred on the
 *  origin and turned by `rot`, so the same set can be framed at any angle. */
function juliaGrid(
  cx: number,
  cy: number,
  size: number,
  view: number,
  rot: number,
): Int32Array {
  const grid = new Int32Array(size * size);
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  for (let py = 0; py < size; py++) {
    const v = ((py + 0.5) / size) * 2 * view - view;
    for (let px = 0; px < size; px++) {
      const u = ((px + 0.5) / size) * 2 * view - view;
      const zx = u * cos - v * sin;
      const zy = u * sin + v * cos;
      grid[py * size + px] = escapeTime(cx, cy, zx, zy, ITERATIONS);
    }
  }
  return grid;
}

/** The window that frames this set: its own extent plus a small margin.
 *
 *  Without this a compact set floats in a sea of background and a sprawling one
 *  runs off the edges — both of which stop it reading as a deliberate emblem.
 *  Julia sets are symmetric under z → −z, so a single half-width centred on the
 *  origin frames any of them. Returns 0 for a set too small to be worth drawing,
 *  which the search treats as a rejected candidate. */
function fitView(cx: number, cy: number, rot: number): number {
  const bound = escapeRadius(cx, cy);
  const grid = juliaGrid(cx, cy, PROBE_SIZE, bound, rot);
  let extent = 0;
  for (let py = 0; py < PROBE_SIZE; py++) {
    for (let px = 0; px < PROBE_SIZE; px++) {
      if (grid[py * PROBE_SIZE + px] !== ITERATIONS) continue;
      const x = Math.abs(((px + 0.5) / PROBE_SIZE) * 2 * bound - bound);
      const y = Math.abs(((py + 0.5) / PROBE_SIZE) * 2 * bound - bound);
      extent = Math.max(extent, x, y);
    }
  }
  return extent > 0.12 ? Math.min(bound, extent * 1.08) : 0;
}

/** How good this mark would look, judged on the tile it would actually render.
 *
 *  `edge` — how much interior/exterior boundary crosses the tile — is the term
 *  that matters: it is what separates a rabbit or a spiral from a smooth oval,
 *  and it is the only thing that keeps two repos from looking alike. `fill` only
 *  gets a floor and a ceiling, because scoring *toward* a target fill was
 *  measurably worse: it pulled every repo to the same comfortable blob. */
function scoreMark(
  cx: number,
  cy: number,
  view: number,
  rot: number,
): number {
  const grid = juliaGrid(cx, cy, SCORE_SIZE, view, rot);
  let inside = 0;
  for (let i = 0; i < grid.length; i++) if (grid[i] === ITERATIONS) inside++;
  let edges = 0;
  for (let y = 0; y < SCORE_SIZE; y++) {
    for (let x = 0; x < SCORE_SIZE - 1; x++) {
      const a = grid[y * SCORE_SIZE + x] === ITERATIONS;
      const b = grid[y * SCORE_SIZE + x + 1] === ITERATIONS;
      if (a !== b) edges++;
    }
  }
  const total = SCORE_SIZE * SCORE_SIZE;
  const fill = inside / total;
  const edge = edges / total;
  // Wispy (nothing to see) and near-solid (nothing to distinguish) are the two
  // ways a tile fails; everything between them is judged on structure alone.
  return (
    edge - 1.2 * Math.max(0, 0.16 - fill) - 0.5 * Math.max(0, fill - 0.55)
  );
}

/** A point guaranteed to be inside the Mandelbrot set's main cardioid.
 *
 *  The parameterization c = μ/2 − μ²/4 with |μ| < 1 covers the cardioid's
 *  interior exactly, so this can never return dust. It is the search's safety
 *  net, not its main path: cardioid-interior Julia sets are quasicircles —
 *  respectable, but smooth — which is precisely why the scored search beats
 *  them whenever it finds anything at all. */
function cardioidPoint(name: string): { cx: number; cy: number } {
  const theta = (hashUnit(`t${name}`) * Math.PI * 2) % (Math.PI * 2);
  const r = 0.88 + hashUnit(`r${name}`) * 0.1;
  const mx = r * Math.cos(theta);
  const my = r * Math.sin(theta);
  const m2x = r * r * Math.cos(2 * theta);
  const m2y = r * r * Math.sin(2 * theta);
  return { cx: mx / 2 - m2x / 4, cy: my / 2 - m2y / 4 };
}

/** A salted hash of `key`, as a fraction in [0, 1). */
function hashUnit(key: string): number {
  return (parseInt(fnv1a32Hex(key), 16) % 100000) / 100000;
}

function computeMark(name: string): RepoMark {
  const hue = parseInt(fnv1a32Hex(name), 16) % 360;
  // Fixed up front so the framing and the score both see the orientation the
  // tile will actually be drawn at.
  const rot = hashUnit(`o${name}`) * Math.PI * 2;

  let best: { cx: number; cy: number; view: number; quality: number } | null =
    null;
  for (let k = 0; k < CANDIDATES; k++) {
    // A box around the Mandelbrot set. Roughly a quarter of these land inside
    // it; the rest are rejected before anything expensive happens.
    const cx = -2.0 + hashUnit(`c${k}${name}`) * 2.6;
    const cy = -1.2 + hashUnit(`d${k}${name}`) * 2.4;
    if (!inMandelbrot(cx, cy)) continue;
    const view = fitView(cx, cy, rot);
    if (view === 0) continue;
    const quality = scoreMark(cx, cy, view, rot);
    if (!best || quality > best.quality) best = { cx, cy, view, quality };
  }
  if (best) {
    return { cx: best.cx, cy: best.cy, view: best.view, rot, hue };
  }

  const { cx, cy } = cardioidPoint(name);
  return { cx, cy, view: fitView(cx, cy, rot) || 1.4, rot, hue };
}

// Memoized: the tab strip re-derives its entries on every cwd poll, and the
// candidate search is real arithmetic. Keyed by name, permanent for the session
// — the answer is a pure function of the name.
const markCache = new Map<string, RepoMark>();

/** The Julia mark for a repo name. Deterministic and memoized. */
export function markFor(name: string): RepoMark {
  let mark = markCache.get(name);
  if (!mark) {
    mark = computeMark(name);
    markCache.set(name, mark);
  }
  return mark;
}

/** HSL → RGB. `h` in degrees, `s`/`l` in [0, 1]. */
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = ((((h % 360) + 360) % 360) / 60) % 6;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = l - c / 2;
  return [
    Math.round((r + m) * 255),
    Math.round((g + m) * 255),
    Math.round((b + m) * 255),
  ];
}

/** Render a mark to RGBA pixels, row-major, `size × size`.
 *
 *  The set itself is drawn bright and the escape bands fall away into a dark
 *  ground, so at 14 px the eye gets a lit shape on a solid chip — the same
 *  visual weight a real logo has, rather than something that reads as a
 *  rendering failure. The bands carry a slight hue shift off the body, which is
 *  what stops the tile looking like flat two-tone clip art.
 *
 *  Kept free of any canvas or DOM reference so the whole appearance is testable
 *  as data (see `repoMarkImage.ts` for the few lines that put it on screen). */
export function markPixels(mark: RepoMark, size: number): Uint8ClampedArray {
  // One palette entry per possible escape time, so the per-pixel loop is a
  // lookup rather than a color conversion.
  const palette = new Uint8ClampedArray((ITERATIONS + 1) * 3);
  for (let i = 0; i <= ITERATIONS; i++) {
    const [r, g, b] =
      i === ITERATIONS
        ? hslToRgb(mark.hue, 0.72, 0.66)
        : hslToRgb(mark.hue + 28, 0.52, 0.08 + 0.3 * Math.sqrt(i / ITERATIONS));
    palette[i * 3] = r;
    palette[i * 3 + 1] = g;
    palette[i * 3 + 2] = b;
  }

  const pixels = new Uint8ClampedArray(size * size * 4);
  const grid = juliaGrid(mark.cx, mark.cy, size, mark.view, mark.rot);
  for (let i = 0; i < grid.length; i++) {
    const p = grid[i] * 3;
    pixels[i * 4] = palette[p];
    pixels[i * 4 + 1] = palette[p + 1];
    pixels[i * 4 + 2] = palette[p + 2];
    pixels[i * 4 + 3] = 255;
  }
  return pixels;
}

/** The mark to draw, from whatever the backend has (or hasn't) answered yet.
 *
 *  `fallbackName` covers both the pending state — the lookup is async, and a
 *  tab renders before it lands — and the case where there is no repo at all
 *  (a bare shell in `$HOME`, whose label is "zsh"). Either way a tab always has
 *  a mark; it may just start as a Julia set and gain a logo a moment later. */
export function iconFor(
  res: RepoIconResult | undefined,
  fallbackName: string,
): TabIcon {
  const name = res?.name || fallbackName;
  const mark = markFor(name);
  return {
    src: res?.dataUrl ?? null,
    mark,
    tint: `hsl(${mark.hue} 55% 45%)`,
  };
}
