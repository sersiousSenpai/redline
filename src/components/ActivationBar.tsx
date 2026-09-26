// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian

// The one piece of Build Redline that lives outside Runs.
//
// Preparing a replacement takes as long as it takes, and the user is somewhere
// else while it happens. When it finishes, something has to say so — once,
// quietly, and in a way that can be ignored indefinitely. Deferring is a
// first-class answer: the current version keeps running, and an overnight run
// that prepared a candidate never gets to decide that Redline should restart.
//
// The same component owns the two moments where Redline is not fully itself:
// while it is saving and draining before a restart, and while a freshly
// installed version is proving it works. Both are short, both refuse writes,
// and both are the user's editor behaving strangely if nothing explains them.

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  announceable,
  formatEstimate,
  readyHeadline,
  restartEstimateMs,
  type ActivationReport,
  type ActivationStatus,
  type InterruptedWork,
  type Release,
  type RestartRefused,
} from "../lib/selfDevelop";

/** Per-viewer convenience only: which candidate the user already said "Later"
 *  to. Never load-bearing — a cleared store just means the indicator comes
 *  back, which is the safe direction. */
const DEFERRED_KEY = "redline.activation.deferred";

function readDeferred(): string | null {
  try {
    return window.localStorage.getItem(DEFERRED_KEY);
  } catch {
    return null;
  }
}

function writeDeferred(releaseId: string | null) {
  try {
    if (releaseId) window.localStorage.setItem(DEFERRED_KEY, releaseId);
    else window.localStorage.removeItem(DEFERRED_KEY);
  } catch {
    /* private window, blocked storage — the indicator simply reappears */
  }
}

interface LiveWork {
  resumableRuns: string[];
  interrupted: InterruptedWork[];
  blocking: string[];
}

type Phase =
  | { kind: "idle" }
  | { kind: "ready"; release: Release }
  | { kind: "confirm"; release: Release; work: LiveWork }
  | { kind: "quiescing"; message: string }
  | { kind: "verifying"; message: string }
  | { kind: "report"; report: ActivationReport };

interface ActivationBarProps {
  onOpenBuildRedline: () => void;
  onToast: (message: string) => void;
}

