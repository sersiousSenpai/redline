import { describe, expect, it } from "vitest";
import { deriveActiveSurface, type SurfaceInputs } from "./activeSurface";

const base: SurfaceInputs = {
  browserOpen: false,
  drafterOpen: false,
  reviewOpen: false,
  serversOpen: false,
  memoryOpen: false,
  runsOpen: false,
  chatOpen: false,
  chatId: null,
  chatTitle: null,
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

  it("reports the Memory surface without an id or a project", () => {
    // Machine-scoped like Localhost: the whole lake, no session identity.
    const s = deriveActiveSurface({
      ...base,
      memoryOpen: true,
      activeId: "sess-1",
      hasTerminal: true,
    });
    expect(s).toMatchObject({
      kind: "memory",
      id: null,
      label: "Memory",
      projectPath: null,
    });
  });

  it("reports the chat room with its id and title, over a selected plan", () => {
    // A chat carries an id and a name where Localhost/Memory/Runs carry
    // neither: it is one named conversation, and the agent inside it keys on
    // that id to recognize its own room. It must also beat the plan fallback —
    // a selected session in the sidebar does not mean the user is on it.
    const s = deriveActiveSurface({
      ...base,
      chatOpen: true,
      chatId: "chat-7",
      chatTitle: "The anchoring thing",
      activeId: "sess-1",
      planTitle: "Some plan",
    });
    expect(s.kind).toBe("chat");
    expect(s.id).toBe("chat-7");
    expect(s.label).toBe("The anchoring thing");
    expect(s.projectPath).toBeNull();
  });

  it("keeps the center-pane occupants ahead of the chat room", () => {
    // Chat slots in with the others: it is a center-pane occupant, so anything
    // that already beat the plan fallback still beats it.
    for (const open of ["reviewOpen", "drafterOpen", "browserOpen"] as const) {
      const s = deriveActiveSurface({ ...base, chatOpen: true, chatId: "c1", [open]: true });
      expect(s.kind).not.toBe("chat");
    }
  });

  it("reports the Runs surface without an id or a project", () => {
    // Machine-scoped like Localhost: every orchestrated run, no session
    // identity of its own.
    const s = deriveActiveSurface({
      ...base,
      runsOpen: true,
      activeId: "sess-1",
      hasTerminal: true,
    });
    expect(s).toMatchObject({
      kind: "runs",
      id: null,
      label: "Runs",
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
