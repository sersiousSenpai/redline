// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PulseLogo } from "./PulseLogo";

describe("PulseLogo", () => {
  it("is still at idle: the breathing `.rl-pulse` it shares a class name with skips it", () => {
    const css = readFileSync(join(process.cwd(), "src/styles.css"), "utf8");
    expect(css).not.toMatch(/\.rl-pulse\s*\{[^}]*animation/);
    expect(css).toMatch(/\.rl-pulse:not\(\[data-state\]\)\s*\{\s*animation: rl-pulse-fade/);
    expect(renderToStaticMarkup(<PulseLogo state="idle" />)).toContain('data-state="idle"');
  });

  it("draws the app icon's own blob", () => {
    // The two copies are one drawing: the icon's path, as a relative lineto
    // run (exact in hundredths, pixel-identical in headless Chrome to the
    // absolute polygon it replaced).
    const icon = readFileSync(join(process.cwd(), "public/icon.svg"), "utf8");
    const iconBlob = icon.match(/<path d="([^"]+)"/)![1];
    const mark = renderToStaticMarkup(<PulseLogo state="idle" />);
    expect(mark).toContain(`<path d="${iconBlob}" fill="#E5342B"></path>`);
    expect(iconBlob).toMatch(/^M922 512l[-\d. ]+z$/);
  });

  it("names itself, unless it sits beside a label that already does", () => {
    const named = renderToStaticMarkup(<PulseLogo state="idle" />);
    expect(named).toContain('role="img"');
    expect(named).toContain('aria-label="Conversation mode"');
    const decorative = renderToStaticMarkup(<PulseLogo state="thinking" decorative />);
    expect(decorative).toContain('aria-hidden="true"');
    expect(decorative).not.toContain("role=");
    expect(decorative).not.toContain("aria-label");
    // Still the working spin.
    expect(decorative).toContain('data-state="thinking"');
  });
});
