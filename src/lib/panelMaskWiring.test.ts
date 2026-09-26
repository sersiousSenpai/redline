// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
const app = readFileSync("src/App.tsx", "utf8");
const drafter = readFileSync("src/components/PromptDrafter.tsx", "utf8");
describe("panel mask wiring", () => {
  it.each(["revealTerm", "toggleTerm", "enterTermFullscreen"])("%s cannot break either side panel mask", name => {
    const body = app.slice(app.indexOf(`const ${name} =`)).split("}, [")[0];
    expect(body).not.toContain("setPanelBreaks");
  });
  it("a plan arrival opens the preference only when selecting the intercepted plan", () => {
    const arrival = app.slice(app.indexOf('const planUnlisten ='), app.indexOf('const bindFailedUnlisten ='));
    const focus = arrival.slice(arrival.indexOf('const focusIntercepted ='), arrival.indexOf('if (graduated &&'));
    const maskedArrival = arrival.slice(arrival.indexOf('if (paneMaskedRef.current)'), arrival.indexOf('const stealsFocus ='));
    expect(arrival).not.toContain("revealPane()");
    expect(arrival).toContain("paneMaskedRef.current");
    expect(arrival).toContain('selectSurfaceRef.current("document")');
    expect(arrival.match(/openPanePref\(\)/g)).toHaveLength(1);
    expect(focus).toContain("openPanePref()");
    expect(maskedArrival).not.toContain("openPanePref()");
    expect(maskedArrival).toContain("focusIntercepted()");
  });
  it("a plan-less plate hides the pane without deferring intercepts or showing a surface hint", () => {
    expect(app).toContain('mainSurface === "document" && plateMode !== "plan" && !conversationExpanded && !panelBreaks.pane');
    expect(app).toContain('const combinedPaneMask = pMask.pane || noPlanPane');
    expect(app).toContain('maskPanels(baseShape, { ...pMask, pane: combinedPaneMask })');
    expect(app).toContain('paneMaskedRef.current = pMask.pane');
    expect(app).toContain('panelsMasked(pMask)');
    expect(app).toContain('const previousPaneMask = useRef(false)');
    expect(app).toMatch(/if \(paneCollapseOnMask\(previousPaneMask.current, combinedPaneMask\)\) \{\s*setPaneCollapsed\(true\)/);
    const plateChange = app.slice(app.indexOf('const plateMode ='), app.indexOf('const currentDockScope ='));
    expect(plateChange).toContain('pane: false');
    expect(plateChange).toContain('[plateMode]');
  });
  it("voice comments focus their card without opening the pane", () => {
    const voice = app.slice(app.indexOf('// When a voice-authored comment'), app.indexOf('// Own-era diff'));
    expect(voice).not.toContain('openPanePref');
    expect(voice).toContain('setAutoOpenCommentId(fresh.id)');
    expect(voice).toContain('setFocusedCommentId(fresh.id)');
  });
  it("loading a draft's comments cannot open its sidecar", () => {
    const load = drafter.slice(drafter.indexOf('void invoke<DraftComment[]>("draft_comment_list"'), drafter.indexOf('// Project the comments'));
    expect(load).toContain('setComments(list)');
    expect(load).not.toContain('setSidecarOpen');
  });
  it("chat continuations use the source origin and a token before graduation", () => {
    const continuation = app.slice(app.indexOf('const runContinuation ='), app.indexOf('// Seed the Prompt Drafter'));
    expect(continuation).toContain('continuationOrigin(source.conversationKind)');
    expect(app).toContain('isGraduation(arrivingLaunch, payload)');
  });
  it("registers a launch before typing and cannot restore pending after its arrival", () => {
    const launch = app.slice(app.indexOf('const launchPlan ='), app.indexOf('// "Run" on a Localhost'));
    expect(launch.indexOf('launchedPlansRef.current.set(launchId, pending)')).toBeLessThan(launch.indexOf('await deliverToTerminal'));
    expect(launch).toContain('if (launchedPlansRef.current.has(launchId)) setPendingLaunch(pending)');
  });
});
