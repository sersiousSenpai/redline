// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useMenuOverlay } from "./menuOverlay";

// Agent Seats — per-seat model/effort configuration for every headless agent
// Redline spawns (see src-tauri/src/seat.rs). Each seat row offers a model
// (Default = inherit the CLI's global default, or an explicit tier / custom
// id) and an effort sub-choice; fork-thread categories default to "Inherit"
// so a thread runs exactly like its parent surface. The panel also exposes
// the global `claude` binary override. Self-contained: loads on open, saves
// per change — no App state involved.

interface SeatConfig {
  backend?: string;
  model?: string;
  effort?: string;
  fallback?: string;
  binaryPath?: string;
  extraFlags?: string[];
}

interface AgentSeatsView {
  seats: Record<string, SeatConfig>;
  knownSeats: string[];
  claudeBin: string | null;
}

interface SeatRow {
  name: string;
  label: string;
  /** Fork categories inherit their parent surface when unset. */
  inherit?: boolean;
}

const SEAT_GROUPS: { label: string; seats: SeatRow[] }[] = [
  {
    label: "Agents",
    seats: [
      { name: "companion", label: "Companion" },
      { name: "voice", label: "Voice agent" },
      { name: "drafter", label: "Drafter discussion" },
      { name: "browse", label: "Browser page discussions" },
      { name: "linked", label: "Linked discussion" },
      { name: "mission", label: "Missions" },
      { name: "ai_review", label: "AI code review" },
    ],
  },
  {
    label: "Library agents",
    seats: [
      { name: "keeper", label: "Keeper" },
      { name: "classifier", label: "ClassMemory classifier" },
      { name: "librarian", label: "Librarian" },
    ],
  },
  {
    label: "Discussion threads",
    seats: [
      { name: "fork_plan", label: "Plan sidecar threads", inherit: true },
      { name: "fork_review", label: "Code-review threads", inherit: true },
      { name: "fork_drafter", label: "Drafter comment threads", inherit: true },
    ],
  },
];

const MODEL_OPTIONS = ["opus", "sonnet", "haiku"];
const EFFORT_OPTIONS = ["low", "medium", "high", "max"];

const selectStyle: React.CSSProperties = {
  fontSize: "11px",
  border: "1px solid var(--color-rule)",
  background: "var(--color-paper)",
  color: "var(--color-ink)",
  borderRadius: "3px",
  padding: "2px 4px",
};

