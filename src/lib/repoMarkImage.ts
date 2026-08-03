// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// The few lines that put a generated repo mark on screen. Everything that
// decides how the mark *looks* lives in `repoIcon.ts` as pure data; this is only
// the canvas plumbing that turns those pixels into something an `<img>` can
// take, kept apart so the appearance stays testable without a DOM.

import { markPixels, type RepoMark } from "./repoIcon";

/** Rendered size in device pixels. The mark displays at 14 CSS px, so this is
 *  comfortably past 2× — the browser's downscale then does the antialiasing for
 *  free, which is far better than anything worth hand-rolling at this size. */
const TILE = 64;

// Keyed by the mark, not the repo, so two repos that somehow resolve to the
// same mark share one bitmap. Permanent for the session: a mark is a pure
// function of a name, and re-rasterizing it would never produce anything new.
const cache = new Map<string, string | null>();

function keyOf(mark: RepoMark): string {
  return [mark.hue, mark.cx, mark.cy, mark.view, mark.rot]
    .map((n) => n.toFixed(6))
    .join(":");
}

/** A repo's generated mark as a PNG `data:` URL, or null if this environment
 *  can't rasterize one (in which case the caller falls back to a flat chip).
 *  Failures are cached too — a missing 2D context will still be missing on the
 *  next render, and retrying it once per frame would be the expensive mistake. */
export function markImage(mark: RepoMark): string | null {
  const key = keyOf(mark);
  const hit = cache.get(key);
  if (hit !== undefined) return hit;

  let url: string | null = null;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = TILE;
    canvas.height = TILE;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      const image = ctx.createImageData(TILE, TILE);
      image.data.set(markPixels(mark, TILE));
      ctx.putImageData(image, 0, 0);
      url = canvas.toDataURL("image/png");
    }
  } catch {
    url = null;
  }
  cache.set(key, url);
  return url;
}
