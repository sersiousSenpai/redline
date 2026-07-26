// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ChevronDown, Search } from "lucide-react";
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

/** One selectable row of the picker: a full (model, effort) choice. The
 *  Default/Inherit row is `{}`; a plain model row leaves effort unset. */
interface SeatOption {
  model?: string;
  effort?: string;
}

/** The full pick list: Default/Inherit, then each model plain + its four
 *  effort variants (the LM Studio-style flat searchable list, ~16 rows). */
function seatOptions(): SeatOption[] {
  return [
    {},
    ...MODEL_OPTIONS.flatMap((m) => [
      { model: m },
      ...EFFORT_OPTIONS.map((ef) => ({ model: m, effort: ef })),
    ]),
  ];
}

/** Case-insensitive token match against "model effort" (e.g. "op ma" hits
 *  "opus · max"). Exported shape kept pure for unit testing. */
export function matchesSeatQuery(
  opt: SeatOption,
  defaultLabel: string,
  query: string,
): boolean {
  const hay = (opt.model
    ? `${opt.model} ${opt.effort ?? ""}`
    : defaultLabel
  ).toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((tok) => hay.includes(tok));
}

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

/** One rich popover picker per seat (replaces the old model + effort native
 *  selects): a search filter, the Default/Inherit row, every model × effort
 *  combo as a flat selectable list, and a Custom… section for free-text
 *  model ids with inline effort. Presentation-only — a pick still lands as
 *  the same `SeatConfig.model` + `SeatConfig.effort`. */
