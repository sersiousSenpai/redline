// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  fadeOutKeyframes,
  inverseTransform,
  shouldSwap,
  springInKeyframes,
  FADE_OUT_MS,
  SWAP_MS,
  type SwapRect,
} from "./springSwap";

const ISLAND: SwapRect = { left: 420, top: 300, width: 560, height: 120 };
const HOST: SwapRect = { left: 200, top: 60, width: 1120, height: 600 };

describe("inverseTransform", () => {
  it("puts the host exactly on the island's box", () => {
    // scale 560/1120 = 0.5, 120/600 = 0.2; translate 220, 240.
    expect(inverseTransform(ISLAND, HOST)).toBe(
      "translate(220px, 240px) scale(0.5, 0.2)",
    );
  });

  it("is identity when the boxes already match", () => {
    expect(inverseTransform(HOST, HOST)).toBe(
      "translate(0px, 0px) scale(1, 1)",
    );
  });

  it("degrades to none rather than dividing by zero", () => {
    const flat = { left: 0, top: 0, width: 0, height: 0 };
    expect(inverseTransform(ISLAND, flat)).toBe("none");
  });
});

describe("shouldSwap", () => {
  it("springs for a real expansion", () => {
    expect(shouldSwap(ISLAND, HOST, false)).toBe(true);
  });

  it("never runs under reduced motion", () => {
    expect(shouldSwap(ISLAND, HOST, true)).toBe(false);
  });

  it("declines when the start is already most of the destination", () => {
    const nearly = { left: 210, top: 70, width: 1000, height: 560 };
    expect(shouldSwap(nearly, HOST, false)).toBe(false);
  });

  it("declines on a missing or degenerate box", () => {
    expect(shouldSwap(null, HOST, false)).toBe(false);
    expect(shouldSwap(ISLAND, null, false)).toBe(false);
    expect(
      shouldSwap(ISLAND, { left: 0, top: 0, width: 0, height: 0 }, false),
    ).toBe(false);
  });
});

describe("springInKeyframes", () => {
  it("starts on the island's box and ends at identity", () => {
    const frames = springInKeyframes(ISLAND, HOST);
    expect(frames[0].transform).toBe(inverseTransform(ISLAND, HOST));
    expect(frames[frames.length - 1].transform).toBe("none");
  });

  it("animates ONLY transform, opacity and radius", () => {
    // Three attempts died on the alternatives. `clip-path` does not reliably
    // reach a `backdrop-filter` descendant in WebKit — which is most of what
    // the Drafter is made of — and animating geometry (width/height/top/left)
    // puts layout on every frame. If any of those reappear here, so does the
    // bug.
    const allowed = new Set(["transform", "opacity", "borderRadius", "offset"]);
    for (const f of springInKeyframes(ISLAND, HOST)) {
      for (const key of Object.keys(f)) {
        expect(allowed.has(key), `${key} is animated`).toBe(true);
      }
    }
  });

  it("becomes opaque well before the shape lands", () => {
    // The island was a solid object; a surface still fading while it is still
    // growing reads as materializing out of nothing.
    const frames = springInKeyframes(ISLAND, HOST);
    expect(Number(frames[0].opacity)).toBeGreaterThan(0);
    const solid = frames.find((f) => f.opacity === 1);
    expect(Number(solid?.offset)).toBeLessThanOrEqual(0.4);
  });

  it("keeps the corners round while the shape is moving", () => {
    const radii = springInKeyframes(ISLAND, HOST).map((f) =>
      Number(/(\d+)px/.exec(String(f.borderRadius))?.[1]),
    );
    expect(Math.max(...radii)).toBeGreaterThan(radii[0]);
    expect(radii[radii.length - 1]).toBeGreaterThan(0);
  });
});

describe("fadeOutKeyframes", () => {
  it("takes the door away rather than letting it vanish", () => {
    // The whole-screen disappearance on frame one is the "janky navigation"
    // every earlier attempt left behind.
    const frames = fadeOutKeyframes();
    expect(frames[0].opacity).toBe(1);
    expect(frames[frames.length - 1].opacity).toBe(0);
  });

  it("is gone well before the spring lands", () => {
    // Two full surfaces legible on top of each other is worse than a cut.
    expect(FADE_OUT_MS).toBeLessThan(SWAP_MS);
  });
});

// A source invariant, because this exact mistake has been made twice.
//
// `fill: "backwards"` stops applying the moment the animation ENDS, so the
// element falls back to its underlying style — which is the inline inverse
// transform the component writes before starting, i.e. the tiny box at the
// island's position. The surface snaps back to island-size for a frame at the
// instant it lands, then jumps to full size when `onfinish` clears the inline.
// That reads as content leaping out to the corner.
describe("the spring holds its landing", () => {
  const src = readFileSync(
    join(process.cwd(), "src/components/SpringSwap.tsx"),
    "utf8",
  );

  it("fills BOTH ways — never backwards alone", () => {
    const at = src.indexOf("springInKeyframes(from, host)");
    expect(at).toBeGreaterThan(-1);
    const options = src.slice(at, at + 1600);
    expect(options).toContain('fill: "both"');
    expect(options).not.toContain('fill: "backwards"');
  });

  it("cancels the fill before clearing the inline styles it overrides", () => {
    const settle = src.indexOf("const settle = ()");
    expect(settle).toBeGreaterThan(-1);
    const body = src.slice(settle, settle + 700);
    expect(body.indexOf("anim.cancel()")).toBeLessThan(
      body.indexOf('el.style.transform = ""'),
    );
  });
});
