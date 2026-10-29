// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CompactComposer } from "./CompactComposer";

// D27: the chat pane's and the Agent pane's composer is the compact composer
// the footer pill's card drew — one box, one chip shape — centred under the
// transcript and pinned to the pane's bottom; the pill and its card are gone.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");
const css = read("src/components/CompactComposer.css");
const rule = (selector: string) => {
  const at = css.indexOf(`${selector} {`);
  return at < 0 ? "" : css.slice(at, css.indexOf("}", at));
};

const look = read("src/components/ComposerLook.css");
const lookRule = (selector: string) => {
  const at = look.indexOf(`${selector} {`);
  return at < 0 ? "" : look.slice(at, look.indexOf("}", at));
};
const DOOR_OR_CHAT = ":is(.rl-monochat, .rl-compact-dock)";

describe("the compact composer", () => {
  it("is a place and a measure, not a second box: the FrontDoor in it draws the card", async () => {
    await act(async () => root.render(<CompactComposer><textarea aria-label="Message Redline" /></CompactComposer>));
    const dock = host.querySelector(".rl-compact-dock")!;
    expect(dock.getAttribute("data-pose")).toBe("full");
    const measure = dock.querySelector(".rl-compact-measure")!;
    expect(measure.className).toBe("rl-compact-measure");
    expect(measure.hasAttribute("data-compact-composer")).toBe(true);
    expect(dock.querySelector(".rl-glass")).toBeNull();
    expect(measure.querySelector("textarea")).not.toBeNull();
    await act(async () => root.render(<CompactComposer pose="compact"><textarea /></CompactComposer>));
    expect(host.querySelector(".rl-compact-dock")!.getAttribute("data-pose")).toBe("compact");
  });

  it("keeps D27's place: centred at min(720px, 100% - 64px), pinned to the pane's bottom", () => {
    expect(rule(".rl-compact-measure")).toContain("width: min(720px, calc(100% - 64px));");
    expect(rule(".rl-compact-measure")).toContain("margin: 0 auto;");
    expect(rule(".rl-compact-dock")).toContain("flex: none;");
    // Host geometry only: no card chrome of its own.
    const declarations = css.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(declarations).not.toMatch(/border-radius|--color-glass|\.rl-composer-chip|\.rl-fd-go|\.rl-fd-tool/);
  });
});

