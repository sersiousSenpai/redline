// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ChevronDown, Search, Sparkles } from "lucide-react";
import { useMenuOverlay } from "./menuOverlay";
import {
  DEFAULT_PREFS,
  EFFORT_OPTIONS,
  MODEL_OPTIONS,
  POSTURES,
  applyPick,
  changedPicks,
  discretionBand,
  distinctPreflightModels,
  parsePrefs,
  pickTransition,
  seatSummary,
  traitLabel,
  type ModelCheck,
  type Posture,
  type SeatBlurb,
  type SeatAssignment,
  type SeatConfig,
  type SeatPick,
} from "../lib/seatAssign";

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

interface AgentSeatsView {
  seats: Record<string, SeatConfig>;
  knownSeats: string[];
  claudeBin: string | null;
  canRevert: boolean;
  blurbs: SeatBlurb[];
}

/** One roster row — mirrors Rust's `seat::SeatRosterEntry` (P3): the seat's
 *  standing charter/trigger (user override already merged over the default in
 *  Rust) plus what it has actually done (seat_stats) and burned (seat_burn,
 *  tokens only — money is never computed here). */
export interface SeatRosterEntry {
  seat: string;
  charter: string;
  trigger: string;
  lastRunAt: number | null;
  itemsFiled: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  spawns: number;
}

/** Compact token count: 950 → "950", 12400 → "12.4k", 2000000 → "2M". */
export function formatTokens(n: number): string {
  const fmt = (v: number, suffix: string) =>
    `${v.toFixed(1).replace(/\.0$/, "")}${suffix}`;
  if (n >= 1_000_000) return fmt(n / 1_000_000, "M");
  if (n >= 1_000) return fmt(n / 1_000, "k");
  return String(n);
}

