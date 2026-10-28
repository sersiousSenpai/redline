// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// The top bar is exactly the design's (D26, RLTopBar): ◧, what is open and
// where, the ⌘K field, the sessions waiting on you, ◨, the gear — six
// elements and nothing else. What it used to carry is pinned to where it
// went.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ startDragging: async () => {}, toggleMaximize: async () => {} }) }));

import { Header, type HeaderProps } from "./Header";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, host: HTMLDivElement;
beforeEach(() => { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

const noop = () => {};
function props(over: Partial<HeaderProps> = {}): HeaderProps {
  return {
    title: "Auth plan",
    project: "redline",
    sidebarOpen: true,
    onToggleSidebar: noop,
    railOpen: true,
    onToggleRail: noop,
    onOpenPalette: noop,
    needsYou: 2,
    onJumpToNeedsYou: noop,
    theme: "studio",
    onThemeChange: noop,
    font: "system" as HeaderProps["font"],
    onFontChange: noop,
    lint: "default" as HeaderProps["lint"],
    onLintChange: noop,
    mode: "active",
    onModeChange: noop,
    flashEnabled: false,
    onFlashEnabledChange: noop,
    flashColor: "#fff",
    onFlashColorChange: noop,
    flashSound: false,
    onFlashSoundChange: noop,
    flashSoundConfig: {} as HeaderProps["flashSoundConfig"],
    onFlashSoundConfigChange: noop,
    onFlashSoundPreview: noop,
    onFlashTest: noop,
    surfacesPanel: null,
    ...over,
  };
}
async function mount(over: Partial<HeaderProps> = {}) {
  await act(async () => root.render(createElement(Header, props(over))));
  return host.querySelector<HTMLElement>("header.rl-app-header.rl-topbar")!;
}

describe("the top bar (RLTopBar)", () => {
  it("is exactly six elements: ◧, the title, the ⌘K field, need you, ◨, the gear", async () => {
    const bar = await mount();
    const kids = [...bar.children] as HTMLElement[];
    expect(kids).toHaveLength(6);
    expect(kids[0].getAttribute("aria-label")).toBe("Hide sidebar");
    expect(kids[1].className).toBe("rl-topbar-title");
    expect(kids[1].textContent).toBe("Auth plan·redline");
    expect(kids[2].className).toBe("rl-topbar-centre");
    expect(kids[2].querySelector('[data-tour="command"]')?.textContent).toBe("Search or run a command…⌘K");
    expect(kids[3].className).toBe("rl-topbar-needs");
    expect(kids[3].textContent).toBe("2need you");
    expect(kids[4].getAttribute("aria-label")).toBe("Hide rail");
    expect(kids[5].getAttribute("data-tour")).toBe("settings");
    expect(kids[5].querySelector("button")?.getAttribute("aria-label")).toBe("Settings");
    // Nothing that left: the live session, Home, the ⌘K button, the Memory
    // pill, Settings ▾, Download, the version badge.
    expect(bar.textContent).not.toMatch(/Live Session|⌂|Memory|Settings|▾|Download|Options|\bv\d/);
  });

  it("sizes per the design: 38 px, the traffic lights' 84 px, 13 px text, 16 px icons, no red", () => {
    const css = readFileSync("src/styles.css", "utf8");
    const rule = css.match(/\.rl-topbar \{([^}]*)\}/)![1];
    expect(rule).toContain("height: 38px");
    expect(rule).toContain("padding: 0 10px 0 84px");
    expect(rule).toContain("font-size: 13px");
    const src = readFileSync("src/components/Header.tsx", "utf8");
    expect(src.match(/<(PanelLeft|PanelRight|Settings) size=\{16\}/g)).toHaveLength(3);
    const topbar = css.slice(css.indexOf(".rl-topbar {"), css.indexOf(".rl-topbar-needs-dot"));
    expect(topbar).not.toMatch(/danger|#d64545|--color-error/);
  });

  it("each control is the route it names", async () => {
    const calls: string[] = [];
    await mount({
      onToggleSidebar: () => calls.push("sidebar"),
      onToggleRail: () => calls.push("rail"),
      onOpenPalette: () => calls.push("palette"),
      onJumpToNeedsYou: () => calls.push("jump"),
    });
    for (const sel of ['[aria-label="Hide sidebar"]', '[data-tour="command"]', ".rl-topbar-needs", '[aria-label="Hide rail"]']) {
      await act(async () => host.querySelector<HTMLButtonElement>(sel)!.click());
    }
    expect(calls).toEqual(["sidebar", "palette", "jump", "rail"]);
  });

  it("need you pulses amber only while something waits; at zero it is quiet and goes nowhere", async () => {
    let jumps = 0;
    await mount({ needsYou: 0, onJumpToNeedsYou: () => { jumps++; } });
    const needs = () => host.querySelector<HTMLButtonElement>(".rl-topbar-needs")!;
    expect(needs().hasAttribute("data-needs")).toBe(false);
    expect(needs().querySelector(".rl-term-badge--needs")).toBeNull();
    await act(async () => needs().click());
    expect(jumps).toBe(0);
    await mount({ needsYou: 3, onJumpToNeedsYou: () => { jumps++; } });
    expect(needs().hasAttribute("data-needs")).toBe(true);
    // The one needs-you vocabulary: an amber dot whose opacity breathes.
    expect(needs().querySelector(".rl-term-badge.rl-term-badge--needs")).not.toBeNull();
    expect(needs().title).toContain("⌘⇧J");
    expect(needs().textContent).toBe("3need you");
    await mount({ needsYou: 1, onJumpToNeedsYou: () => {} });
    expect(needs().textContent).toBe("1needs you");
    await mount({ needsYou: 3, onJumpToNeedsYou: () => { jumps++; } });
    await act(async () => needs().click());
    expect(jumps).toBe(1);
  });

  it("the toggles say which way they go; Home has no project; a harness wears the project's place", async () => {
    await mount({ sidebarOpen: false, railOpen: false, title: "Home", project: null });
    expect(host.querySelector('[aria-label="Show sidebar"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="Show rail"]')).not.toBeNull();
    expect(host.querySelector(".rl-topbar-title")!.textContent).toBe("Home");
    await mount({ harnessName: "Dojo" });
    expect(host.querySelector(".rl-topbar-title")!.textContent).toBe("Auth plan·Dojo");
  });
});

describe("where the old cluster went (D26)", () => {
  const header = readFileSync("src/components/Header.tsx", "utf8");
  const app = readFileSync("src/App.tsx", "utf8");

  it("the header imports none of it", () => {
    for (const gone of ["MemoryStatusPill", "LiveSessionMenu", "DownloadMenu", "PresenceBar", "./ui/Pill", "./ui/Button"]) {
      expect(header, gone).not.toMatch(new RegExp(`from "\\./${gone.replace(/^\.\//, "").replace("/", "\\/")}"`));
    }
    expect(header).not.toContain("onSnapBack");
    expect(header).not.toContain("rl-mem-pill-slot");
    expect(readFileSync("src/styles.css", "utf8")).not.toContain("rl-mem-pill-slot");
  });

  it("App hands the header the design's routes and nothing else", () => {
    const mount = app.slice(app.indexOf("      <Header\n"), app.indexOf("      <HookConflictWarning"));
    for (const route of ["onToggleSidebar={toggleSidebar}", "onToggleRail={togglePane}", "onOpenPalette={() => setPaletteOpen(true)}", "needsYou={termNeedYou}", "onJumpToNeedsYou={jumpToNeedsYou}"]) {
      expect(mount).toContain(route);
    }
    for (const gone of ["onSnapBack", "onOpenMemory", "collabEnabled", "onInvite", "onExport", "viewedVersionNumber", "onExitHarness"]) {
      expect(mount, gone).not.toContain(`${gone}=`);
    }
    // The strip under the header went into the status bar's live menu.
    expect(app).not.toContain("<PresenceBar");
  });

  it("each departed thing still has its way in", () => {
    const commands = readFileSync("src/lib/commands.ts", "utf8");
    expect(commands).toContain('id: "home"');
    expect(app).toMatch(/goHome: \(\) => \{\n\s+tripDoor\(\);\n\s+setActiveId\(null\);/);
    expect(commands).toContain('id: "snap-back"');
    expect(commands).toContain('id: "harness-exit"');
    expect(commands).toMatch(/title: `Go to \$\{s\.label\}`/);
    const plan = readFileSync("src/components/plan/PlanPane.tsx", "utf8");
    for (const id of ['id: "md"', 'id: "docx"', 'id: "obsidian"', 'id: "share"']) expect(plan).toContain(id);
  });
});
