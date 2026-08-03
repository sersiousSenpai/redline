// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// The Localhost surface: a grid of cards, one per dev server, answering "what
// do I have running, out of which repo?" at a glance — and letting you bring a
// dead one back without hunting for the command.
//
// Deliberately a dumb pane. Every fact arrives as a prop from useDevServers,
// every verb leaves as a callback, so the whole surface is a pure function of
// one scan. The card recipe is NudgeCard's (rule border, elevated background,
// ink / ink-muted text, no Tailwind color classes) so it inherits every theme
// including the cycling one.

import { useCallback, useMemo, useRef, useState } from "react";
import { Globe, Play, RotateCw, Square } from "lucide-react";
import type { DevServerScan, OtherListener, RecentServer, RunningServer } from "../types";
import { thumbKey } from "../lib/thumbs";
import {
  useThumbCapture,
  type ThumbCaptureTarget,
} from "../hooks/useThumbCapture";
import { ProjectThumb } from "./ProjectThumb";

/** Shorten a path from the MIDDLE, keeping the leading anchor and the trailing
 *  segments. A dev server's identity lives at both ends — `~/code/…/web` says
 *  far more than `~/code/clients/acme/2026/…`. Exported for tests. */
export function middleTruncate(path: string, max = 42): string {
  if (path.length <= max) return path;
  // Keep slightly more of the tail: the repo/leaf name is the identifying part.
  const head = Math.max(4, Math.floor((max - 1) * 0.4));
  const tail = Math.max(4, max - 1 - head);
  return `${path.slice(0, head)}…${path.slice(path.length - tail)}`;
}

/** "last run 20m ago", in the coarse units a glance actually wants. Exported
 *  for tests; `now` is injected so the test isn't clock-dependent. */
export function formatLastRun(lastSeenAt: number, now = Date.now()): string {
  const secs = Math.max(0, Math.round((now - lastSeenAt) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  return months < 12 ? `${months}mo ago` : `${Math.round(months / 12)}y ago`;
}

const cardStyle: React.CSSProperties = {
  border: "1px solid var(--color-rule)",
  background: "var(--color-bg-elevated)",
  borderRadius: "6px",
  overflow: "hidden",
  display: "flex",
  flexDirection: "column",
};

const btnStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "5px",
  fontSize: "11px",
  padding: "3px 8px",
  borderRadius: "4px",
  border: "1px solid var(--color-rule)",
  background: "transparent",
  color: "var(--color-ink)",
  cursor: "pointer",
};

/** The Stop button. A dev server is a reversible thing to kill — you just start
 *  it again — so a modal would be theatre. It flips to "Really stop?" in place
 *  and reverts after three seconds if you walk away. */
function StopButton({ onStop }: { onStop: () => void }) {
  const [armed, setArmed] = useState(false);
  return (
    <button
      type="button"
      style={{
        ...btnStyle,
        color: armed ? "var(--color-danger, #d33)" : "var(--color-ink)",
        borderColor: armed ? "var(--color-danger, #d33)" : "var(--color-rule)",
      }}
      title={armed ? "Send SIGTERM to this process" : "Stop this dev server"}
      onClick={() => {
        if (!armed) {
          setArmed(true);
          window.setTimeout(() => setArmed(false), 3000);
          return;
        }
        setArmed(false);
        onStop();
      }}
    >
      <Square size={12} strokeWidth={2} />
      {armed ? "Really stop?" : "Stop"}
    </button>
  );
}

function PortLine({
  url,
  port,
  extra,
  onOpenUrl,
}: {
  url: string;
  port: number;
  extra: number[];
  onOpenUrl: (url: string) => void;
}) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: "6px" }}>
      <button
        type="button"
        onClick={() => onOpenUrl(url)}
        title={url}
        style={{
          fontSize: "12px",
          fontFamily: "var(--font-mono, ui-monospace, monospace)",
          color: "var(--color-info)",
          background: "transparent",
          border: "none",
          padding: 0,
          cursor: "pointer",
          textDecoration: "underline",
        }}
      >
        localhost:{port}
      </button>
      {extra.length > 0 && (
        <span
          style={{ fontSize: "10.5px", color: "var(--color-ink-muted)" }}
          title={extra.map((p) => `:${p}`).join(" ")}
        >
          +{extra.length} more
        </span>
      )}
    </div>
  );
}