function SeatPicker({
  rowLabel,
  defaultLabel,
  cfg,
  onPick,
}: {
  rowLabel: string;
  defaultLabel: string;
  cfg: SeatConfig;
  onPick: (choice: SeatOption) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [customOpen, setCustomOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [popTop, setPopTop] = useState(0);
  const [popRight, setPopRight] = useState(0);
  const [popUp, setPopUp] = useState(false);

  const model = cfg.model ?? "";
  const isCustomModel = model !== "" && !MODEL_OPTIONS.includes(model);
  const buttonLabel = model
    ? cfg.effort
      ? `${model} · ${cfg.effort}`
      : model
    : defaultLabel;

  const openPop = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (r) {
      // Fixed positioning so the popover escapes the dialog's scroll clip;
      // flip upward when the row sits in the lower half of the viewport.
      const up = r.bottom > window.innerHeight - 340;
      setPopUp(up);
      setPopTop(up ? window.innerHeight - r.top + 4 : r.bottom + 4);
      setPopRight(window.innerWidth - r.right);
    }
    setQuery("");
    setCustomOpen(isCustomModel);
    setOpen(true);
  };

  // Outside-click + Escape close (Escape stops here — it must not also
  // dismiss the whole dialog).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (popRef.current?.contains(t) || btnRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const pick = (choice: SeatOption) => {
    onPick(choice);
    setOpen(false);
  };

  const options = seatOptions().filter((o) =>
    matchesSeatQuery(o, defaultLabel, query),
  );
  const isActive = (o: SeatOption) =>
    (o.model ?? "") === model && (o.effort ?? "") === (cfg.effort ?? "");

  const rowStyle = (active: boolean): React.CSSProperties => ({
    display: "flex",
    alignItems: "center",
    gap: "8px",
    width: "100%",
    textAlign: "left",
    padding: "5px 10px",
    fontSize: "11.5px",
    cursor: "pointer",
    border: "none",
    borderRadius: "5px",
    color: "var(--color-ink)",
    background: active
      ? "color-mix(in srgb, var(--color-info) 14%, transparent)"
      : "transparent",
  });

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        aria-label={`${rowLabel} model & effort`}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : openPop())}
        className="font-sans flex items-center gap-1.5"
        style={{
          ...selectStyle,
          cursor: "pointer",
          whiteSpace: "nowrap",
          maxWidth: "180px",
        }}
      >
        <span className="truncate">{buttonLabel}</span>
        <ChevronDown size={12} strokeWidth={2} style={{ flexShrink: 0 }} />
      </button>

      {open && (
        <div
          ref={popRef}
          role="listbox"
          aria-label={`${rowLabel} choices`}
          className="font-sans"
          style={{
            position: "fixed",
            ...(popUp ? { bottom: popTop } : { top: popTop }),
            right: popRight,
            zIndex: 60,
            width: "230px",
            display: "flex",
            flexDirection: "column",
            background: "var(--color-bg-elevated)",
            border: "1px solid var(--color-rule)",
            borderRadius: "8px",
            boxShadow: "0 12px 32px rgba(0,0,0,0.32)",
            overflow: "hidden",
          }}
        >
          {/* Search filter — the LM Studio move. */}
          <div
            className="flex items-center gap-1.5 px-2.5 py-2"
            style={{ borderBottom: "1px solid var(--color-rule)" }}
          >
            <Search
              size={12}
              strokeWidth={2}
              style={{ color: "var(--color-ink-muted)", flexShrink: 0 }}
            />
            <input
              autoFocus
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter models…"
              aria-label={`Filter ${rowLabel} choices`}
              style={{
                flex: 1,
                minWidth: 0,
                fontSize: "11.5px",
                border: "none",
                outline: "none",
                background: "transparent",
                color: "var(--color-ink)",
              }}
            />
          </div>

          <div
            className="rl-thin-scroll-y"
            style={{ overflowY: "auto", maxHeight: "240px", padding: "4px" }}
          >
            {options.map((o, i) => {
              const isGroupStart =
                !!o.model && !o.effort && (i === 0 || options[i - 1]?.model !== o.model);
              return (
                <div key={`${o.model ?? "__default"}-${o.effort ?? ""}`}>
                  {isGroupStart && i > 0 && (
                    <div
                      aria-hidden
                      style={{
                        height: "1px",
                        margin: "3px 6px",
                        background: "var(--color-rule)",
                      }}
                    />
                  )}
                  <button
                    type="button"
                    role="option"
                    aria-selected={isActive(o)}
                    onClick={() => pick(o)}
                    style={rowStyle(isActive(o))}
                  >
                    <span style={{ flex: 1, minWidth: 0 }} className="truncate">
                      {o.model ?? defaultLabel}
                    </span>
                    {o.effort && (
                      <span
                        style={{
                          fontSize: "10px",
                          color: "var(--color-ink-muted)",
                          border: "1px solid var(--color-rule)",
                          borderRadius: "999px",
                          padding: "0 6px",
                          flexShrink: 0,
                        }}
                      >
                        {o.effort}
                      </span>
                    )}
                  </button>
                </div>
              );
            })}
            {options.length === 0 && !customOpen && (
              <div
                style={{
                  padding: "8px 10px",
                  fontSize: "11px",
                  color: "var(--color-ink-muted)",
                }}
              >
                No matches — try Custom…
              </div>
            )}
          </div>

          {/* Custom… — free-text model id + inline effort. */}
          <div style={{ borderTop: "1px solid var(--color-rule)", padding: "4px" }}>
            {!customOpen ? (
              <button
                type="button"
                onClick={() => setCustomOpen(true)}
                style={rowStyle(isCustomModel)}
              >
                <span style={{ flex: 1 }}>Custom…</span>
                {isCustomModel && (
                  <span
                    className="truncate"
                    style={{
                      fontSize: "10px",
                      color: "var(--color-ink-muted)",
                      maxWidth: "110px",
                    }}
                  >
                    {model}
                  </span>
                )}
              </button>
            ) : (
              <div className="flex flex-col gap-1.5 px-1.5 py-1">
                <input
                  type="text"
                  aria-label={`${rowLabel} custom model id`}
                  defaultValue={isCustomModel ? model : "claude-"}
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      const v = (e.target as HTMLInputElement).value.trim();
                      pick({ model: v || undefined, effort: cfg.effort });
                    }
                    if (e.key !== "Escape") e.stopPropagation();
                  }}
                  onBlur={(e) => {
                    const v = e.target.value.trim();
                    // Commit without closing — effort chips below may be next.
                    if (v && v !== model) onPick({ model: v, effort: cfg.effort });
                  }}
                  placeholder="claude-…"
                  style={{ ...selectStyle, width: "100%", boxSizing: "border-box" }}
                />
                <div className="flex items-center gap-1" role="group" aria-label="Custom model effort">
                  {["", ...EFFORT_OPTIONS].map((ef) => (
                    <button
                      key={ef || "__none"}
                      type="button"
                      onClick={() =>
                        onPick({ model: cfg.model, effort: ef || undefined })
                      }
                      style={{
                        fontSize: "10px",
                        padding: "2px 7px",
                        borderRadius: "999px",
                        cursor: "pointer",
                        border:
                          (cfg.effort ?? "") === ef
                            ? "1px solid color-mix(in srgb, var(--color-info) 55%, var(--color-rule))"
                            : "1px solid var(--color-rule)",
                        background:
                          (cfg.effort ?? "") === ef
                            ? "color-mix(in srgb, var(--color-info) 14%, transparent)"
                            : "transparent",
                        color: "var(--color-ink)",
                      }}
                    >
                      {ef || "default"}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
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
        <SeatPicker
          rowLabel={row.label}
          defaultLabel={defaultLabel}
          cfg={cfg}
          onPick={(choice) =>
            update(row.name, { model: choice.model, effort: choice.effort })
          }
        />
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
