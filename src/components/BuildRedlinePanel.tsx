// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian

// Build Redline — the release panel inside Runs.
//
// The run itself is ordinary agent work and renders as ordinary agent work.
// What this adds is the other half: a compact account of the *release* those
// agents are producing, and the one decision only the user can make.
//
// The panel's job is to be truthful about three things the surrounding UI
// would otherwise smooth over: which of the user's own uncommitted changes
// came along inside the candidate, what was actually verified (as opposed to
// merely built), and what a restart will cost and interrupt.

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  canOfferRestart,
  formatBytes,
  formatEstimate,
  includedChanges,
  isWorking,
  meetsDowntimeTarget,
  requiresMaintenance,
  restartEstimateMs,
  STATUS_LABEL,
  validationRows,
  type Availability,
  type PatchView,
  type Release,
  type RestartPreflight,
  type RestartRefused,
} from "../lib/selfDevelop";
import { useReleases } from "../hooks/useSelfDevelop";

const muted = { color: "var(--color-ink-muted)" } as const;

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", gap: 10, alignItems: "baseline", padding: "3px 0" }}>
      <div style={{ ...muted, fontSize: 11, minWidth: 148, flexShrink: 0 }}>{label}</div>
      <div style={{ fontSize: 12, minWidth: 0, flex: 1 }}>{children}</div>
    </div>
  );
}

function Pill({ tone, children }: { tone: "ok" | "warn" | "bad" | "idle"; children: React.ReactNode }) {
  const color =
    tone === "ok" ? "var(--color-success)"
    : tone === "warn" ? "var(--color-warning)"
    : tone === "bad" ? "var(--color-danger)"
    : "var(--color-ink-muted)";
  return (
    <span
      className="font-sans"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        padding: "1px 7px",
        borderRadius: 999,
        fontSize: 11,
        color,
        border: `1px solid color-mix(in srgb, ${color} 40%, transparent)`,
        background: `color-mix(in srgb, ${color} 10%, transparent)`,
      }}
    >
      {children}
    </span>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="font-sans"
      style={{
        ...muted,
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: "0.12em",
        textTransform: "uppercase",
        margin: "14px 0 6px",
      }}
    >
      {children}
    </div>
  );
}

/** The list of files a reviewer can expand. Collapsed by default: the point is
 *  that the count is visible, not that every path is. */
