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
  it("a plan arrival never opens the discussion", () => {
    const arrival = app.slice(app.indexOf('const planUnlisten ='), app.indexOf('const bindFailedUnlisten ='));
    // Neither the side pane nor the plan's Conversation Dock: both stay however
    // the user left them, on the arrival itself and on its Review/Open toasts.
    // Not opened, and not force-closed either, under any helper's name.
    expect(arrival).not.toMatch(/setPaneCollapsed|revealPane|openPane|togglePane|setPanelBreaks/);
    expect(arrival).not.toMatch(/setDockOpenBy|openDock|closeDock|toggleDock/);
    // The masked-surface branch of `arrivalFocus`'s "focus": selects, never
    // yanks the surface — its Review action does that, and it is the
    // notices' one way to the plan.
    const maskedArrival = arrival.slice(arrival.indexOf('if (focus === "focus") {'), arrival.indexOf('// flash'));
    expect(maskedArrival.length).toBeGreaterThan(0);
    expect(arrival).toContain("paneMaskedRef.current");
    expect(maskedArrival).not.toContain("selectSurface");
    expect(maskedArrival).toContain('notice(arrivalMessage(title, revision), "Review")');
    const open = arrival.slice(arrival.indexOf("const openArrival = () => {"), arrival.indexOf("const notice ="));
    expect(open).toContain('selectSurfaceRef.current("document")');
    expect(open).toContain("focusIntercepted()");
    expect(arrival).toContain("action: { label, onAction: openArrival }");
    // The arrival-only opener is gone, so it cannot come back under its name.
    expect(app).not.toContain("openPanePref");
  });
  it("the rail is never masked: no surface and no plate face folds it (W4)", () => {
    // Every pane kind has rail tabs (workbench/rail.ts), so the right pane
    // stays however the user left it — the surface mask keeps only the
    // sidebar, and nothing writes the collapse on a surface's rising edge.
    expect(app).toContain('maskPanels(baseShape, { ...pMask, pane: false })');
    expect(app).not.toContain('platePaneMask(');
    expect(app).not.toContain('paneCollapseOnMask(');
    // The surface mask still defers an arriving plan to a notice.
    expect(app).toContain('paneMaskedRef.current = pMask.pane');
    expect(app).toContain('panelsMasked(pMask)');
  });
  it("voice comments expand their card without opening the pane or moving the plan", () => {
    const voice = app.slice(app.indexOf('// When a voice-authored comment'), app.indexOf('// Own-era diff'));
    expect(voice).not.toContain('setPaneCollapsed(false)');
    expect(voice).not.toContain('revealPane()');
    expect(voice).toContain('setAutoOpenCommentId(fresh.id)');
    // Focusing a comment scrolls the plan to it: a capture landing mid-
    // conversation must not move the reader (the panel's Show does, on a click).
    expect(voice).not.toMatch(/setFocusedCommentId|focusComment\(/);
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