function CardBody({
  stack,
  args,
  projectPath,
  children,
}: {
  stack: string;
  args?: string;
  projectPath: string;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        padding: "9px 10px 10px",
        display: "flex",
        flexDirection: "column",
        gap: "5px",
        minWidth: 0,
      }}
    >
      <div
        style={{
          fontSize: "12.5px",
          fontWeight: 600,
          color: "var(--color-ink)",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
        title={args || stack}
      >
        {stack}
      </div>
      <div
        style={{
          fontSize: "11px",
          color: "var(--color-ink-muted)",
          fontFamily: "var(--font-mono, ui-monospace, monospace)",
        }}
        title={projectPath}
      >
        {middleTruncate(projectPath)}
      </div>
      {children}
    </div>
  );
}

export interface ServersPaneProps {
  scan: DevServerScan | null;
  error: string | null;
  /** Whether this surface is the one on screen. Gates the capture queue: a
   *  webview must never park over a pane the user isn't looking at. */
  active: boolean;
  onRefresh: () => void;
  onStop: (pid: number, expectedComm: string, projectPath: string | null) => void;
  onRun: (projectPath: string, runCommand: string) => void;
  onOpenUrl: (url: string) => void;
  /** Persist a fresh capture against its remembered row, so the picture
   *  outlives the process it depicts. Reported by card identity, not by the
   *  hashed thumbnail key — the hash is one-way, and `(projectPath, port)` is
   *  what the row is keyed on. */
  onThumbCaptured: (projectPath: string, port: number, path: string) => void;
}