describe("one look for every composer", () => {
  it("the chat's composer and the Home door's share the composer's styles: card, field, chips, + and mic, send", () => {
    // One sheet, carried by the component both hosts render.
    expect(read("src/components/FrontDoor.tsx")).toContain('import "./ComposerLook.css";');
    expect(read("src/components/agent/SessionComposer.tsx")).toContain('import "../ComposerLook.css";');
    const card = lookRule(`${DOOR_OR_CHAT} .rl-floating-composer.rl-frontdoor .rl-fd-island,\n.rl-convo-composer.rl-glass.rl-compact-composer`);
    expect(card).toContain("border-radius: 24px;");
    expect(card).toContain("padding: 18px var(--fd-island-pad-x, 20px) 12px;");
    expect(card).toContain("background: var(--color-glass-3);");
    for (const selector of [".rl-floating-composer.rl-frontdoor .rl-fd-input", ".rl-fd-tools", ".rl-fd-tool", ".rl-composer-chip:not(:hover, [aria-expanded=true])", ".rl-composer-accessories"]) {
      expect(look, selector).toContain(`${DOOR_OR_CHAT} ${selector}`);
    }
    expect(look).toMatch(/:is\(\.rl-monochat, \.rl-compact-dock\) \.rl-fd-go,\s*\.rl-compact-composer \.rl-send \{ width: 34px; height: 34px; border-radius: 50%; \}/);
    // The door keeps no copy of its own look, and the Agent pane none of a
    // second one: a second look would drift.
    const island = read("src/components/MonochatIsland.css").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(island).not.toMatch(/\.rl-monochat [^{]*\.rl-fd-island \{[^}]*border-radius|\.rl-monochat \.rl-fd-go|\.rl-monochat \.rl-fd-tool \{|\.rl-monochat \.rl-composer-chip/);
    expect(read("src/components/agent/conversation.css")).not.toContain(".rl-convo-composer.rl-glass.rl-compact-composer {");
  });

  it("gives Stop the quiet ink, never a red, and uses Redline tokens only", () => {
    expect(look).toMatch(/:is\(\.rl-monochat, \.rl-compact-dock\) \.rl-fd-go\[data-state="stop"\],\s*\.rl-compact-composer \.rl-send\[data-send="stop"\] \{[^}]*background: var\(--color-fill-3\);[^}]*color: var\(--color-ink\);/);
    for (const sheet of [look, css]) {
      const declarations = sheet.replace(/\/\*[\s\S]*?\*\//g, "").replace(/#000 \d+(px)?|#000 0 0/g, "");
      expect(declarations).not.toMatch(/--color-(danger|error)|mode-danger|#[a-f0-9]{3,6}\b|\bred\b|rgb\(/i);
    }
  });
});

describe("notices ride above the card", () => {
  it("the strip is joined above the card: its width, 24 px top corners, tucked under the card's", () => {
    const strip = lookRule(".rl-composer-notices");
    expect(strip).toContain("border-radius: 24px 24px 0 0;");
    expect(strip).toContain("margin-bottom: -24px;");
    expect(strip).toContain("padding-bottom: 24px;");
    expect(strip).toContain("background: var(--color-mode-redline-bg);");
    // Masked to the two corners the card's rounding leaves open: no tint
    // through the glass.
    expect(strip).toMatch(/mask:[^;]*radial-gradient\(circle at 100% 100%, transparent 23\.5px, #000 24px\) bottom left/);
    expect(look).toContain(".rl-composer-notices + .rl-fd-island { z-index: 1; }");
  });

  it("FrontDoor puts a chat's notices before the card, never inside it, and lazily", () => {
    const door = read("src/components/FrontDoor.tsx");
    const notices = door.indexOf("<ComposerNotices");
    const card = door.indexOf("<div ref={islandRef}");
    expect(notices).toBeGreaterThan(0);
    expect(notices).toBeLessThan(card);
    expect(door).toContain('lazy(() => import("./plan/ComposerNotices")');
    expect(door).not.toMatch(/^import [^;]*"\.\/plan\/ComposerNotices"/m);
    // In a chat the old paragraph strip and the in-card refusal are gone.
    expect(door).toContain("{!workbench && <ReadinessStrip");
    expect(door).toContain("{refusedWhy && !blocked && !offer && !workbench && (");
  });
});

describe("the composer's menus", () => {
  it("open through the shared popover with the page's picture first over a browser pane, as the plan's ⋯", () => {
    expect(read("src/components/ComposerMenu.tsx")).toContain('useClickPopover(trigger, "left", "above", 304);');
    expect(read("src/components/FrontDoor.tsx")).toContain('useClickPopover(btnRef, "left", "above", 328);');
    const picker = read("src/components/ChatModePicker.tsx");
    expect(picker).toContain("<ComposerMenu");
    expect(picker).not.toMatch(/Done|rl-chat-mode-menu|role="dialog"/);
  });
});

describe("its two hosts", () => {
  it("the chat room wraps its FrontDoor composer in it, centred under the thread", () => {
    const room = read("src/components/ChatRoom.tsx");
    expect(room).toContain('<CompactComposer pose={compact ? "compact" : "full"}>{composer.render(');
    // The thread's text column is the composer's measure plus its padding.
    expect(room).toContain("const columnWidth = roomy ? 768 : 760;");
  });

  it("the session composer wears it on the stage (the Agent pane)", () => {
    const composer = read("src/components/agent/SessionComposer.tsx");
    expect(composer).toContain('import "../CompactComposer.css";');
    expect(composer).toContain('${stage ? " rl-compact-composer" : ""}');
    // The transcript, the drawer and the composer share the measure.
    const convo = read("src/components/agent/conversation.css");
    expect(convo.match(/min\(720px, calc\(100% - 64px\)\)/g)?.length).toBeGreaterThanOrEqual(3);
    expect(convo).not.toContain("calc(100% - 32px)");
  });

  it("and there is no pill's card to be the compact composer any more", () => {
    const app = read("src/App.tsx");
    expect(app).not.toMatch(/doorCompact|renderMonochatComposer\("card"\)|onPillClick/);
    expect(app).toMatch(/const renderMonochatComposer = \(where: "door" \| "chat"/);
  });
});