export function ActivationBar({ onOpenBuildRedline, onToast }: ActivationBarProps) {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [deferred, setDeferred] = useState<string | null>(() => readDeferred());
  const announced = useRef<string | null>(readDeferred());
  const toast = useRef(onToast);
  toast.current = onToast;

  // --- the two moments Redline is not fully itself ------------------------
  useEffect(() => {
    const subs = [
      // Saving and draining. The frontend's job here is to flush everything it
      // is holding and hand back the state it wants restored; the backend
      // waits, but not forever, so this must not be slow.
      listen<{ releaseId: string; deadlineMs: number }>("activation-quiesce", () => {
        setPhase({ kind: "quiescing", message: "Saving your work…" });
        // Blur whatever has focus so an in-flight editor commits its value
        // before the state below is read.
        (document.activeElement as HTMLElement | null)?.blur?.();
        // One frame, so React has flushed anything that blur triggered.
        requestAnimationFrame(() => {
          void invoke("activation_flush_complete", {
            state: collectWorkspaceState(),
          }).catch(() => {});
        });
      }),
      listen<string>("activation-handoff", () => {
        setPhase({ kind: "quiescing", message: "Applying the update…" });
      }),
      listen<string>("activation-accepted", () => {
        setPhase({ kind: "idle" });
        toast.current("This version checked out. Redline is all yours again.");
      }),
      listen<ActivationReport>("activation-report", (event) => {
        if (event.payload) setPhase({ kind: "report", report: event.payload });
      }),
    ];
    return () => {
      for (const s of subs) void s.then((off) => off());
    };
  }, []);

  // A just-installed release proves itself for a few seconds after launch.
  useEffect(() => {
    void invoke<ActivationStatus>("activation_status")
      .then((status) => {
        if (status.verifying) {
          setPhase({
            kind: "verifying",
            message:
              status.gatedMessage ||
              "Checking the version Redline just installed.",
          });
        } else if (status.lastReport && !status.lastReport.accepted) {
          setPhase({ kind: "report", report: status.lastReport });
        }
      })
      .catch(() => {});
  }, []);

  // --- readiness, announced once per candidate ----------------------------
  const checkReady = useCallback(() => {
    void invoke<Release[]>("self_develop_list")
      .then((releases) => {
        const next = announceable(releases, announced.current);
        if (!next) return;
        const release = releases.find((r) => r.releaseId === next);
        if (!release) return;
        announced.current = next;
        setPhase((current) =>
          current.kind === "idle" ? { kind: "ready", release } : current,
        );
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    checkReady();
    const sub = listen("self-develop-changed", () => checkReady());
    return () => void sub.then((off) => off());
  }, [checkReady]);

  const beginRestart = useCallback(async (release: Release) => {
    try {
      const work = await invoke<LiveWork>("activation_live_work");
      setPhase({ kind: "confirm", release, work });
    } catch {
      setPhase({ kind: "confirm", release, work: { resumableRuns: [], interrupted: [], blocking: [] } });
    }
  }, []);

  const confirmRestart = useCallback(
    async (release: Release) => {
      setPhase({ kind: "quiescing", message: "Saving your work…" });
      try {
        await invoke<string>("self_develop_restart", { releaseId: release.releaseId });
      } catch (e) {
        const refused = e as RestartRefused;
        setPhase({ kind: "ready", release });
        if (refused && typeof refused === "object" && "reason" in refused) {
          const blocking = refused.blocking?.length ? ` ${refused.blocking.join("; ")}` : "";
          toast.current(`${refused.reason}${blocking}`);
        } else {
          toast.current(`Couldn't restart: ${e}`);
        }
      }
    },
    [],
  );

  if (phase.kind === "idle") return null;
  if (phase.kind === "ready" && deferred === phase.release.releaseId) return null;

  return (
    <>
      {(phase.kind === "quiescing" || phase.kind === "verifying") && (
        // A cover, not a spinner: while this is up the backend is refusing
        // writes, and letting someone keep typing into an editor whose input
        // will not be saved is worse than saying so.
        <div
          aria-live="polite"
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 9998,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "color-mix(in srgb, var(--color-paper) 72%, transparent)",
            backdropFilter: "blur(2px)",
          }}
        >
          <div
            className="font-sans"
            style={{
              padding: "14px 20px",
              borderRadius: 10,
              fontSize: 13,
              border: "1px solid var(--color-border)",
              background: "var(--color-bg-elevated)",
              boxShadow: "0 8px 30px rgba(0,0,0,0.18)",
              maxWidth: 420,
              textAlign: "center",
              lineHeight: 1.6,
            }}
          >
            {phase.message}
          </div>
        </div>
      )}

      {(phase.kind === "ready" || phase.kind === "confirm" || phase.kind === "report") && (
        <div
          className="font-sans"
          role="status"
          style={{
            position: "fixed",
            right: 18,
            bottom: 18,
            zIndex: 9997,
            maxWidth: 400,
            padding: "12px 14px",
            borderRadius: 10,
            fontSize: 12,
            lineHeight: 1.6,
            border: "1px solid var(--color-border)",
            background: "var(--color-bg-elevated)",
            boxShadow: "0 8px 30px rgba(0,0,0,0.16)",
          }}
        >
          {phase.kind === "ready" && (
            <>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>
                {readyHeadline(phase.release)}
              </div>
              <div style={{ color: "var(--color-ink-muted)", marginBottom: 10 }}>
                Redline will be away for {formatEstimate(restartEstimateMs(phase.release))}. It
                keeps running until you say so.
              </div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                <button type="button" style={ghost} onClick={onOpenBuildRedline}>
                  Review changes
                </button>
                <button
                  type="button"
                  style={primary}
                  onClick={() => void beginRestart(phase.release)}
                >
                  Restart to apply
                </button>
                <button
                  type="button"
                  style={ghost}
                  onClick={() => {
                    writeDeferred(phase.release.releaseId);
                    setDeferred(phase.release.releaseId);
                    setPhase({ kind: "idle" });
                  }}
                >
                  Later
                </button>
              </div>
            </>
          )}

          {phase.kind === "confirm" && (
            <>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>Before Redline restarts</div>
              <WorkSummary work={phase.work} />
              <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
                <button
                  type="button"
                  style={primary}
                  onClick={() => void confirmRestart(phase.release)}
                >
                  Save and restart
                </button>
                <button
                  type="button"
                  style={ghost}
                  onClick={() => setPhase({ kind: "ready", release: phase.release })}
                >
                  Not now
                </button>
              </div>
            </>
          )}

          {phase.kind === "report" && (
            <>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>
                {phase.report.accepted
                  ? "New version applied"
                  : phase.report.rolledBack
                    ? "Put your previous version back"
                    : "A version change didn't finish"}
              </div>
              {phase.report.message && (
                <div style={{ color: "var(--color-ink-muted)" }}>{phase.report.message}</div>
              )}
              <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
                <button type="button" style={ghost} onClick={onOpenBuildRedline}>
                  Open Build Redline
                </button>
                <button type="button" style={ghost} onClick={() => setPhase({ kind: "idle" })}>
                  Dismiss
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}

/** The honest three-way split: what pauses, what will pick itself back up, and
 *  what simply ends when the process does. */
function WorkSummary({ work }: { work: LiveWork }) {
  const nothing =
    work.resumableRuns.length === 0 && work.interrupted.length === 0 && work.blocking.length === 0;
  if (nothing) {
    return (
      <div style={{ color: "var(--color-ink-muted)" }}>
        Nothing is running. Your open documents and layout come back exactly as they are.
      </div>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {work.blocking.length > 0 && (
        <div>
          <strong style={{ fontWeight: 600 }}>Still working</strong>
          <ul style={listStyle}>
            {work.blocking.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
          <div style={{ color: "var(--color-ink-muted)" }}>
            Redline waits for these before it quits.
          </div>
        </div>
      )}
      {work.resumableRuns.length > 0 && (
        <div>
          <strong style={{ fontWeight: 600 }}>Picks back up</strong>
          <ul style={listStyle}>
            {work.resumableRuns.map((run) => (
              <li key={run}>{run}</li>
            ))}
          </ul>
        </div>
      )}
      {work.interrupted.length > 0 && (
        <div>
          <strong style={{ fontWeight: 600 }}>Closes</strong>
          <ul style={listStyle}>
            {work.interrupted.map((item) => (
              <li key={`${item.kind}:${item.label}`}>
                {item.label}
                <span style={{ color: "var(--color-ink-muted)" }}> — {item.recovery}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Whatever the frontend wants handed back after the restart. Read from the
 *  DOM's own persisted state rather than reaching into every surface: this is
 *  the layer that knows where the user was, and it is deliberately small —
 *  anything bigger belongs in the database, which survives the restart anyway. */
function collectWorkspaceState(): Record<string, unknown> {
  const state: Record<string, unknown> = { savedAt: Date.now() };
  try {
    const keys = ["redline.ui.surface", "redline.ui.activeSession", "redline.ui.panes"];
    for (const key of keys) {
      const value = window.localStorage.getItem(key);
      if (value != null) state[key] = value;
    }
  } catch {
    /* storage unavailable; the database still carries the durable half */
  }
  return state;
}

const listStyle: React.CSSProperties = { margin: "2px 0 0", paddingLeft: 16 };

const primary: React.CSSProperties = {
  padding: "5px 11px",
  borderRadius: 6,
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
  border: "1px solid var(--color-info)",
  background: "var(--color-info)",
  color: "#fff",
};

const ghost: React.CSSProperties = {
  padding: "5px 11px",
  borderRadius: 6,
  fontSize: 12,
  cursor: "pointer",
  border: "1px solid var(--color-border)",
  background: "transparent",
  color: "var(--color-ink)",
};
