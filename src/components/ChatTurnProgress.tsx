// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useEffect, useState } from "react";
import { Activity as ActivityIcon, Square } from "lucide-react";
import { formatTokens, type Activity, type TurnMeter } from "../lib/turnMeter";

export interface ChatProgressStatus { label: string; at: number }

function plainActivity(label: string): string {
  return ({ "Read…": "Reading files", "Grep…": "Searching source files", "Glob…": "Finding files", "Bash…": "Running a tool", "Requesting…": "Waiting for the model" } as Record<string, string>)[label] ?? label;
}

export function elapsedLabel(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** Only public activity metadata is shown here, never model reasoning text. */
export function chatProgress(
  activity: readonly Activity[], meter: TurnMeter | null,
  status: ChatProgressStatus | null, startedAt: number, now: number, lastOutputAt = 0,
) {
  const latest = activity[activity.length - 1];
  const recentStatus = status && status.at >= startedAt && (!latest || status.at >= latest.at) ? status : null;
  const lastEventAt = Math.max(latest?.at ?? 0, recentStatus?.at ?? 0);
  const label = meter?.rateLimited ? "Rate limited — waiting for the provider"
    : lastOutputAt > lastEventAt ? "Writing the reply"
    : plainActivity(recentStatus?.label ?? latest?.label ?? "Preparing your reply");
  const lastAt = Math.max(startedAt, lastEventAt, lastOutputAt);
  return { label, elapsed: elapsedLabel(now - startedAt), quietFor: now - lastAt,
    tools: meter?.toolCalls ?? 0, output: meter?.outputTokens ?? 0,
    recent: activity.filter((entry) => entry.kind === "tool" || entry.kind === "rateLimit").slice(-4).map((entry) => ({ ...entry, label: plainActivity(entry.label) })),
  };
}

/** Stays beside the composer throughout the turn, including after early text. */
export default function ChatTurnProgress({ startedAt, activity, meter, status, onStop, textLength = 0 }: {
  startedAt: number | null; activity: readonly Activity[]; meter: TurnMeter | null;
  status: ChatProgressStatus | null; onStop: () => void;
  /** Reply length only: tracks fresh public output without retaining its text. */
  textLength?: number;
}) {
  const [mountedAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  const [lastOutputAt, setLastOutputAt] = useState(0);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  useEffect(() => { setLastOutputAt(textLength > 0 ? Date.now() : 0); }, [textLength]);
  const progress = chatProgress(activity, meter, status, startedAt ?? mountedAt, now, lastOutputAt);
  return (
    <div data-chat-progress className="shrink-0 border-t px-5 py-2.5" style={{ borderColor: "var(--color-rule)", background: "var(--color-bg-elevated)" }}>
      <div className="flex items-center gap-2" style={{ color: "var(--color-ink)", fontSize: 12 }}>
        <ActivityIcon size={14} aria-hidden style={{ color: "var(--color-info)" }} />
        <span role="status" className="min-w-0 flex-1 truncate" title={progress.label}>{progress.label}</span>
        <span aria-label="Turn elapsed" className="font-mono shrink-0" style={{ color: "var(--color-ink-muted)", fontSize: 11 }}>{progress.elapsed}</span>
        <button type="button" onClick={onStop} title="Stop the current reply (queued messages still send)" className="inline-flex items-center gap-1 rounded px-2 py-1" style={{ background: "var(--color-bg)", border: "1px solid var(--color-rule)" }}><Square size={10} aria-hidden />Stop</button>
      </div>
      <div className="flex gap-3 flex-wrap mt-1" style={{ color: "var(--color-ink-muted)", fontSize: 11 }}>
        {progress.tools > 0 && <span>{progress.tools} tool call{progress.tools === 1 ? "" : "s"}</span>}
        {progress.output > 0 && <span>{formatTokens(progress.output)} generated tokens</span>}
        {progress.quietFor >= 30_000 && <span>No new activity for {elapsedLabel(progress.quietFor)}; still waiting for the agent.</span>}
      </div>
      {progress.recent.length > 0 && <details className="mt-1" style={{ color: "var(--color-ink-muted)", fontSize: 11 }}>
        <summary className="cursor-pointer">Recent activity</summary>
        <ul className="mt-1 space-y-0.5">{progress.recent.map((entry, index) => <li key={`${entry.at}:${index}`}>{entry.label}</li>)}</ul>
      </details>}
    </div>
  );
}
