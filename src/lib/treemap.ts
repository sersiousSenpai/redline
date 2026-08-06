// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian

// Squarified treemap layout (Bruls–Huizing–van Wijk) for Health's "where does
// my memory live" card — near-square tiles whose AREA is exactly proportional
// to value. Pure, deterministic, dependency-free (the `virtual.ts`
// discipline); the renderer is dumb absolutely-positioned divs.

export interface TreemapDatum {
  id: string;
  label: string;
  value: number;
}

export interface TreemapRect extends TreemapDatum {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Worst (highest) aspect ratio a row would have if laid at length `side`. */
function worstAspect(areas: number[], side: number): number {
  const sum = areas.reduce((s, a) => s + a, 0);
  const rowThickness = sum / side;
  let worst = 0;
  for (const a of areas) {
    const len = a / rowThickness;
    worst = Math.max(worst, len / rowThickness, rowThickness / len);
  }
  return worst;
}

/**
 * Lay out `data` inside `width` × `height`. Zero/negative values are dropped
 * (an empty class is absence, not a sliver); input order is normalized to
 * value-descending (ties by label, then id) so the same masses always draw
 * the same picture. Rows go against the shorter side; a tile joins the
 * current row only while it improves the row's worst aspect ratio.
 */
export function squarify(
  data: TreemapDatum[],
  width: number,
  height: number,
): TreemapRect[] {
  const items = data
    .filter((d) => d.value > 0)
    .sort(
      (a, b) =>
        b.value - a.value || a.label.localeCompare(b.label) || (a.id < b.id ? -1 : 1),
    );
  if (!items.length || width <= 0 || height <= 0) return [];

  const total = items.reduce((s, d) => s + d.value, 0);
  const scale = (width * height) / total;
  const areas = items.map((d) => d.value * scale);

  const out: TreemapRect[] = [];
  let x = 0;
  let y = 0;
  let w = width;
  let h = height;
  let i = 0;
  while (i < items.length) {
    const side = Math.min(w, h);
    // Grow the row while the worst aspect ratio keeps improving.
    let end = i + 1;
    let best = worstAspect(areas.slice(i, end), side);
    while (end < items.length) {
      const next = worstAspect(areas.slice(i, end + 1), side);
      if (next > best) break;
      best = next;
      end++;
    }
    const rowAreas = areas.slice(i, end);
    const rowSum = rowAreas.reduce((s, a) => s + a, 0);
    const thickness = rowSum / side;
    // Lay the row against the shorter side, then shrink the free rectangle.
    let offset = 0;
    for (let k = i; k < end; k++) {
      const len = areas[k] / thickness;
      if (w <= h) {
        out.push({ ...items[k], x: x + offset, y, w: len, h: thickness });
      } else {
        out.push({ ...items[k], x, y: y + offset, w: thickness, h: len });
      }
      offset += len;
    }
    if (w <= h) {
      y += thickness;
      h -= thickness;
    } else {
      x += thickness;
      w -= thickness;
    }
    i = end;
  }
  return out;
}
