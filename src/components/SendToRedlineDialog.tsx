// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useState } from "react";
import { ProjectPicker, type ProjectOption } from "./ProjectPicker";

interface SendToRedlineDialogProps {
  /** The plan/reply markdown being sent — used only for the context line. */
  markdown: string;
  /** Candidate project dirs for the repo picker (reused from the drafter). */
  options: ProjectOption[];
  /** Pre-selected repo (a best-guess from the plan text, or null for Home). */
  initialProject: string | null;
  /** Confirmed — launch the plan in this repo (null = $HOME). */
  onConfirm: (project: string | null) => void;
  onCancel: () => void;
}

/** A compact "confirm the target repo" step for plans drafted by an agent
 *  elsewhere (the browser page-discussion agent). The direct "Send to Claude
 *  Code" path used to launch straight into a terminal whose cwd defaulted to
 *  $HOME — so a plan about `qwallah-crm` landed in the wrong place. This surfaces
 *  the repo choice (pre-guessed from the plan text) before spawning, with a
 *  non-blocking nudge when Home is selected. */
export function SendToRedlineDialog({
  markdown,
  options,
  initialProject,
  onConfirm,
  onCancel,
}: SendToRedlineDialogProps) {
  const [project, setProject] = useState<string | null>(initialProject);
  const context = firstHeading(markdown) ?? firstLine(markdown);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.4)" }}
      onClick={onCancel}
    >
      <div
        className="rounded-lg flex flex-col gap-3 p-5"
        style={{
          width: "min(28rem, 92vw)",
          maxHeight: "90vh",
          overflowY: "auto",
          background: "var(--color-paper)",
          border: "1px solid var(--color-rule)",
          boxShadow: "0 12px 40px rgba(0,0,0,0.3)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2">
          <span style={{ fontSize: "15px" }}>▶</span>
          <span style={{ fontSize: "14px", fontWeight: 600, color: "var(--color-ink)" }}>
            Send plan to Claude Code
          </span>
        </div>
        {context && (
          <p
            style={{
              fontSize: "12px",
              color: "var(--color-ink-muted)",
              lineHeight: 1.5,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={context}
          >
            “{context}”
          </p>
        )}

        <label style={{ fontSize: "11px", color: "var(--color-ink-muted)", fontWeight: 600 }}>
          Launch in repository
        </label>
        <ProjectPicker options={options} value={project} onChange={setProject} />

        {project === null && (
          <div
            className="rounded px-3 py-2"
            style={{
              fontSize: "11.5px",
              lineHeight: 1.45,
              border: "1px solid var(--color-warning, #b8860b)",
              background:
                "color-mix(in srgb, var(--color-warning, #b8860b) 12%, transparent)",
              color: "var(--color-ink)",
            }}
          >
            <strong>Home isn't a project repo.</strong> Claude will run in your
            home directory. Pick the repo this plan targets so it resumes in the
            right place.
          </div>
        )}

        <div className="flex items-center justify-end gap-2 mt-1">
          <button
            type="button"
            onClick={onCancel}
            className="rounded px-3 py-1.5 font-medium"
            style={{
              fontSize: "12px",
              border: "1px solid var(--color-rule)",
              background: "var(--color-bg-elevated)",
              color: "var(--color-ink)",
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onConfirm(project)}
            className="rounded px-3 py-1.5 font-medium"
            style={{
              fontSize: "12px",
              background: "var(--color-info)",
              color: "var(--color-on-accent)",
              cursor: "pointer",
            }}
          >
            Send ▶
          </button>
        </div>
      </div>
    </div>
  );
}

/** First ATX heading text, used as the context line. */
function firstHeading(md: string): string | null {
  for (const line of md.split("\n")) {
    const m = /^#{1,6}\s+(.*)$/.exec(line.trim());
    if (m) return m[1].trim();
  }
  return null;
}

/** First non-empty line, truncated — fallback when there's no heading. */
function firstLine(md: string): string | null {
  const line = md.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
  if (!line) return null;
  return line.length > 100 ? `${line.slice(0, 100)}…` : line;
}
