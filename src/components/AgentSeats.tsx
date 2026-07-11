// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useMenuOverlay } from "./menuOverlay";

// Agent Seats — per-seat model/effort configuration for every headless agent
// Redline spawns (see src-tauri/src/seat.rs). Each seat row offers a model
// (Default = inherit the CLI's global default, or an explicit tier / custom
// id) and an effort sub-choice; fork-thread categories default to "Inherit"
// so a thread runs exactly like its parent surface. The panel also exposes
// the global `claude` binary override. Self-contained: loads on open, saves
// per change — no App state involved.
//
// Styling follows the snapshot share surfaces (ShareSnapshotDialog + the
// zero-install viewer's hero): a centered dialog with a radial accent glow,
// a hairline gradient seam under the header, glow-dot status markers, and
// pill chips for the effective config.

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
  borderRadius: "6px",
  padding: "4px 6px",
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  fontSize: "12px",
  color: "var(--color-ink)",
  background: "var(--color-paper)",
  border: "1px solid var(--color-rule)",
  borderRadius: "6px",
  boxSizing: "border-box",
};

/** The viewer's glow-dot: lit when the seat carries any explicit config. */
function GlowDot({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden
      style={{
        width: "8px",
        height: "8px",
        borderRadius: "2px",
        flexShrink: 0,
        background: on ? "var(--color-info)" : "transparent",
        border: on ? "none" : "1px solid var(--color-rule)",
        boxShadow: on
          ? "0 0 8px color-mix(in srgb, var(--color-info) 70%, transparent)"
          : "none",
      }}
    />
  );
}

function seatSummary(cfg: SeatConfig | undefined): string | null {
  if (!cfg) return null;
  const bits = [cfg.model, cfg.effort].filter(
    (v): v is string => !!v && v.trim() !== "",
  );
  return bits.length ? bits.join(" · ") : null;
}

export function AgentSeats() {
  const [open, setOpen] = useState(false);
  const [seats, setSeats] = useState<Record<string, SeatConfig>>({});
  const [claudeBin, setClaudeBin] = useState("");
  const [error, setError] = useState<string | null>(null);

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
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => {
      cancelled = true;
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
    save(name, { ...(seats[name] ?? {}), ...patch });
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
    const summary = seatSummary(seats[row.name]);
    return (
      <div
        key={row.name}
        className="flex items-center gap-2 px-4 py-2"
        style={{ borderBottom: "1px solid var(--color-rule)" }}
      >
        <GlowDot on={!!summary} />
        <span
          className="font-sans flex-1 min-w-0"
          style={{ fontSize: "12px", color: "var(--color-ink)" }}
        >
          {row.label}
          {summary && (
            <span
              className="font-sans"
              style={{
                marginLeft: "8px",
                fontSize: "10.5px",
                color: "var(--color-ink)",
                background: "color-mix(in srgb, var(--color-info) 12%, transparent)",
                border:
                  "1px solid color-mix(in srgb, var(--color-info) 40%, var(--color-rule))",
                borderRadius: "999px",
                padding: "1px 8px",
                whiteSpace: "nowrap",
              }}
            >
              {summary}
            </span>
          )}
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
            onBlur={(e) =>
              update(row.name, { model: e.target.value.trim() || undefined })
            }
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                update(row.name, {
                  model:
                    (e.target as HTMLInputElement).value.trim() || undefined,
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
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
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
          className="fixed inset-0 flex items-center justify-center z-50"
          style={{ background: "var(--color-overlay)" }}
          onClick={() => setOpen(false)}
        >
          <div
            role="dialog"
            aria-label="Agent Seats"
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "560px",
              maxWidth: "94vw",
              maxHeight: "88vh",
              display: "flex",
              flexDirection: "column",
              background: "var(--color-bg-elevated)",
              border: "1px solid var(--color-rule)",
              borderRadius: "10px",
              overflow: "hidden",
            }}
          >
            {/* Hero header — the viewer's corner glow + gradient wash. */}
            <header
              style={{
                position: "relative",
                flexShrink: 0,
                padding: "16px 20px 14px",
                background:
                  "radial-gradient(120% 140% at 0% 0%, color-mix(in srgb, var(--color-info) 12%, transparent), transparent 60%), linear-gradient(180deg, var(--color-bg-elevated), var(--color-paper))",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  justifyContent: "space-between",
                  gap: "16px",
                }}
              >
                <div>
                  <div
                    className="font-sans flex items-center gap-2"
                    style={{
                      fontSize: "11px",
                      fontWeight: 700,
                      letterSpacing: "0.14em",
                      textTransform: "uppercase",
                      color: "var(--color-ink-muted)",
                    }}
                  >
                    <span
                      aria-hidden
                      style={{
                        width: "9px",
                        height: "9px",
                        borderRadius: "2px",
                        background: "var(--color-info)",
                        boxShadow:
                          "0 0 10px color-mix(in srgb, var(--color-info) 70%, transparent)",
                      }}
                    />
                    Agent Seats
                  </div>
                  <div
                    className="font-sans"
                    style={{
                      fontSize: "12px",
                      color: "var(--color-ink-muted)",
                      marginTop: "8px",
                      maxWidth: "46ch",
                    }}
                  >
                    Which mind sits in each seat — model and effort per agent.
                    Default inherits your Claude Code default; unknown
                    combinations fail at spawn.
                  </div>
                </div>
                <button
                  onClick={() => setOpen(false)}
                  aria-label="Close"
                  style={{
                    border: "none",
                    background: "transparent",
                    color: "var(--color-ink-muted)",
                    fontSize: "18px",
                    cursor: "pointer",
                  }}
                >
                  ✕
                </button>
              </div>
            </header>
            {/* Hairline accent seam under the hero. */}
            <div
              aria-hidden
              style={{
                flexShrink: 0,
                height: "2px",
                opacity: 0.65,
                background:
                  "linear-gradient(90deg, var(--color-info), color-mix(in srgb, var(--color-info) 20%, transparent))",
              }}
            />

            <div style={{ overflowY: "auto" }}>
              {SEAT_GROUPS.map((group) => (
                <div key={group.label}>
                  <div
                    className="font-sans px-4 pt-3 pb-1"
                    style={{
                      fontSize: "10px",
                      fontWeight: 700,
                      letterSpacing: "0.14em",
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

              <div className="px-4 py-3">
                <div
                  className="font-sans"
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "8px",
                    padding: "10px 12px",
                    border: "1px solid var(--color-rule)",
                    borderRadius: "8px",
                    background: "var(--color-paper)",
                  }}
                >
                  <div
                    style={{
                      fontSize: "10px",
                      fontWeight: 700,
                      letterSpacing: "0.14em",
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
                        saveClaudeBin(
                          (e.target as HTMLInputElement).value.trim(),
                        );
                      }
                      if (e.key !== "Escape") e.stopPropagation();
                    }}
                    style={inputStyle}
                  />
                  <div
                    style={{
                      fontSize: "10.5px",
                      color: "var(--color-ink-muted)",
                    }}
                  >
                    Applies to newly spawned agents; running ones keep their
                    binary.
                  </div>
                </div>
                {error && (
                  <div
                    className="font-sans"
                    style={{
                      fontSize: "11px",
                      color: "var(--color-warning)",
                      marginTop: "8px",
                    }}
                  >
                    {error}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
