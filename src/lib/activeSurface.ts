// Memory-by-session (spine): derive "where is the user" from App state, for
// mirroring into the backend ActiveSurface cell (`surface_set_active`). The
// backend cell feeds the Companion's per-turn grounding, `resolve_parent` when
// a new interaction thread is created, and `GET /v1/surface/active`.
//
// Pure so the precedence is unit-testable: the secondary panes are mutually
// exclusive occupants of the center pane, so review > drafter > browser >
// servers wins over the plan/terminal fallbacks.

export interface SurfaceInfo {
  kind:
    | "plan"
    | "drafter"
    | "browser"
    | "review"
    | "servers"
    | "memory"
    | "runs"
    | "terminal"
    | "welcome";
  id: string | null;
  label: string | null;
  detail: string | null;
  projectPath: string | null;
  updatedAt: number;
}

export interface SurfaceInputs {
  browserOpen: boolean;
  drafterOpen: boolean;
  reviewOpen: boolean;
  serversOpen: boolean;
  memoryOpen: boolean;
  runsOpen: boolean;
  /** The active plan review session, when one is selected. */
  activeId: string | null;
  planTitle: string | null;
  planProject: string | null;
  /** The browser pane's active tab, when the browser is open. */
  activeTab: { url: string; title: string; browseId: string } | null;
  reviewId: string | null;
  reviewRepo: string | null;
  drafterDraftId: string | null;
  drafterProject: string | null;
  /** The file open in the folder-explorer viewer (terminal-ish context). */
  activeFile: string | null;
  /** Whether any dock terminal exists (the welcome/terminal fallback split). */
  hasTerminal: boolean;
}

export function deriveActiveSurface(s: SurfaceInputs): SurfaceInfo {
  const base = { updatedAt: 0 };
  if (s.reviewOpen) {
    return {
      ...base,
      kind: "review",
      id: s.reviewId,
      label: s.reviewRepo,
      detail: null,
      projectPath: s.reviewRepo,
    };
  }
  if (s.drafterOpen) {
    return {
      ...base,
      kind: "drafter",
      id: s.drafterDraftId,
      label: null,
      detail: null,
      projectPath: s.drafterProject,
    };
  }
  if (s.browserOpen) {
    return {
      ...base,
      kind: "browser",
      id: s.activeTab?.browseId ?? null,
      label: s.activeTab?.title ?? null,
      detail: s.activeTab?.url ?? null,
      projectPath: null,
    };
  }
  if (s.serversOpen) {
    // The Localhost grid is machine-scoped, not project-scoped — there is no id
    // and no project path to report, which is exactly what it means for the
    // Companion to say "they're looking at what's running."
    return {
      ...base,
      kind: "servers",
      id: null,
      label: "Localhost",
      detail: null,
      projectPath: null,
    };
  }
  if (s.memoryOpen) {
    // The Memory surface spans the whole lake — machine-scoped like Localhost;
    // the Companion just needs to know "they're looking at their own memory."
    return {
      ...base,
      kind: "memory",
      id: null,
      label: "Memory",
      detail: null,
      projectPath: null,
    };
  }
  if (s.runsOpen) {
    // The Orchestration Monitor spans every orchestrated run — machine-scoped
    // like Localhost and Memory.
    return {
      ...base,
      kind: "runs",
      id: null,
      label: "Runs",
      detail: null,
      projectPath: null,
    };
  }
  if (s.activeId) {
    return {
      ...base,
      kind: "plan",
      id: s.activeId,
      label: s.planTitle,
      detail: s.activeFile,
      projectPath: s.planProject,
    };
  }
  if (s.hasTerminal || s.activeFile) {
    return {
      ...base,
      kind: "terminal",
      id: null,
      label: null,
      detail: s.activeFile,
      projectPath: null,
    };
  }
  return {
    ...base,
    kind: "welcome",
    id: null,
    label: null,
    detail: null,
    projectPath: null,
  };
}