function FileList({ title, files }: { title: string; files: string[] }) {
  const [open, setOpen] = useState(false);
  if (files.length === 0) return null;
  return (
    <div>
      <button
        type="button"
        className="font-sans"
        onClick={() => setOpen((o) => !o)}
        style={{
          background: "none",
          border: "none",
          padding: 0,
          cursor: "pointer",
          fontSize: 12,
          color: "var(--color-ink)",
          textAlign: "left",
        }}
      >
        {open ? "▾" : "▸"} {files.length} {title}
      </button>
      {open && (
        <ul style={{ margin: "4px 0 0 14px", padding: 0, listStyle: "none" }}>
          {files.map((file) => (
            <li key={file} style={{ ...muted, fontSize: 11, fontFamily: "var(--font-mono)" }}>
              {file}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface BuildRedlinePanelProps {
  active: boolean;
  /** The plan the user is looking at. Capturing a candidate decomposes it into
   *  agent tasks rooted in the candidate workspace — the one substitution that
   *  turns the ordinary run machinery into self-development. */
  planSessionId?: string | null;
  planTitle?: string | null;
  /** Ask the surrounding app to show a message. */
  onToast: (message: string) => void;
}

export function BuildRedlinePanel({
  active,
  planSessionId = null,
  planTitle = null,
  onToast,
}: BuildRedlinePanelProps) {
  const { releases, refresh, progress } = useReleases(active);
  const [availability, setAvailability] = useState<Availability | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [preflight, setPreflight] = useState<RestartPreflight | null>(null);
  const [patch, setPatch] = useState<PatchView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!active) return;
    void invoke<Availability>("self_develop_available").then(setAvailability).catch(() => {});
  }, [active]);

  const release =
    releases.find((r) => r.releaseId === selected) ??
    releases.find((r) => canOfferRestart(r)) ??
    releases[0] ??
    null;

  useEffect(() => {
    setPreflight(null);
    setPatch(null);
  }, [release?.releaseId]);

  const start = useCallback(async () => {
    setBusy("start");
    try {
      const created = await invoke<Release>("self_develop_start", {
        planSessionId,
        runId: null,
      });
      setSelected(created.releaseId);
      onToast(
        planSessionId
          ? "Candidate captured and the plan decomposed against it. Your own checkout is untouched."
          : "Candidate workspace captured. Your own checkout is untouched — agents work in the copy.",
      );
      refresh();
    } catch (e) {
      onToast(`Could not start: ${e}`);
    } finally {
      setBusy(null);
    }
  }, [onToast, refresh, planSessionId]);

  const prepare = useCallback(
    async (releaseId: string) => {
      setBusy("prepare");
      onToast("Preparing the release. Keep using Redline — this runs in the background.");
      try {
        await invoke<Release>("self_develop_prepare", { releaseId });
        onToast("A replacement Redline is ready. Restart when you want it.");
      } catch (e) {
        onToast(`Preparation stopped: ${e}`);
      } finally {
        setBusy(null);
        refresh();
      }
    },
    [onToast, refresh],
  );

  const check = useCallback(
    async (releaseId: string) => {
      setBusy("preflight");
      try {
        setPreflight(await invoke<RestartPreflight>("self_develop_preflight", { releaseId }));
      } catch (e) {
        onToast(`Could not check: ${e}`);
      } finally {
        setBusy(null);
      }
    },
    [onToast],
  );

  const review = useCallback(
    async (releaseId: string) => {
      setBusy("patch");
      try {
        setPatch(await invoke<PatchView>("self_develop_patch", { releaseId }));
      } catch (e) {
        onToast(`Could not read the changes: ${e}`);
      } finally {
        setBusy(null);
      }
    },
    [onToast],
  );

  const restart = useCallback(
    async (releaseId: string) => {
      setBusy("restart");
      try {
        await invoke<string>("self_develop_restart", { releaseId });
        // If this returns, the handoff succeeded and the window is about to go.
      } catch (e) {
        const refused = e as RestartRefused;
        if (refused && typeof refused === "object" && "reason" in refused) {
          const blocking = refused.blocking?.length
            ? ` (${refused.blocking.join("; ")})`
            : "";
          onToast(`${refused.reason}${blocking}`);
        } else {
          onToast(`Could not restart: ${e}`);
        }
        setBusy(null);
        refresh();
      }
    },
    [onToast, refresh],
  );

  if (availability && !availability.available) {
    return (
      <div style={{ maxWidth: 620 }}>
        <SectionTitle>Build Redline</SectionTitle>
        <p style={{ fontSize: 12, lineHeight: 1.6 }}>
          Redline can turn an approved plan into background agent work, build a complete
          replacement of itself, and offer to restart into it. It can't here yet:
        </p>
        <ul style={{ fontSize: 12, lineHeight: 1.6, paddingLeft: 18 }}>
          {availability.blockers.map((blocker) => (
            <li key={blocker} style={muted}>
              {blocker}
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <button
          type="button"
          className="font-sans"
          disabled={busy !== null}
          onClick={() => void start()}
          style={{
            padding: "5px 11px",
            borderRadius: 6,
            fontSize: 12,
            cursor: busy ? "default" : "pointer",
            border: "1px solid var(--color-border)",
            background: "var(--color-bg-elevated)",
            color: "var(--color-ink)",
          }}
        >
          {planSessionId ? "Build this plan into Redline" : "Capture a candidate"}
        </button>
        {planSessionId && planTitle && (
          <span style={{ ...muted, fontSize: 11 }}>from “{planTitle}”</span>
        )}
        {availability?.installedRelease && (
          <span style={{ ...muted, fontSize: 11 }}>
            running {availability.installedRelease}
          </span>
        )}
      </div>

      {releases.length > 1 && (
        <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginTop: 8 }}>
          {releases.map((r) => (
            <button
              key={r.releaseId}
              type="button"
              className="font-sans"
              onClick={() => setSelected(r.releaseId)}
              style={{
                padding: "2px 8px",
                borderRadius: 999,
                fontSize: 11,
                cursor: "pointer",
                border: "1px solid var(--color-border)",
                background:
                  r.releaseId === release?.releaseId
                    ? "var(--color-bg-elevated)"
                    : "transparent",
                color: "var(--color-ink)",
              }}
            >
              {STATUS_LABEL[r.status]} · {r.releaseId.slice(4, 18)}
            </button>
          ))}
        </div>
      )}

      {release == null ? (
        <p style={{ ...muted, fontSize: 12, marginTop: 12, maxWidth: 560, lineHeight: 1.6 }}>
          No candidate yet. Capturing one copies your checkout — including whatever is
          uncommitted in it right now — into a private workspace that agents build in. You
          keep using this Redline the whole time.
        </p>
      ) : (
        <ReleaseDetail
          release={release}
          progress={progress[release.releaseId] ?? null}
          preflight={preflight}
          patch={patch}
          busy={busy}
          onPrepare={() => void prepare(release.releaseId)}
          onCheck={() => void check(release.releaseId)}
          onReview={() => void review(release.releaseId)}
          onRestart={() => void restart(release.releaseId)}
        />
      )}
    </div>
  );
}

function ReleaseDetail({
  release,
  progress,
  preflight,
  patch,
  busy,
  onPrepare,
  onCheck,
  onReview,
  onRestart,
}: {
  release: Release;
  progress: { step: string; index: number; total: number; detail: string } | null;
  preflight: RestartPreflight | null;
  patch: PatchView | null;
  busy: string | null;
  onPrepare: () => void;
  onCheck: () => void;
  onReview: () => void;
  onRestart: () => void;
}) {
  const changes = includedChanges(release);
  const rows = validationRows(release);
  const estimate = restartEstimateMs(release);
  const meets = meetsDowntimeTarget(release);
  const offerable = canOfferRestart(release);
  const maintenance = requiresMaintenance(release);

  return (
    <div style={{ marginTop: 10, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Pill
          tone={
            release.status === "active" ? "ok"
            : release.status === "failed" || release.status === "rolledBack" ? "bad"
            : offerable ? "ok"
            : isWorking(release.status) ? "warn"
            : "idle"
          }
        >
          {STATUS_LABEL[release.status]}
        </Pill>
        {release.step && <span style={{ ...muted, fontSize: 11 }}>{release.step}</span>}
      </div>

      {progress && isWorking(release.status) && (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontSize: 12 }}>
            {progress.step}{" "}
            <span style={muted}>
              ({progress.index + 1} of {progress.total})
            </span>
          </div>
          {progress.detail && (
            <div style={{ ...muted, fontSize: 11, fontFamily: "var(--font-mono)" }}>
              {progress.detail}
            </div>
          )}
        </div>
      )}

      {release.failure && (
        <p
          style={{
            marginTop: 8,
            fontSize: 12,
            lineHeight: 1.6,
            color: "var(--color-danger)",
            whiteSpace: "pre-wrap",
          }}
        >
          {release.failure}
        </p>
      )}

      <SectionTitle>What's in it</SectionTitle>
      <Row label="From">
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>
          {changes.baseRevision || "—"}
        </span>{" "}
        <span style={muted}>in {release.repository}</span>
      </Row>
      {/* The reviewer's own in-progress work, which came along with the plan's.
          Nobody expects this, and everybody needs to know it. */}
      {(changes.carriedModifications.length > 0 || changes.carriedUntracked.length > 0) && (
        <Row label="Carried along">
          <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            <FileList title="files you had already modified" files={changes.carriedModifications} />
            <FileList title="untracked files of yours" files={changes.carriedUntracked} />
          </div>
        </Row>
      )}

      <SectionTitle>What was verified</SectionTitle>
      {rows.length === 0 ? (
        <div style={{ ...muted, fontSize: 12 }}>Nothing yet.</div>
      ) : (
        rows.map((row) => (
          <Row key={row.name} label={row.ok ? "✓" : "✗"}>
            <span style={{ color: row.ok ? "var(--color-ink)" : "var(--color-danger)" }}>
              {row.name}
            </span>{" "}
            <span style={muted}>{row.detail}</span>
          </Row>
        ))
      )}

      {release.status === "preparing" && (
        <div style={{ marginTop: 12 }}>
          <button
            type="button"
            className="font-sans"
            disabled={busy !== null}
            onClick={onPrepare}
            style={primaryButton(busy === null)}
          >
            Build and verify
          </button>
          <p style={{ ...muted, fontSize: 11, marginTop: 6, maxWidth: 520, lineHeight: 1.6 }}>
            Dependencies from the lockfile, the checks, the build, the signature, and then the
            candidate is actually started against a copy of your data. All of it confined, none
            of it able to touch the Redline you're using.
          </p>
        </div>
      )}

      {(offerable || maintenance) && (
        <>
          <SectionTitle>Restarting</SectionTitle>
          <Row label="Time without Redline">
            {formatEstimate(estimate)}
            {meets === false && (
              <>
                {" "}
                <Pill tone="warn">over the 10-second target</Pill>
              </>
            )}
          </Row>
          {release.manifest && (
            <Row label="Your data">
              <span style={maintenance ? { color: "var(--color-warning)" } : undefined}>
                {release.manifest.data.notes}
              </span>
            </Row>
          )}
          {preflight && !preflight.ok && (
            <Row label="In the way">
              <ul style={{ margin: 0, paddingLeft: 16 }}>
                {preflight.blockers.map((b) => (
                  <li key={b} style={{ color: "var(--color-danger)", fontSize: 12 }}>
                    {b}
                  </li>
                ))}
              </ul>
            </Row>
          )}
          {preflight?.ok && (
            <Row label="Space">
              {formatBytes(preflight.freeBytes)} free, {formatBytes(preflight.requiredBytes)}{" "}
              needed
            </Row>
          )}
          <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
            <button
              type="button"
              className="font-sans"
              disabled={busy !== null}
              onClick={onReview}
              style={secondaryButton(busy === null)}
            >
              Review changes
            </button>
            <button
              type="button"
              className="font-sans"
              disabled={busy !== null}
              onClick={onCheck}
              style={secondaryButton(busy === null)}
            >
              Check again
            </button>
            {offerable && (
              <button
                type="button"
                className="font-sans"
                disabled={busy !== null}
                onClick={onRestart}
                style={primaryButton(busy === null)}
              >
                Restart to apply
              </button>
            )}
          </div>
          {maintenance && (
            <p
              style={{
                marginTop: 8,
                fontSize: 12,
                lineHeight: 1.6,
                color: "var(--color-warning)",
                maxWidth: 560,
              }}
            >
              This release isn't offered as a restart. It changes stored data in a way there is
              no tested way back from, so it needs to be installed as maintenance instead.
            </p>
          )}
        </>
      )}

      {patch && (
        <>
          <SectionTitle>The changes, as a patch</SectionTitle>
          <Row label="Applies to your checkout">
            {patch.appliesCleanly ? (
              <Pill tone="ok">cleanly</Pill>
            ) : (
              <Pill tone="warn">conflicts — your checkout has moved on</Pill>
            )}
          </Row>
          <FileList title="files changed" files={patch.changedFiles} />
          <pre
            style={{
              marginTop: 8,
              maxHeight: 320,
              overflow: "auto",
              fontSize: 11,
              lineHeight: 1.5,
              fontFamily: "var(--font-mono)",
              background: "var(--color-paper)",
              border: "1px solid var(--color-border)",
              borderRadius: 6,
              padding: 10,
              whiteSpace: "pre",
            }}
          >
            {patch.patch || "(no changes yet)"}
          </pre>
        </>
      )}
    </div>
  );
}

function primaryButton(enabled: boolean): React.CSSProperties {
  return {
    padding: "6px 13px",
    borderRadius: 6,
    fontSize: 12,
    fontWeight: 600,
    cursor: enabled ? "pointer" : "default",
    opacity: enabled ? 1 : 0.6,
    border: "1px solid var(--color-info)",
    background: "var(--color-info)",
    color: "#fff",
  };
}

function secondaryButton(enabled: boolean): React.CSSProperties {
  return {
    padding: "6px 13px",
    borderRadius: 6,
    fontSize: 12,
    cursor: enabled ? "pointer" : "default",
    opacity: enabled ? 1 : 0.6,
    border: "1px solid var(--color-border)",
    background: "var(--color-bg-elevated)",
    color: "var(--color-ink)",
  };
}
