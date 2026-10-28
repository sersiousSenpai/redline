// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// Every step of the first-run tour points at a region of the workbench's
// frame (W6), and every one of those regions is a real element: the ones the
// workbench draws itself are rendered here and found by their selector; the
// ones inside the shell (the door's composer, the sidebar, the plan, the
// header's controls) are pinned to the one element that carries them. The
// app fixture's `tour` scene (scripts/app-visual-qa.mjs) walks the same
// anchors on the real App and finds each on screen.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { HOME_KEY, emptyWorkbench, type WorkbenchState } from "../workbench/model";
import { reduce } from "../workbench/reducer";
import { RightRail } from "../workbench/RightRail";
import { createWorkbenchStore } from "../workbench/store";
import { WorkbenchStage } from "../workbench/WorkbenchStage";
import { Footer } from "./Footer";
import { TOUR_ANCHORS } from "./OnboardingTour";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
const at = (anchor: string) => host.querySelectorAll(`[data-tour="${anchor}"]`);

/** Every `.ts`/`.tsx` under src that is not a test. */
function sources(dir = join(process.cwd(), "src")): { rel: string; text: string }[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    if (!/\.tsx?$/.test(name) || /\.test\.tsx?$/.test(name)) return [];
    return [{ rel: path.slice(process.cwd().length + 1), text: readFileSync(path, "utf8") }];
  });
}

describe("the tour's anchors", () => {
  it("walk the new frame, in order", () => {
    expect(TOUR_ANCHORS).toEqual(["landing", "tabs", "sessions", "agent-tab", "terminals-tab", "editor", "rail", "plan-verbs", "new-tab", "command", "settings"]);
  });

  it("the tab strip, the Agent tab and the terminals tab are drawn by the stage", async () => {
    // A session's set: its plan, its agent's tab and a wall.
    let state: WorkbenchState = reduce(emptyWorkbench(), { type: "ensureDefaults", key: HOME_KEY });
    state = reduce(state, { type: "selectSession", key: "plan:s1", defaults: { agentTerminalId: "t1" } });
    state = reduce(state, { type: "revealTerminal", ptyId: "sh1" });
    state = reduce(state, { type: "revealTerminal", ptyId: "t9", tabId: "second-wall" });
    const store = createWorkbenchStore(state, reduce);
    await act(async () => root.render(<WorkbenchStage store={store} renderPane={() => null} onNewTab={() => {}} />));
    // The strip is a lazy chunk: let it land.
    for (let i = 0; i < 20 && at("tabs").length === 0; i++) await act(async () => new Promise((r) => setTimeout(r, 10)));
    expect(at("tabs")).toHaveLength(1);
    expect(at("tabs")[0].classList.contains("rl-wb-strip")).toBe(true);
    // One of each, on the first such tab only.
    expect(at("agent-tab")).toHaveLength(1);
    expect(at("agent-tab")[0].getAttribute("role")).toBe("tab");
    expect(at("agent-tab")[0].getAttribute("title")).toBe("Agent");
    expect(at("terminals-tab")).toHaveLength(1);
    expect(at("terminals-tab")[0].getAttribute("role")).toBe("tab");
  });

  it("the rail's tabs are drawn by the rail, and the status bar marks nothing (D27)", async () => {
    await act(async () =>
      root.render(
        <>
          <RightRail tabs={["discussion", "talk", "files", "changes"]} active="discussion" onSelect={() => {}} fullscreen={false} onToggleFullscreen={() => {}} onCollapse={() => {}}>
            <div />
          </RightRail>
          <Footer />
        </>,
      ),
    );
    expect(at("rail")).toHaveLength(1);
    expect(at("rail")[0].getAttribute("role")).toBe("tablist");
    expect(host.querySelector(".rl-app-footer [data-tour]")).toBeNull();
  });

  it("each of the shell's anchors is carried by exactly the element it means", () => {
    const all = sources();
    const carriers = (anchor: string) => all.filter(({ text }) => text.includes(`data-tour="${anchor}"`) || text.includes(`"${anchor}" : undefined}`)).map(({ rel }) => rel);
    expect(carriers("landing")).toEqual(["src/components/FrontDoor.tsx"]);
    expect(readFileSync("src/components/FrontDoor.tsx", "utf8")).toContain('data-tour={welcome ? "landing" : undefined}');
    expect(carriers("sessions")).toEqual(["src/App.tsx"]);
    expect(readFileSync("src/App.tsx", "utf8")).toMatch(/<aside\s+ref=\{sidebarAsideRef\}\s+data-tour="sessions"/);
    expect(carriers("editor")).toEqual(["src/workbench/panes/plan.tsx"]);
    expect(readFileSync("src/workbench/panes/plan.tsx", "utf8")).toMatch(/<article\s+ref=\{documentRef\}\s+data-tour="editor"/);
    expect(carriers("plan-verbs")).toEqual(["src/components/plan/PlanPanelFooter.tsx"]);
    // The shortcuts step lights the top bar's ⌘K field (D26: the ⌂ it
    // pointed at left the bar; ⌘⇧0 is the palette's and the keyboard's).
    expect(carriers("command")).toEqual(["src/components/Header.tsx"]);
    expect(readFileSync("src/components/Header.tsx", "utf8")).toMatch(/className="rl-topbar-field"\s+data-tour="command"/);
    expect(carriers("settings")).toEqual(["src/components/SettingsMenu.tsx"]);
    // The door step lights the sidebar's New tab (D27: the pill it pointed
    // at left the status bar).
    expect(carriers("new-tab")).toEqual(["src/components/SessionSidebar.tsx"]);
    expect(readFileSync("src/components/SessionSidebar.tsx", "utf8")).toMatch(/-newtab" data-tour="new-tab" aria-keyshortcuts="Meta\+T"/);
    // No step points at a region nothing carries, and no region the old
    // frame had is still marked for a step that is gone.
    for (const gone of ["footer", "discussion", "terminal", "snapback", "pill"]) expect(carriers(gone), gone).toEqual([]);
  });
});
