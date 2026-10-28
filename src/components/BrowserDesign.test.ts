// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// The browser pane's sizes, pinned at the source to the design
// (workbench-design/RLPaneBrowser.dc.html) and the plan's Aesthetics: a
// 40 px icon strip of 28 px page buttons, a 40 px address bar of 26 px
// controls around a 28 px field, 28 px Page chat, a 26 px agent row, 28 px
// tile headers; on the new tab an 820 px column, a 40 px serif title, an
// 18 px-radius omnibox with 30 px verbs, 30 px live chips and 36 px rows.
// Redline tokens only, and nothing red.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (file: string) => readFileSync(join(process.cwd(), "src/components", file), "utf8");
const workspaceCss = read("BrowserWorkspace.css");
const homeCss = read("BrowserHomePage.css");

/** The declarations of the first rule whose selector list is exactly `selector`. */
function rule(css: string, selector: string): string {
  const at = css.split("\n").find((line) => line.trimStart().startsWith(`${selector} {`));
  if (!at) throw new Error(`no rule for ${selector}`);
  return at.slice(at.indexOf("{") + 1, at.lastIndexOf("}"));
}
const has = (css: string, selector: string, ...declarations: string[]) => {
  const body = rule(css, selector);
  for (const d of declarations) expect(body, `${selector} { ${d} }`).toContain(d);
};

describe("the browser pane's chrome", () => {
  it("is a 40 px icon strip of 28 px page buttons", () => {
    has(workspaceCss, ".rb-tab-rail", "width:var(--browser-rail-width,40px)", "background:var(--color-canvas");
    has(workspaceCss, ".rb-tab-rail .rb-icon-button", "width:28px", "height:28px");
    has(workspaceCss, ".rb-tab-rail[data-collapsed] .rb-tab", "width:28px", "height:28px");
    has(workspaceCss, ".rb-rail-rule", "width:20px", "height:1px");
    expect(read("BrowserTabRail.tsx")).toContain("export const RAIL_ICON_WIDTH = 40;");
  });
  it("is a 40 px address bar of 26 px controls around a 28 px field, with a 28 px Page chat", () => {
    has(workspaceCss, ".rb-navigation-row", "height:40px", "padding:0 8px 0 6px", "gap:6px");
    has(workspaceCss, ".rb-icon-button", "width:26px", "height:26px");
    has(workspaceCss, ".rb-address", "height:28px", "border-radius:8px", "border:1px solid var(--color-rule-strong)");
    has(workspaceCss, ".rb-address input", "font-size:12.5px");
    has(workspaceCss, ".rb-chat-toggle", "height:28px", "border-radius:7px", "font-size:12.5px");
    has(workspaceCss, ".rb-chat-toggle[aria-pressed=\"true\"]", "color:var(--color-info-text)", "border-color:var(--color-info)");
  });
  it("says the agent is acting in a 26 px row under the page, and tiles carry 28 px headers", () => {
    has(workspaceCss, ".rb-agent-status", "height:26px");
    has(workspaceCss, ".rb-pane-alert", "min-height:26px");
    expect(read("BrowserTileStage.tsx")).toContain("style={{ height: 28, cursor: \"grab\"");
  });
  it("draws status in the one vocabulary: the shared Spinner, an amber opacity pulse, nothing red", () => {
    const rail = read("BrowserTabRail.tsx");
    expect(rail).toContain('<Spinner size={10} className="rb-tab-status"/>');
    expect(rail).toContain('className="rb-needs-dot rb-tab-status"');
    has(workspaceCss, ".rb-needs-dot", "background:var(--color-warning)", "animation:rb-needs 2s ease-in-out infinite");
    expect(workspaceCss).toContain("@keyframes rb-needs { 0%,100% { opacity:1; } 50% { opacity:.35; } }");
    // The pane's own spinning ring went for the shared Spinner.
    expect(workspaceCss).not.toContain("rb-wake");
    for (const file of ["BrowserPane.tsx", "BrowserChrome.tsx", "BrowserTabRail.tsx", "BrowserTileStage.tsx", "BrowserHomePage.tsx", "BrowserWorkspace.css", "BrowserHomePage.css"])
      expect(read(file), file).not.toMatch(/--color-danger|--color-mode-danger/);
  });
});

describe("the new-tab page", () => {
  it("is an 820 px column under a 40 px serif title", () => {
    has(homeCss, ".rb-nt-column", "width:min(820px,100%)", "gap:28px", "padding-top:72px");
    has(homeCss, ".rb-nt-head h1", "font:500 40px/1.1 var(--font-serif");
    has(homeCss, ".rb-nt-kicker", "font-size:11px", "text-transform:uppercase");
  });
  it("has an 18 px-radius omnibox with a 17 px field and 30 px verbs", () => {
    has(homeCss, ".rb-nt-omnibox", "border-radius:18px", "padding:16px 18px 12px");
    has(homeCss, ".rb-nt-field input", "font-size:17px");
    has(homeCss, ".rb-nt-verb", "height:30px", "border-radius:15px");
    has(homeCss, ".rb-nt-go", "width:30px", "height:30px", "border-radius:50%");
  });
  it("has 30 px live chips, 36 px rows and two columns", () => {
    has(homeCss, ".rb-nt-chip", "height:30px", "border-radius:15px");
    has(homeCss, ".rb-nt-row", "height:36px", "border-bottom:1px solid var(--color-rule)");
    has(homeCss, ".rb-nt-subject-head", "height:30px");
    has(homeCss, ".rb-nt-columns", "grid-template-columns:repeat(auto-fit,minmax(260px,1fr))", "gap:28px 40px");
  });
  it("draws no thumbnail grid", () => {
    expect(homeCss).not.toMatch(/rb-home-grid|rb-home-shot|rb-home-tile/);
    expect(read("BrowserHomePage.tsx")).not.toMatch(/read_file_base64|shots_list/);
  });
});
