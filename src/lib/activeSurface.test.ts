import { describe, expect, it } from "vitest";
import { deriveActiveSurface, type SurfaceInputs } from "./activeSurface";

const base: SurfaceInputs = {
  browserOpen: false,
  drafterOpen: false,
  reviewOpen: false,
  serversOpen: false,
  activeId: null,
  planTitle: null,
  planProject: null,
  activeTab: null,
  reviewId: null,
  reviewRepo: null,
  drafterDraftId: null,
  drafterProject: null,
  activeFile: null,
  hasTerminal: false,
};

describe("deriveActiveSurface", () => {
  it("falls back to welcome when nothing is open", () => {
    expect(deriveActiveSurface(base).kind).toBe("welcome");
  });

  it("reports the Localhost grid without an id or a project", () => {
    // Machine-scoped, not project-scoped: it outranks the plan/terminal
    // fallbacks (it OCCUPIES the center pane) but carries no session identity.
    const s = deriveActiveSurface({
      ...base,
      serversOpen: true,
      activeId: "sess-1",
      planProject: "/repo",
      hasTerminal: true,
    });
    expect(s).toMatchObject({
      kind: "servers",
      id: null,
      label: "Localhost",
      projectPath: null,
    });
  });

  it("reports terminal when a dock terminal exists but no plan is selected", () => {
    expect(deriveActiveSurface({ ...base, hasTerminal: true }).kind).toBe(
      "terminal",
    );
  });

  it("reports the focused plan session with its title and project", () => {
    const s = deriveActiveSurface({
      ...base,
      activeId: "sess-1",
      planTitle: "My plan",
      planProject: "/repo",
      hasTerminal: true,
    });
    expect(s).toMatchObject({
      kind: "plan",
      id: "sess-1",
      label: "My plan",
      projectPath: "/repo",
    });
  });

  it("browser beats a selected plan (it occupies the center pane)", () => {
    const s = deriveActiveSurface({
      ...base,
      activeId: "sess-1",
      browserOpen: true,
      activeTab: { url: "https://x", title: "X", browseId: "tab-1" },
    });
    expect(s).toMatchObject({
      kind: "browser",
      id: "tab-1",
      label: "X",
      detail: "https://x",
    });
  });

  it("drafter beats the browser", () => {
    const s = deriveActiveSurface({
      ...base,
      browserOpen: true,
      drafterOpen: true,
      drafterDraftId: "draft-1",
      drafterProject: "/repo",
    });
    expect(s).toMatchObject({
      kind: "drafter",
      id: "draft-1",
      projectPath: "/repo",
    });
  });

  it("review beats everything (the panes are mutually exclusive; review wins)", () => {
    const s = deriveActiveSurface({
      ...base,
      browserOpen: true,
      drafterOpen: true,
      reviewOpen: true,
      reviewId: "rev-1",
      reviewRepo: "/repo",
      activeId: "sess-1",
    });
    expect(s).toMatchObject({ kind: "review", id: "rev-1", label: "/repo" });
  });

  it("carries the active file as plan detail", () => {
    const s = deriveActiveSurface({
      ...base,
      activeId: "sess-1",
      activeFile: "/repo/src/main.rs",
    });
    expect(s.detail).toBe("/repo/src/main.rs");
  });
});