/** "never ran" / "just now" / "12m ago" / "3h ago" / "5d ago". */
export function formatLastRun(
  ts: number | null | undefined,
  now: number = Date.now(),
): string {
  if (!ts) return "never ran";
  const mins = Math.floor((now - ts) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** The burn line, tokens only. */
export function burnSummary(e: SeatRosterEntry): string {
  if (e.spawns <= 0 && e.inputTokens <= 0 && e.outputTokens <= 0) {
    return "no burn recorded";
  }
  return `${formatTokens(e.inputTokens)} tok in · ${formatTokens(e.outputTokens)} tok out · ${e.spawns} spawn${e.spawns === 1 ? "" : "s"}`;
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
      { name: "memory", label: "Memory Ask" },
      { name: "browse", label: "Browser page discussions" },
      { name: "linked", label: "Linked discussion" },
      { name: "mission", label: "Missions" },
      { name: "ai_review", label: "AI code review" },
      { name: "ai_commit", label: "Commit drafter" },
      { name: "orchestrator", label: "Plan orchestrator" },
    ],
  },
  {
    label: "Library agents",
    seats: [
      { name: "keeper", label: "Keeper" },
      { name: "classifier", label: "ClassMemory classifier" },
      { name: "librarian", label: "Librarian" },
      { name: "shipwright", label: "Shipwright" },
      { name: "seatassign", label: "Seat Assignment" },
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

/** Seats whose row reads "Inherit" rather than "Default". */
function defaultLabelFor(row: SeatRow): string {
  return row.inherit ? "Inherit" : "Default";
}

/** The seat catalogue as a flat lookup, for the proposal card (which is keyed
 *  by seat name, not by group). */
const SEAT_ROWS: Record<string, SeatRow> = Object.fromEntries(
  SEAT_GROUPS.flatMap((g) => g.seats).map((s) => [s.name, s]),
);

/** One selectable row of the picker: a full (model, effort) choice. The
 *  Default/Inherit row is `{}`; a plain model row leaves effort unset. */
interface SeatOption {
  model?: string;
  effort?: string;
}

/** The full pick list: Default/Inherit, then each model plain + one row per
 *  effort level (the LM Studio-style flat searchable list, 25 rows). */
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

/** The pill used for every small on/off choice in this dialog: effort chips,
 *  fallback chips, and the posture selector. */
function chipStyle(active: boolean): React.CSSProperties {
  return {
    fontSize: "10px",
    padding: "2px 7px",
    borderRadius: "999px",
    cursor: "pointer",
    whiteSpace: "nowrap",
    border: active
      ? "1px solid color-mix(in srgb, var(--color-info) 55%, var(--color-rule))"
      : "1px solid var(--color-rule)",
    background: active
      ? "color-mix(in srgb, var(--color-info) 14%, transparent)"
      : "transparent",
    color: "var(--color-ink)",
  };
}

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

/** Hover/focus explainer for one seat: what the agent actually does, how it
 *  behaves, and any caveat worth knowing before you spend a premium model on
 *  it. Content comes from Rust (`seatassign::seat_blurbs`).
 *
 *  Fixed-positioned like `SeatPicker`, and for the same reason: the seat list
 *  lives in an `overflow-y: auto` container, so an absolutely-positioned
 *  tooltip would be clipped by it. */
function SeatInfo({
  blurb,
  children,
}: {
  blurb: SeatBlurb | undefined;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0, up: false });
  const anchorRef = useRef<HTMLSpanElement>(null);
  const timer = useRef<number | null>(null);

  const CARD_W = 320;
  // Rough height budget; only used to decide whether to flip above the row.
  const CARD_H = 190;

  const show = () => {
    const r = anchorRef.current?.getBoundingClientRect();
    if (!r) return;
    const up = r.bottom + CARD_H > window.innerHeight - 12;
    setPos({
      top: up ? window.innerHeight - r.top + 8 : r.bottom + 8,
      left: Math.max(12, Math.min(r.left, window.innerWidth - CARD_W - 12)),
      up,
    });
    setOpen(true);
  };

  const onEnter = () => {
    if (timer.current) window.clearTimeout(timer.current);
    // A short delay so sweeping the cursor down the list doesn't strobe.
    timer.current = window.setTimeout(show, 260);
  };
  const onLeave = () => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = null;
    setOpen(false);
  };

  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
    },
    [],
  );

  if (!blurb) return <>{children}</>;

  return (
    <>
      <span
        ref={anchorRef}
        onMouseEnter={onEnter}
        onMouseLeave={onLeave}
        onFocus={show}
        onBlur={onLeave}
        tabIndex={0}
        aria-describedby={open ? `rl-seatinfo-${blurb.seat}` : undefined}
        style={{ outline: "none", cursor: "help" }}
      >
        {children}
      </span>
      {open && (
        <div
          id={`rl-seatinfo-${blurb.seat}`}
          role="tooltip"
          style={{
            position: "fixed",
            [pos.up ? "bottom" : "top"]: `${pos.top}px`,
            left: `${pos.left}px`,
            width: `${CARD_W}px`,
            zIndex: 70,
            padding: "11px 13px 12px",
            borderRadius: "9px",
            border: "1px solid var(--color-rule)",
            // The dialog's own hero language: a radial accent glow over the
            // elevated surface.
            background:
              "radial-gradient(120% 140% at 0% 0%, color-mix(in srgb, var(--color-info) 13%, transparent), transparent 62%), var(--color-bg-elevated)",
            boxShadow: "0 10px 30px color-mix(in srgb, #000 34%, transparent)",
            pointerEvents: "none",
          }}
        >
          <div
            className="font-sans"
            style={{
              fontSize: "11.5px",
              fontWeight: 600,
              color: "var(--color-ink)",
              marginBottom: "5px",
            }}
          >
            {blurb.label}
          </div>
          <div
            className="font-sans"
            style={{
              fontSize: "11px",
              lineHeight: 1.5,
              color: "var(--color-ink-muted)",
            }}
          >
            {blurb.role}
          </div>
          {blurb.traits.length > 0 && (
            <div
              className="flex items-center gap-1 flex-wrap"
              style={{ marginTop: "9px" }}
            >
              {blurb.traits.map((t) => (
                <span key={t} style={{ ...chipStyle(false), fontSize: "9.5px" }}>
                  {traitLabel(t)}
                </span>
              ))}
            </div>
          )}
          {blurb.hint && (
            <div
              className="font-sans"
              style={{
                marginTop: "9px",
                paddingTop: "8px",
                borderTop: "1px solid var(--color-rule)",
                fontSize: "10.5px",
                lineHeight: 1.5,
                color: "var(--color-ink-muted)",
              }}
            >
              {blurb.hint}
            </div>
          )}
        </div>
      )}
    </>
  );
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
  onFallback,
}: {
  rowLabel: string;
  defaultLabel: string;
  cfg: SeatConfig;
  onPick: (choice: SeatOption) => void;
  /** Sets `--fallback-model`. The agent can write this, so the GUI must be
   *  able to show and clear it — otherwise a fallback it set is unremovable. */
  onFallback: (model: string | undefined) => void;
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
                      style={chipStyle((cfg.effort ?? "") === ef)}
                    >
                      {ef || "default"}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Fallback — `--fallback-model`, used when the primary is
              overloaded. Lives here so one control per row still covers
              everything the Seat Assignment agent can write. */}
          <div style={{ borderTop: "1px solid var(--color-rule)", padding: "6px 7px" }}>
            <div
              style={{
                fontSize: "9.5px",
                fontWeight: 700,
                letterSpacing: "0.12em",
                textTransform: "uppercase",
                color: "var(--color-ink-muted)",
                marginBottom: "5px",
              }}
            >
              Fallback when overloaded
            </div>
            <div className="flex items-center gap-1 flex-wrap" role="group" aria-label={`${rowLabel} fallback model`}>
              {["", ...MODEL_OPTIONS].map((m) => (
                <button
                  key={m || "__none"}
                  type="button"
                  onClick={() => onFallback(m || undefined)}
                  style={chipStyle((cfg.fallback ?? "") === m)}
                >
                  {m || "none"}
                </button>
              ))}
            </div>
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
  const [blurbs, setBlurbs] = useState<Record<string, SeatBlurb>>({});
  /** The roster rollup by seat: charter/trigger + stats + burn (P3). */
  const [roster, setRoster] = useState<Record<string, SeatRosterEntry>>({});
  // Non-null when the roster rollup failed to load — rendered as a muted
  // notice so a broken rollup can't masquerade as an unchanged dialog.
  const [rosterNote, setRosterNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // --- Seat Assignment agent -------------------------------------------
  const [posture, setPosture] = useState<Posture>(DEFAULT_PREFS.posture);
  const [discretion, setDiscretion] = useState(DEFAULT_PREFS.discretion);
  const [running, setRunning] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  /** The proposed chart, editable in place before it is applied. */
  const [picks, setPicks] = useState<SeatPick[]>([]);
  const [checks, setChecks] = useState<Record<string, ModelCheck>>({});
  const [canRevert, setCanRevert] = useState(false);
  const [applying, setApplying] = useState(false);
  /** A run finished (even with nothing to show). Without this the card renders
   *  only when there is a summary or a pick, so an agent reply that fails to
   *  parse produces NO visible change at all — indistinguishable from the
   *  button not working. */
  const [ranAt, setRanAt] = useState<number | null>(null);
  /** The run's own failure, rendered in the card. The dialog-wide `error` sits
   *  below the whole seat list and is off-screen from the Run button. */
  const [runError, setRunError] = useState<string | null>(null);
  /** The agent's reply when it carried no usable JSON. */
  const [rawReply, setRawReply] = useState<string | null>(null);
  const [applied, setApplied] = useState(0);
  const [skipped, setSkipped] = useState(0);
  /** The first apply of a card snapshots the pre-apply map for Revert. A ref,
   *  not state, so a second Apply in the same tick sees it already spent. */
  const snapshotPendingRef = useRef(true);
  const applyingRef = useRef(false);
  /** Set by Cancel so the in-flight promise's result is discarded even if the
   *  agent happened to finish between the click and the kill landing. */
  const cancelledRef = useRef(false);
  /** Model ids already probed (or in flight) — a probe costs a billed turn. */
  const probedRef = useRef<Record<string, true>>({});

  useMenuOverlay(open);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void invoke<AgentSeatsView>("get_agent_seats")
      .then((view) => {
        if (cancelled) return;
        setSeats(view.seats);
        setClaudeBin(view.claudeBin ?? "");
        setCanRevert(view.canRevert);
        setBlurbs(
          Object.fromEntries((view.blurbs ?? []).map((b) => [b.seat, b])),
        );
      })
      .catch((e) => setError(String(e)));
    void invoke<SeatRosterEntry[]>("get_seat_roster")
      .then((entries) => {
        if (cancelled) return;
        setRoster(Object.fromEntries(entries.map((e) => [e.seat, e])));
      })
      .catch((e) => {
        // The pickers still work without the roster, but a silent skip made a
        // failed rollup indistinguishable from "nothing shipped" — say so.
        if (!cancelled) setRosterNote(String(e));
        console.error("get_seat_roster failed", e);
      });
    void invoke<{ seatAssignPrefs: string | null }>("get_ui_prefs")
      .then((prefs) => {
        if (cancelled) return;
        const p = parsePrefs(prefs.seatAssignPrefs);
        setPosture(p.posture);
        setDiscretion(p.discretion);
      })
      .catch(() => {
        /* prefs are a convenience — defaults are fine */
      });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => {
      cancelled = true;
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const savePrefs = useCallback((next: { posture: Posture; discretion: number }) => {
    void invoke("set_ui_pref", {
      key: "seatAssignPrefs",
      value: JSON.stringify(next),
    }).catch(() => {
      /* non-fatal */
    });
  }, []);

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

  const dismissCard = () => {
    setPicks([]);
    setSummary(null);
    setChecks({});
    setApplied(0);
    setSkipped(0);
    setRanAt(null);
    setRunError(null);
    setRawReply(null);
    probedRef.current = {};
  };

  /** Probe any custom model ids in the chart. Aliases short-circuit in Rust,
   *  so an all-alias chart costs zero spawns and this is usually a no-op.
   *
   *  A probe of a *valid* custom id is a real billed `claude` turn, so ids
   *  already probed (or in flight) are never probed again — otherwise clicking
   *  through the five fallback chips would spawn one turn per click per id. */
  const runPreflight = useCallback((chart: SeatPick[]) => {
    const models = distinctPreflightModels(chart).filter(
      (m) => !(m in probedRef.current),
    );
    if (models.length === 0) return;
    for (const m of models) probedRef.current[m] = true;
    void invoke<ModelCheck[]>("seat_preflight", { models })
      .then((results) => {
        setChecks((prev) => {
          const next = { ...prev };
          for (const r of results) next[r.model] = r;
          return next;
        });
      })
      .catch(() => {
        // An unverifiable probe leaves the row unbadged, never blocked — but
        // let it be retried rather than pinning a failure forever.
        for (const m of models) delete probedRef.current[m];
      });
  }, []);

  const runAssignment = () => {
    setRunning(true);
    setError(null);
    setRunError(null);
    dismissCard();
    cancelledRef.current = false;
    snapshotPendingRef.current = true;
    void invoke<SeatAssignment>("seat_assignment_agent", { posture, discretion })
      .then((result) => {
        if (cancelledRef.current) return;
        setSummary(result.summary || null);
        setPicks(result.picks);
        setRawReply(result.raw ?? null);
        setRanAt(Date.now());
        runPreflight(result.picks);
      })
      .catch((e) => {
        // Cancel is a deliberate user action, not an error to shout about.
        if (cancelledRef.current || String(e).includes("cancelled")) return;
        setRunError(String(e));
      })
      .finally(() => setRunning(false));
  };

  /** Stop the run. The button returns to "Run assignment" immediately rather
   *  than waiting for the killed process to close its pipes and the promise to
   *  settle — otherwise Cancel looks as inert as Run did. */
  const cancelAssignment = () => {
    cancelledRef.current = true;
    setRunning(false);
    setRunError(null);
    void invoke("seat_assignment_cancel").catch(() => {
      /* nothing to cancel is not an error */
    });
  };

  const applyPicks = (chart: SeatPick[]) => {
    if (chart.length === 0 || applyingRef.current) return;
    setError(null);
    // Both guards are synchronous refs, not state: React state settles a tick
    // later, so a double-click would otherwise send `snapshotFirst: true`
    // twice — the second call stashing the ALREADY-applied chart and turning
    // Revert into a no-op with the original chart unrecoverable.
    applyingRef.current = true;
    const snapshotFirst = snapshotPendingRef.current;
    snapshotPendingRef.current = false;
    setApplying(true);
    void invoke<AgentSeatsView>("apply_seat_picks", { picks: chart, snapshotFirst })
      .then((view) => {
        setSeats(view.seats);
        setCanRevert(view.canRevert);
        setApplied((n) => n + chart.length);
        const done = new Set(chart.map((p) => p.seat));
        setPicks((prev) => prev.filter((p) => !done.has(p.seat)));
      })
      .catch((e) => {
        // The batch never landed, so the next attempt must snapshot again.
        snapshotPendingRef.current = snapshotFirst;
        setError(String(e));
      })
      .finally(() => {
        applyingRef.current = false;
        setApplying(false);
      });
  };

  const revert = () => {
    setError(null);
    void invoke<AgentSeatsView>("revert_seat_assignment")
      .then((view) => {
        setSeats(view.seats);
        setCanRevert(view.canRevert);
        dismissCard();
      })
      .catch((e) => setError(String(e)));
  };

  /** Edit a proposed pick in place — overruling the agent before applying.
   *  Computed outside the updater so the preflight spawn isn't fired twice
   *  when React double-invokes it. */
  const editPick = (seat: string, patch: Partial<SeatPick>) => {
    const next = picks.map((p) => (p.seat === seat ? { ...p, ...patch } : p));
    setPicks(next);
    runPreflight(next);
  };

  const saveClaudeBin = (path: string) => {
    setClaudeBin(path);
    setError(null);
    void invoke("set_claude_bin_override", { path }).catch((e) =>
      setError(String(e)),
    );
  };

  /** One roster row: the seat's name and standing charter/trigger, what it
   *  has actually done (stats + burn, tokens only), and the existing
   *  model/effort/fallback picker. */
  const renderSeat = (row: SeatRow) => {
    const cfg = seats[row.name] ?? {};
    const defaultLabel = defaultLabelFor(row);
    const summary = seatSummary(seats[row.name]);
    const entry: SeatRosterEntry | undefined = roster[row.name];
    return (
      <div
        key={row.name}
        className="px-4 py-2"
        style={{ borderBottom: "1px solid var(--color-rule)" }}
      >
        <div className="flex items-center gap-2">
          <GlowDot on={!!summary} />
          <span
            className="font-sans flex-1 min-w-0"
            style={{ fontSize: "12px", color: "var(--color-ink)" }}
          >
            <SeatInfo blurb={blurbs[row.name]}>
              <span
                style={{
                  borderBottom:
                    "1px dotted color-mix(in srgb, var(--color-ink-muted) 55%, transparent)",
                }}
              >
                {row.label}
              </span>
            </SeatInfo>
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
          {row.name === "ai_commit" && <select
            aria-label={`${row.label} backend`}
            value={cfg.backend ?? "claude-code"}
            onChange={(e) =>
              update(row.name, {
                backend:
                  e.target.value === "claude-code" ? undefined : e.target.value,
              })
            }
            style={selectStyle}
          >
            <option value="claude-code">Claude Code</option>
            <option value="codex">Codex</option>
          </select>}
          <SeatPicker
            rowLabel={row.label}
            defaultLabel={defaultLabel}
            cfg={cfg}
            onPick={(choice) =>
              update(row.name, { model: choice.model, effort: choice.effort })
            }
            onFallback={(model) => update(row.name, { fallback: model })}
          />
        </div>
        {entry && (
          <div className="font-sans" style={{ margin: "4px 0 0 16px" }}>
            <div
              style={{
                fontSize: "11px",
                lineHeight: 1.45,
                color: "var(--color-ink)",
              }}
            >
              {entry.charter}
            </div>
            <div
              style={{
                fontSize: "10.5px",
                fontStyle: "italic",
                color: "var(--color-ink-muted)",
                marginTop: "2px",
              }}
            >
              {entry.trigger}
            </div>
            <div
              title={`input ${entry.inputTokens} · output ${entry.outputTokens} · cache read ${entry.cacheReadTokens} · cache write ${entry.cacheCreationTokens}`}
              style={{
                fontSize: "10px",
                color: "var(--color-ink-muted)",
                marginTop: "3px",
                letterSpacing: "0.02em",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {formatLastRun(entry.lastRunAt)} · {entry.itemsFiled} filed ·{" "}
              {burnSummary(entry)}
            </div>
          </div>
        )}
      </div>
    );
  };

  const band = discretionBand(discretion);
  // Filtered at render, not when the result arrived: the run takes minutes, and
  // the user can hand-edit seats in this very dialog while it works. Filtering
  // against a stale snapshot would leave rows reading "sonnet → sonnet".
  const visiblePicks = changedPicks(seats, picks);

  /** One proposed row: the transition, the rationale, and the controls that
   *  let the user overrule it before applying. */
  const renderPick = (pick: SeatPick) => {
    const row = SEAT_ROWS[pick.seat];
    const label = row?.label ?? pick.seat;
    const defaultLabel = row ? defaultLabelFor(row) : "Default";
    const current = seats[pick.seat];
    const { from, to } = pickTransition(current, pick, defaultLabel);
    const check = pick.model ? checks[pick.model] : undefined;
    return (
      <div
        key={pick.seat}
        className="font-sans"
        style={{
          padding: "10px 12px",
          borderTop: "1px solid var(--color-rule)",
        }}
      >
        <div className="flex items-center gap-2" style={{ flexWrap: "wrap" }}>
          <GlowDot on />
          <SeatInfo blurb={blurbs[pick.seat]}>
            <span
              style={{
                fontSize: "12px",
                color: "var(--color-ink)",
                borderBottom:
                  "1px dotted color-mix(in srgb, var(--color-ink-muted) 55%, transparent)",
              }}
            >
              {label}
            </span>
          </SeatInfo>
          <span style={{ fontSize: "11px", color: "var(--color-ink-muted)" }}>
            {from} →
          </span>
          <span style={{ fontSize: "11px", fontWeight: 600, color: "var(--color-ink)" }}>
            {to}
          </span>
          {pick.deviates && (
            <span
              title="Departs from your stated posture"
              style={{
                fontSize: "9.5px",
                padding: "1px 7px",
                borderRadius: "999px",
                whiteSpace: "nowrap",
                border: "1px solid color-mix(in srgb, var(--color-warning) 45%, var(--color-rule))",
                background: "color-mix(in srgb, var(--color-warning) 12%, transparent)",
                color: "var(--color-ink)",
              }}
            >
              ⟂ off-posture
            </span>
          )}
          {check && (
            <span
              title={check.ok ? "Model verified" : check.error ?? "Model rejected"}
              style={{
                fontSize: "9.5px",
                whiteSpace: "nowrap",
                color: check.ok ? "var(--color-ink-muted)" : "var(--color-warning)",
              }}
            >
              {check.ok ? "✓ verified" : "✕ model rejected"}
            </span>
          )}
        </div>
        <div
          style={{
            fontSize: "11px",
            color: "var(--color-ink-muted)",
            margin: "6px 0 8px 16px",
          }}
        >
          {pick.rationale}
        </div>
        <div className="flex items-center gap-2" style={{ marginLeft: "16px" }}>
          <SeatPicker
            rowLabel={`${label} proposed`}
            defaultLabel={defaultLabel}
            cfg={applyPick(current, pick)}
            onPick={(choice) =>
              editPick(pick.seat, { model: choice.model, effort: choice.effort })
            }
            onFallback={(model) => editPick(pick.seat, { fallback: model })}
          />
          <div className="flex-1" />
          <button
            type="button"
            disabled={applying}
            onClick={() => applyPicks([pick])}
            style={{
              ...chipStyle(true),
              fontSize: "11px",
              padding: "3px 12px",
              opacity: applying ? 0.5 : 1,
              cursor: applying ? "default" : "pointer",
            }}
          >
            Apply
          </button>
          <button
            type="button"
            onClick={() => {
              setPicks((prev) => prev.filter((p) => p.seat !== pick.seat));
              setSkipped((n) => n + 1);
            }}
            style={{ ...chipStyle(false), fontSize: "11px", padding: "3px 12px" }}
          >
            Skip
          </button>
        </div>
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
                    {rosterNote ? (
                      <span style={{ color: "var(--color-warning)" }}>
                        {" "}
                        Roster unavailable: {rosterNote}
                      </span>
                    ) : null}
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
              {/* Seat Assignment — reads how you actually work and proposes
                  the whole chart. Nothing lands until you press Apply. */}
              <div className="px-4 pt-3 pb-1">
                <div
                  className="font-sans"
                  style={{
                    border: "1px solid var(--color-rule)",
                    borderRadius: "8px",
                    background: "var(--color-paper)",
                    overflow: "hidden",
                  }}
                >
                  <div style={{ padding: "10px 12px" }}>
                    <div
                      className="flex items-center gap-1.5"
                      style={{
                        fontSize: "10px",
                        fontWeight: 700,
                        letterSpacing: "0.14em",
                        textTransform: "uppercase",
                        color: "var(--color-ink-muted)",
                      }}
                    >
                      <Sparkles size={11} aria-hidden />
                      Seat Assignment
                    </div>

                    <div
                      className="flex items-center gap-1.5 flex-wrap"
                      role="group"
                      aria-label="Posture"
                      style={{ marginTop: "9px" }}
                    >
                      {POSTURES.map((p) => (
                        <button
                          key={p.value}
                          type="button"
                          title={p.hint}
                          aria-pressed={posture === p.value}
                          onClick={() => {
                            setPosture(p.value);
                            savePrefs({ posture: p.value, discretion });
                          }}
                          style={{ ...chipStyle(posture === p.value), fontSize: "11px" }}
                        >
                          {p.label}
                        </button>
                      ))}
                    </div>

                    <label
                      htmlFor="rl-seat-discretion"
                      style={{
                        display: "block",
                        fontSize: "11px",
                        color: "var(--color-ink)",
                        margin: "10px 0 3px",
                      }}
                    >
                      Agent discretion — {band.label} ({discretion})
                    </label>
                    <input
                      id="rl-seat-discretion"
                      type="range"
                      min={0}
                      max={100}
                      step={5}
                      value={discretion}
                      onChange={(e) => setDiscretion(Number(e.target.value))}
                      onMouseUp={() => savePrefs({ posture, discretion })}
                      onKeyUp={() => savePrefs({ posture, discretion })}
                      style={{ width: "100%", accentColor: "var(--color-info)" }}
                    />
                    <div
                      style={{
                        fontSize: "10.5px",
                        color: "var(--color-ink-muted)",
                        marginTop: "2px",
                      }}
                    >
                      {band.caption}
                    </div>

                    <div className="flex items-center gap-2" style={{ marginTop: "10px" }}>
                      <div className="flex-1" />
                      <button
                        type="button"
                        onClick={running ? cancelAssignment : runAssignment}
                        style={{
                          ...chipStyle(!running),
                          fontSize: "11px",
                          padding: "4px 14px",
                        }}
                      >
                        {running ? "Cancel" : "Run assignment"}
                      </button>
                    </div>

                    {running && (
                      <div
                        style={{
                          fontSize: "10.5px",
                          color: "var(--color-ink-muted)",
                          marginTop: "8px",
                          textAlign: "right",
                        }}
                      >
                        Reading your usage and drafting a chart — this takes a
                        minute.
                      </div>
                    )}
                    {runError && (
                      <div
                        style={{
                          fontSize: "11px",
                          color: "var(--color-warning)",
                          marginTop: "8px",
                          whiteSpace: "pre-wrap",
                          wordBreak: "break-word",
                        }}
                      >
                        {runError}
                      </div>
                    )}
                  </div>

                  {(summary || visiblePicks.length > 0 || applied > 0 || ranAt !== null) && (
                    <>
                      {summary && (
                        <div
                          className="font-sans"
                          style={{
                            padding: "8px 12px",
                            fontSize: "11px",
                            color: "var(--color-ink-muted)",
                            borderTop: "1px solid var(--color-rule)",
                          }}
                        >
                          {summary}
                        </div>
                      )}
                      {rawReply && (
                        <div
                          className="font-sans"
                          style={{
                            padding: "8px 12px",
                            borderTop: "1px solid var(--color-rule)",
                            fontSize: "10.5px",
                            color: "var(--color-ink-muted)",
                            whiteSpace: "pre-wrap",
                            wordBreak: "break-word",
                            maxHeight: "160px",
                            overflowY: "auto",
                          }}
                        >
                          <span style={{ color: "var(--color-warning)" }}>
                            The agent replied without the JSON chart it was asked
                            for. It said:
                          </span>
                          {"\n"}
                          {rawReply}
                        </div>
                      )}
                      {visiblePicks.map(renderPick)}
                      <div
                        className="flex items-center gap-2 font-sans"
                        style={{
                          padding: "9px 12px",
                          borderTop: "1px solid var(--color-rule)",
                          fontSize: "11px",
                          color: "var(--color-ink-muted)",
                        }}
                      >
                        <span>
                          {visiblePicks.length > 0
                            ? `${visiblePicks.length} proposed change${visiblePicks.length === 1 ? "" : "s"}.`
                            : applied > 0
                              ? `Applied ${applied} change${applied === 1 ? "" : "s"}.`
                              : skipped > 0
                                ? `Skipped ${skipped} change${skipped === 1 ? "" : "s"}.`
                                : summary
                                  ? "Your seats already match this posture."
                                  : "The agent returned no usable picks."}
                        </span>
                        <div className="flex-1" />
                        {visiblePicks.length > 0 && (
                          <button
                            type="button"
                            disabled={applying}
                            onClick={() => applyPicks(visiblePicks)}
                            style={{
                              ...chipStyle(true),
                              fontSize: "11px",
                              padding: "3px 12px",
                              opacity: applying ? 0.5 : 1,
                              cursor: applying ? "default" : "pointer",
                            }}
                          >
                            Apply all {visiblePicks.length}
                          </button>
                        )}
                        {canRevert && (
                          <button
                            type="button"
                            // Not "before this run": the snapshot is taken at
                            // the first apply, so after a fresh run that has
                            // applied nothing yet, this still undoes the
                            // previous applied batch.
                            title="Restore the seat chart saved before the last applied run"
                            onClick={revert}
                            style={{ ...chipStyle(false), fontSize: "11px", padding: "3px 12px" }}
                          >
                            Revert
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={dismissCard}
                          style={{ ...chipStyle(false), fontSize: "11px", padding: "3px 12px" }}
                        >
                          Dismiss
                        </button>
                      </div>
                    </>
                  )}
                </div>
              </div>

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
