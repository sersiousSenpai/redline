// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PulseLogo } from "./PulseLogo";

describe("PulseLogo", () => {
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
});