export function ServersPane({
  scan,
  error,
  active,
  onRefresh,
  onStop,
  onRun,
  onOpenUrl,
  onThumbCaptured,
}: ServersPaneProps) {
  // Memoized on the scan itself, not spelled inline: `scan?.running ?? []`
  // mints a fresh array on every render while the scan is null, which would
  // change `targets`' identity every render and re-enter the capture queue
  // continuously.
  const running = useMemo(() => scan?.running ?? [], [scan]);
  const recent = useMemo(() => scan?.recent ?? [], [scan]);
  const others = scan?.others ?? [];
  const empty = running.length === 0 && recent.length === 0;

  // Every card that could carry a thumbnail. Running ones are capture targets;
  // dead ones are listed too so their stored picture is kept (and not pruned)
  // even though they'll never be captured.
  const targets = useMemo<ThumbCaptureTarget[]>(
    () => [
      ...running.map((s) => ({
        key: thumbKey(s.projectPath, s.port),
        url: s.url,
        live: true,
      })),
      ...recent.map((s) => ({
        key: thumbKey(s.projectPath, s.port),
        url: s.url,
        live: false,
      })),
    ],
    [running, recent],
  );
  // The capture layer only ever knows a card by its hashed key, so keep the
  // reverse map here, where the cards are.
  const identityByKey = useMemo(() => {
    const m = new Map<string, { projectPath: string; port: number }>();
    for (const s of [...running, ...recent]) {
      m.set(thumbKey(s.projectPath, s.port), {
        projectPath: s.projectPath,
        port: s.port,
      });
    }
    return m;
  }, [running, recent]);
  const identityByKeyRef = useRef(identityByKey);
  identityByKeyRef.current = identityByKey;

  const handleCaptured = useCallback((key: string, path: string) => {
    const id = identityByKeyRef.current.get(key);
    if (id) onThumbCapturedRef.current(id.projectPath, id.port, path);
  }, []);
  const onThumbCapturedRef = useRef(onThumbCaptured);
  onThumbCapturedRef.current = onThumbCaptured;

  const capture = useThumbCapture(targets, active, handleCaptured);

  const thumb = (
    s: {
      projectPath: string;
      port: number;
      stack: string;
      projectName: string;
    },
    live: boolean,
  ) => {
    const key = thumbKey(s.projectPath, s.port);
    return (
      <ProjectThumb
        thumbKey={key}
        stack={s.stack}
        projectName={s.projectName}
        dataUrl={capture.thumbs.get(key) ?? null}
        capturing={capture.capturingKey === key}
        live={live}
        canRefresh={live && !capture.unsupported}
        registerRect={capture.registerRect}
        onRefresh={capture.refresh}
      />
    );
  };

  return (
    <div
      className="rl-servers-pane"
      style={{
        height: "100%",
        overflowY: "auto",
        padding: "14px 16px 24px",
        background: "var(--color-bg)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: "12px",
        }}
      >
        <div style={{ fontSize: "13px", fontWeight: 600, color: "var(--color-ink)" }}>
          Localhost
        </div>
        <button type="button" style={btnStyle} onClick={onRefresh} title="Re-scan now">
          <RotateCw size={12} strokeWidth={2} />
          Refresh
        </button>
      </div>

      {error && (
        <div
          style={{
            fontSize: "11.5px",
            color: "var(--color-ink-muted)",
            border: "1px solid var(--color-rule)",
            borderRadius: "4px",
            padding: "6px 8px",
            marginBottom: "12px",
          }}
        >
          {error}
        </div>
      )}

      {running.length > 0 && (
        <>
          <SectionTitle>Running</SectionTitle>
          <div className="rl-server-grid">
            {running.map((s: RunningServer) => (
              <div key={`${s.projectPath}:${s.port}`} style={cardStyle}>
                {thumb(s, true)}
                <CardBody stack={s.stack} args={s.args} projectPath={s.projectPath}>
                  <PortLine
                    url={s.url}
                    port={s.port}
                    extra={s.extraPorts}
                    onOpenUrl={onOpenUrl}
                  />
                  <div style={{ display: "flex", gap: "6px", marginTop: "3px" }}>
                    <button
                      type="button"
                      style={btnStyle}
                      onClick={() => onOpenUrl(s.url)}
                      title={`Open ${s.url} in the browser`}
                    >
                      <Globe size={12} strokeWidth={2} />
                      Open
                    </button>
                    <StopButton
                      onStop={() => onStop(s.pid, s.comm, s.projectPath)}
                    />
                  </div>
                </CardBody>
              </div>
            ))}
          </div>
        </>
      )}

      {recent.length > 0 && (
        <>
          <SectionTitle>Recently run</SectionTitle>
          <div className="rl-server-grid">
            {recent.map((s: RecentServer) => (
              <div key={s.id} style={cardStyle}>
                {thumb(s, false)}
                <CardBody stack={s.stack} projectPath={s.projectPath}>
                  <div
                    style={{ fontSize: "11px", color: "var(--color-ink-muted)" }}
                  >
                    last run {formatLastRun(s.lastSeenAt)} · :{s.port}
                  </div>
                  {s.portBusy && (
                    <div
                      style={{ fontSize: "10.5px", color: "var(--color-ink-muted)" }}
                      title="Another process is listening on this port — the server will pick a different one."
                    >
                      port in use
                    </div>
                  )}
                  <div style={{ display: "flex", gap: "6px", marginTop: "3px" }}>
                    <button
                      type="button"
                      style={btnStyle}
                      onClick={() => onRun(s.projectPath, s.runCommand)}
                      title={s.runCommand || "Start this server"}
                      disabled={!s.runCommand}
                    >
                      <Play size={12} strokeWidth={2} />
                      Run
                    </button>
                  </div>
                </CardBody>
              </div>
            ))}
          </div>
        </>
      )}

      {empty && !error && (
        <div style={{ fontSize: "12px", color: "var(--color-ink-muted)", padding: "24px 0" }}>
          {scan
            ? "No dev servers running, and none remembered yet. Start one from a terminal and it shows up here."
            : "Looking for dev servers…"}
        </div>
      )}

      {others.length > 0 && (
        <details style={{ marginTop: "18px" }}>
          <summary
            style={{
              fontSize: "11px",
              color: "var(--color-ink-muted)",
              cursor: "pointer",
            }}
          >
            Other listeners ({others.length})
          </summary>
          <div
            style={{
              marginTop: "6px",
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
              gap: "2px 14px",
            }}
          >
            {others.map((o: OtherListener) => (
              <div
                key={`${o.pid}:${o.port}`}
                style={{
                  fontSize: "11px",
                  color: "var(--color-ink-muted)",
                  fontFamily: "var(--font-mono, ui-monospace, monospace)",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
                title={`pid ${o.pid}`}
              >
                {o.comm} — :{o.port}
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: "11px",
        fontWeight: 600,
        textTransform: "uppercase",
        letterSpacing: "0.04em",
        color: "var(--color-ink-muted)",
        margin: "14px 0 8px",
      }}
    >
      {children}
    </div>
  );
}
