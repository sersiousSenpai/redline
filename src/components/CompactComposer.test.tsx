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

describe("the compact composer", () => {
  it("is one glass box in a dock, marked for the arrival rule and the probes", async () => {
    await act(async () => root.render(<CompactComposer><textarea aria-label="Message Redline" /></CompactComposer>));
    const dock = host.querySelector(".rl-compact-dock")!;
    expect(dock.getAttribute("data-pose")).toBe("full");
    const box = dock.querySelector(".rl-compact-composer")!;
    expect(box.className).toBe("rl-compact-composer rl-glass rl-glass-sheet");
    expect(box.hasAttribute("data-compact-composer")).toBe(true);
    expect(box.querySelector("textarea")).not.toBeNull();
    await act(async () => root.render(<CompactComposer pose="compact"><textarea /></CompactComposer>));
    expect(host.querySelector(".rl-compact-dock")!.getAttribute("data-pose")).toBe("compact");
  });

  it("keeps the card's chrome at the design's measure: 14 px in, 14 px corners, min(720px, 100% - 64px)", () => {
    const box = rule(".rl-compact-composer");
    expect(box).toContain("width: min(720px, calc(100% - 64px));");
    expect(box).toContain("padding: 14px;");
    expect(box).toContain("border-radius: 14px;");
    expect(box).toContain("background: var(--color-glass-3);");
    // Pinned to the pane's bottom: the dock never grows, the thread does.
    expect(rule(".rl-compact-dock")).toContain("flex: none;");
  });

  it("gives every chip one pill and Stop the quiet ink, never a red", () => {
    expect(css).toMatch(/\.rl-compact-composer \.rl-chat-mode-picker > button,\s*\.rl-compact-composer \.rl-convo-chip \{[^}]*height: 32px;[^}]*border-radius: 18px;/);
    expect(css).toMatch(/\.rl-compact-composer \.rl-fd-go\[data-state="stop"\],\s*\.rl-compact-composer \.rl-send\[data-send="stop"\] \{[^}]*background: var\(--color-fill-3\);[^}]*color: var\(--color-ink\);/);
    // Redline tokens only, and none of them an alarm.
    const declarations = css.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(declarations).not.toMatch(/--color-(danger|error)|mode-danger|#[a-f0-9]{3,6}\b|\bred\b|rgb\(/i);
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