export function AgentSeats() {
  const [open, setOpen] = useState(false);
  const [seats, setSeats] = useState<Record<string, SeatConfig>>({});
  const [claudeBin, setClaudeBin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useMenuOverlay(open);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void invoke<AgentSeatsView>("get_agent_seats")
      .then((view) => {
        if (cancelled) return;
        setSeats(view.seats);
        setClaudeBin(view.claudeBin ?? "");
      })
      .catch((e) => setError(String(e)));
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      cancelled = true;
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const save = (name: string, config: SeatConfig) => {
    setSeats((prev) => ({ ...prev, [name]: config }));
    setError(null);
    void invoke("set_agent_seat", { seatName: name, config }).catch((e) =>
      setError(String(e)),
    );
  };

  const update = (name: string, patch: Partial<SeatConfig>) => {
    const next = { ...(seats[name] ?? {}), ...patch };
    // An effort without a model is meaningful (effort on the default model),
    // but clearing the model back to Default also clears a stale custom value.
    save(name, next);
  };

  const saveClaudeBin = (path: string) => {
    setClaudeBin(path);
    setError(null);
    void invoke("set_claude_bin_override", { path }).catch((e) =>
      setError(String(e)),
    );
  };

  const renderSeat = (row: SeatRow) => {
    const cfg = seats[row.name] ?? {};
    const model = cfg.model ?? "";
    const isCustomModel = model !== "" && !MODEL_OPTIONS.includes(model);
    const defaultLabel = row.inherit ? "Inherit" : "Default";
    return (
      <div
        key={row.name}
        className="flex items-center gap-2 px-3 py-1.5"
        style={{ borderBottom: "1px solid var(--color-rule)" }}
      >
        <span
          className="font-sans flex-1 min-w-0"
          style={{ fontSize: "11px", color: "var(--color-ink)" }}
        >
          {row.label}
        </span>
        <select
          aria-label={`${row.label} model`}
          value={isCustomModel ? "__custom" : model}
          onChange={(e) => {
            const v = e.target.value;
            if (v === "__custom") {
              // Seed the free-text state; saved on blur/Enter below.
              update(row.name, { model: model || "claude-" });
            } else {
              update(row.name, { model: v || undefined });
            }
          }}
          style={selectStyle}
        >
          <option value="">{defaultLabel}</option>
          {MODEL_OPTIONS.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
          <option value="__custom">custom…</option>
        </select>
        {isCustomModel && (
          <input
            type="text"
            aria-label={`${row.label} custom model id`}
            defaultValue={model}
            onBlur={(e) => update(row.name, { model: e.target.value.trim() || undefined })}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                update(row.name, {
                  model: (e.target as HTMLInputElement).value.trim() || undefined,
                });
              }
              if (e.key !== "Escape") e.stopPropagation();
            }}
            className="font-sans"
            style={{ ...selectStyle, width: "110px" }}
          />
        )}
        <select
          aria-label={`${row.label} effort`}
          value={cfg.effort ?? ""}
          onChange={(e) =>
            update(row.name, { effort: e.target.value || undefined })
          }
          style={selectStyle}
        >
          <option value="">{row.inherit ? "Inherit" : "Default"}</option>
          {EFFORT_OPTIONS.map((ef) => (
            <option key={ef} value={ef}>
              {ef}
            </option>
          ))}
        </select>
      </div>
    );
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Agent Seats — per-agent model & effort"
        aria-haspopup="dialog"
        aria-expanded={open}
        className="flex items-center gap-1.5 rounded-sm px-2 py-0.5 font-sans"
        style={{
          fontSize: "11px",
          border: "1px solid var(--color-rule)",
          background: "var(--color-bg-elevated)",
          color: "var(--color-ink)",
          cursor: "pointer",
        }}
      >
        Configure…
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Agent Seats"
          className="absolute right-0 z-50 rounded-md overflow-y-auto"
          style={{
            top: "calc(100% + 6px)",
            width: "380px",
            maxHeight: "420px",
            border: "1px solid var(--color-rule)",
            background: "var(--color-bg-elevated)",
            boxShadow: "0 8px 24px rgba(0,0,0,0.28)",
          }}
        >
          <div
            className="font-sans px-3 pt-2 pb-1"
            style={{ fontSize: "11px", color: "var(--color-ink-muted)" }}
          >
            Model and effort per agent seat. Default inherits your Claude Code
            default; unknown combinations fail at spawn.
          </div>
          {SEAT_GROUPS.map((group) => (
            <div key={group.label}>
              <div
                className="font-sans px-3 pt-2 pb-1"
                style={{
                  fontSize: "10px",
                  fontWeight: 700,
                  letterSpacing: "0.06em",
                  textTransform: "uppercase",
                  color: "var(--color-ink-muted)",
                  borderBottom: "1px solid var(--color-rule)",
                }}
              >
                {group.label}
              </div>
              {group.seats.map(renderSeat)}
            </div>
          ))}
          <div className="px-3 py-2">
            <div
              className="font-sans pb-1"
              style={{
                fontSize: "10px",
                fontWeight: 700,
                letterSpacing: "0.06em",
                textTransform: "uppercase",
                color: "var(--color-ink-muted)",
              }}
            >
              Claude binary
            </div>
            <input
              type="text"
              aria-label="Claude binary path"
              value={claudeBin}
              placeholder="Auto-detect (or an absolute path)"
              onChange={(e) => setClaudeBin(e.target.value)}
              onBlur={(e) => saveClaudeBin(e.target.value.trim())}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  saveClaudeBin((e.target as HTMLInputElement).value.trim());
                }
                if (e.key !== "Escape") e.stopPropagation();
              }}
              className="font-sans w-full rounded-sm px-2 py-1"
              style={{
                fontSize: "11px",
                border: "1px solid var(--color-rule)",
                background: "var(--color-paper)",
                color: "var(--color-ink)",
              }}
            />
            <div
              className="font-sans pt-1"
              style={{ fontSize: "10px", color: "var(--color-ink-muted)" }}
            >
              Applies to newly spawned agents; running ones keep their binary.
            </div>
          </div>
          {error && (
            <div
              className="font-sans px-3 pb-2"
              style={{ fontSize: "10px", color: "var(--color-warning, #d6c060)" }}
            >
              {error}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
