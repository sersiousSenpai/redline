import { describe, expect, it } from "vitest";
import {
  calibrateScale,
  fnv1a32Hex,
  INITIAL_THUMB_SCALE,
  placeholderFor,
  planCaptures,
  thumbKey,
  THUMB_FAIL_COOLDOWN_MS,
  THUMB_STALE_MS,
  type ThumbEntry,
} from "./thumbs";

describe("calibrateScale", () => {
  it("stays at 1 when WebKit already backs the image at display scale", () => {
    // Asked for 280 points on a 2× display, got 560 real pixels — already
    // exactly as sharp as the screen, so keep asking for the CSS width.
    expect(calibrateScale(280, 560, 2)).toBe(1);
  });

  it("doubles when WebKit hands back points one-for-one", () => {
    // Asked for 280, got 280 on a 2× display — we're a factor short.
    expect(calibrateScale(280, 280, 2)).toBe(2);
  });

  it("asks for exactly display-sharp on a non-retina screen", () => {
    expect(calibrateScale(280, 280, 1)).toBe(1);
    expect(calibrateScale(280, 560, 1)).toBe(1); // clamped — never below 1
  });

  it("the starting guess is the one that cannot oversize", () => {
    // Starting at 2 on the common (backing === dpr) setup would write 4×
    // files before anything had a chance to measure.
    expect(INITIAL_THUMB_SCALE).toBe(1);
  });

  it("degrades to 1 on nonsense rather than inflating every later capture", () => {
    const nonsense: [number, number, number][] = [
      [0, 560, 2],
      [280, 0, 2],
      [280, 560, 0],
      [NaN, 560, 2],
      [280, NaN, 2],
    ];
    for (const [requested, pixels, dpr] of nonsense) {
      expect(calibrateScale(requested, pixels, dpr)).toBe(1);
    }
  });

  it("is clamped so a strange reading can't run away", () => {
    expect(calibrateScale(280, 1, 3)).toBeLessThanOrEqual(3);
  });
});

describe("thumbKey", () => {
  it("is deterministic and readable", () => {
    expect(thumbKey("/Users/me/app", 5173)).toBe(
      thumbKey("/Users/me/app", 5173),
    );
    expect(thumbKey("/Users/me/app", 5173)).toMatch(/^p5173-[0-9a-f]{8}$/);
  });

  it("separates different paths and different ports", () => {
    expect(thumbKey("/a", 3000)).not.toBe(thumbKey("/b", 3000));
    expect(thumbKey("/a", 3000)).not.toBe(thumbKey("/a", 3001));
  });

  it("stays inside the charset Rust's valid_key accepts", () => {
    // The two functions are a pair: anything this mints must be a legal
    // filename on the Rust side, for any path a user can have.
    const wild = "/Users/me/../ünïcode path/with;semi&and*stars/😀";
    for (const port of [1, 80, 65535]) {
      expect(thumbKey(wild, port)).toMatch(/^[A-Za-z0-9._-]+$/);
    }
  });

  it("hashes without collapsing similar inputs", () => {
    expect(fnv1a32Hex("a")).not.toBe(fnv1a32Hex("b"));
    expect(fnv1a32Hex("")).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe("planCaptures", () => {
  const now = 1_700_000_000_000;
  const entry = (key: string, ageMs: number): ThumbEntry => ({
    key,
    path: `/thumbs/${key}.png`,
    modifiedMs: now - ageMs,
  });
  const live = (...keys: string[]) => keys.map((key) => ({ key, live: true }));

  it("captures nothing when every card is fresh", () => {
    const entries = new Map([["a", entry("a", 1000)]]);
    expect(planCaptures(live("a"), entries, new Map(), now)).toEqual([]);
  });

  it("puts MISSING first in grid order, then stale oldest-first", () => {
    const entries = new Map([
      ["a", entry("a", THUMB_STALE_MS + 5000)], // stale, newer
      ["c", entry("c", THUMB_STALE_MS + 90_000)], // stale, oldest
      ["d", entry("d", 1000)], // fresh
    ]);
    // Grid order is a, b, c, d — b has no thumbnail at all.
    const got = planCaptures(live("a", "b", "c", "d"), entries, new Map(), now);
    expect(got).toEqual(["b", "c", "a"]);
  });

  it("never captures a card that isn't running", () => {
    const targets = [
      { key: "dead", live: false },
      { key: "up", live: true },
    ];
    expect(planCaptures(targets, new Map(), new Map(), now)).toEqual(["up"]);
  });

  it("excludes a card inside its failure cooldown, and lets it back after", () => {
    const failures = new Map([["a", now - 1000]]);
    expect(planCaptures(live("a"), new Map(), failures, now)).toEqual([]);
    const later = now + THUMB_FAIL_COOLDOWN_MS;
    expect(planCaptures(live("a"), new Map(), failures, later)).toEqual(["a"]);
  });

  it("a thumbnail exactly at the staleness boundary is recaptured", () => {
    const entries = new Map([["a", entry("a", THUMB_STALE_MS)]]);
    expect(planCaptures(live("a"), entries, new Map(), now)).toEqual(["a"]);
  });
});

describe("placeholderFor", () => {
  it("maps each stack family to its own glyph and tint", () => {
    expect(placeholderFor("Next.js — app", "app")).toMatchObject({
      glyph: "zap",
      tint: "var(--color-info)",
    });
    expect(placeholderFor("Vite — app", "app").glyph).toBe("zap");
    expect(placeholderFor("Express — api", "api")).toMatchObject({
      glyph: "hexagon",
      tint: "var(--color-success)",
    });
    expect(placeholderFor("Django — site", "site")).toMatchObject({
      glyph: "file-code",
      tint: "var(--color-warning)",
    });
    expect(placeholderFor("Rust — server", "server")).toMatchObject({
      glyph: "cog",
      tint: "var(--color-ink)",
    });
  });

  it("falls back to a neutral server glyph for anything unrecognized", () => {
    expect(placeholderFor("rapportd", "rapportd")).toMatchObject({
      glyph: "server",
      tint: "var(--color-ink-muted)",
    });
  });

  it("is deterministic — the same project never changes color", () => {
    expect(placeholderFor("Vite — app", "app")).toEqual(
      placeholderFor("Vite — app", "app"),
    );
  });

  it("takes the first letter that actually reads as one", () => {
    expect(placeholderFor("Vite — web", "@acme/web").initial).toBe("A");
    expect(placeholderFor("Vite — x", "3d-viewer").initial).toBe("3");
    expect(placeholderFor("Vite — x", "___").initial).toBe("?");
  });
});
