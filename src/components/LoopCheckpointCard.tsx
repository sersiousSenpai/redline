// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useState } from "react";
import type { LoopCheckpoint, LoopSubtask } from "../types";

interface LoopCheckpointCardProps {
  checkpoint: LoopCheckpoint;
  /** The subtask this gate concerns, if any — supplies title + touched paths. */
  subtask?: LoopSubtask | null;
  /** `loop_checkpoint_decide` bridge. `note` becomes feedback on deny;
   *  `editedInstructions` rides an `edit_retry` for a stuck subtask. */
  onDecide: (
    checkpointId: string,
    action: string,
    note?: string | null,
    editedInstructions?: string | null,
  ) => void;
}

/** A pending decision gate, cloned from the ApproveToast surface. Merge/land
 *  gates get Approve/Deny + a note (feedback on deny); a stuck subtask gets
 *  Edit & Retry / Skip / Abandon. Renders the summary + any diff stat pulled
 *  from the checkpoint's opaque `decisionJson`. */
export function LoopCheckpointCard({
  checkpoint,
  subtask,
  onDecide,
}: LoopCheckpointCardProps) {
  const [note, setNote] = useState("");
  const [editing, setEditing] = useState(false);
  const [instructions, setInstructions] = useState(
    subtask?.instructions ?? "",
  );

  const decided = checkpoint.status !== "pending";
  const diffStat = extractDiffStat(checkpoint.decisionJson);
  const isStuck = checkpoint.kind === "subtask_stuck";
  const kindLabel = KIND_LABELS[checkpoint.kind] ?? checkpoint.kind;

  return (
    <div
      className="rounded-md flex flex-col gap-2 px-3 py-2.5"
      style={{
        border: "1px solid var(--color-warning)",
        background: "var(--color-bg-elevated)",
        boxShadow: "0 2px 10px rgba(0,0,0,0.14)",
        opacity: decided ? 0.6 : 1,
      }}
      role="alert"
    >
      <div className="flex items-center gap-1.5">
        <span style={{ fontSize: "13px" }}>{isStuck ? "⚠️" : "⏸"}</span>
        <span
          style={{
            fontSize: "9px",
            fontWeight: 700,
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            color: "var(--color-warning)",
          }}
        >
          {kindLabel}
        </span>
        {subtask && (
          <span
            className="truncate"
            style={{ fontSize: "11px", color: "var(--color-ink-muted)" }}
            title={subtask.title}
          >
            · {subtask.title}
          </span>
        )}
      </div>

      <div
        style={{
          fontSize: "12px",
          lineHeight: 1.45,
          color: "var(--color-ink)",
          whiteSpace: "pre-wrap",
        }}
      >
        {checkpoint.summary}
      </div>

      {diffStat && (
        <div
          className="font-mono rounded px-2 py-1"
          style={{
            fontSize: "10.5px",
            color: "var(--color-ink-muted)",
            background: "var(--color-paper)",
            border: "1px solid var(--color-rule)",
            whiteSpace: "pre-wrap",
          }}
        >
          {diffStat}
        </div>
      )}

      {decided ? (
        <div
          style={{
            fontSize: "11px",
            fontWeight: 600,
            color:
              checkpoint.status === "denied"
                ? "var(--color-warning)"
                : "var(--color-success)",
          }}
        >
          {checkpoint.status === "denied"
            ? "Denied"
            : checkpoint.status === "expired"
              ? "Expired"
              : "Approved"}
        </div>
      ) : isStuck ? (
        <>
          {editing && (
            <textarea
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              autoFocus
              rows={4}
              placeholder="Revised instructions for the retry…"
              className="rounded px-2 py-1.5"
              style={{
                fontSize: "12px",
                border: "1px solid var(--color-rule)",
                background: "var(--color-paper)",
                color: "var(--color-ink)",
                resize: "vertical",
                fontFamily: "inherit",
                lineHeight: 1.45,
              }}
            />
          )}
          <div className="flex items-center gap-1.5 flex-wrap">
            {editing ? (
              <>
                <GateButton
                  primary
                  label="Retry with edits"
                  disabled={!instructions.trim()}
                  onClick={() =>
                    onDecide(
                      checkpoint.checkpointId,
                      "edit_retry",
                      null,
                      instructions,
                    )
                  }
                />
                <GateButton label="Cancel" onClick={() => setEditing(false)} />
              </>
            ) : (
              <>
                <GateButton
                  primary
                  label="Edit & Retry"
                  onClick={() => setEditing(true)}
                />
                <GateButton
                  label="Skip"
                  onClick={() =>
                    onDecide(checkpoint.checkpointId, "skip", note || null)
                  }
                />
                <GateButton
                  danger
                  label="Abandon"
                  onClick={() =>
                    onDecide(checkpoint.checkpointId, "abandon", note || null)
                  }
                />
              </>
            )}
          </div>
        </>
      ) : (
        <>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            placeholder="Optional note — becomes feedback if you deny…"
            className="rounded px-2 py-1.5"
            style={{
              fontSize: "12px",
              border: "1px solid var(--color-rule)",
              background: "var(--color-paper)",
              color: "var(--color-ink)",
              resize: "vertical",
              fontFamily: "inherit",
              lineHeight: 1.4,
            }}
          />
          <div className="flex items-center gap-1.5">
            <GateButton
              primary
              label={checkpoint.kind === "land" ? "Approve · Land" : "Approve"}
              onClick={() =>
                onDecide(checkpoint.checkpointId, "approve", note || null)
              }
            />
            <GateButton
              danger
              label="Deny"
              onClick={() =>
                onDecide(checkpoint.checkpointId, "deny", note || null)
              }
            />
          </div>
        </>
      )}
    </div>
  );
}

const KIND_LABELS: Record<LoopCheckpoint["kind"], string> = {
  merge: "Merge gate",
  land: "Land gate",
  subtask_stuck: "Subtask stuck",
  destructive: "Destructive op",
  plan_approval: "Plan approval",
};

/** The gate detail is an opaque JSON blob; pull a `diffStat`/`diff_stat` string
 *  out of it if one is there, otherwise show nothing. */
function extractDiffStat(decisionJson?: string | null): string | null {
  if (!decisionJson) return null;
  try {
    const obj = JSON.parse(decisionJson) as Record<string, unknown>;
    const v = obj.diffStat ?? obj.diff_stat ?? obj.diff;
    return typeof v === "string" && v.trim() ? v : null;
  } catch {
    return null;
  }
}

function GateButton({
  label,
  onClick,
  primary,
  danger,
  disabled,
}: {
  label: string;
  onClick: () => void;
  primary?: boolean;
  danger?: boolean;
  disabled?: boolean;
}) {
  const bg = primary
    ? "var(--color-success)"
    : danger
      ? "var(--color-warning)"
      : "var(--color-bg-elevated)";
  const color =
    primary || danger ? "var(--color-on-accent)" : "var(--color-ink)";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="rounded px-2.5 py-1 font-medium"
      style={{
        fontSize: "11px",
        background: bg,
        color,
        border: primary || danger ? "none" : "1px solid var(--color-rule)",
        opacity: disabled ? 0.5 : 1,
        cursor: disabled ? "default" : "pointer",
      }}
    >
      {label}
    </button>
  );
}
