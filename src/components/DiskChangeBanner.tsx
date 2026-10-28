// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// The file pane's "changed on disk" banner (W4): the file moved under an
// unsaved buffer — an agent wrote it, a terminal did — and the user picks:
// Compare (what is on disk against what you have), Keep editing (your
// buffer stays; Save overwrites), Reload (take the disk's), Overwrite (save
// yours now). Shared by the code editor and the markdown editor.

import { memo, useMemo } from "react";
import { TriangleAlert } from "lucide-react";

import { lineDiff } from "../lib/lineDiff";

export interface DiskChange {
  /** What is on disk now. */
  content: string;
  /** When the change was seen. */
  at: number;
}

function ago(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  return `${Math.round(s / 60)}m ago`;
}

const btn: React.CSSProperties = {
  height: "24px",
  padding: "0 9px",
  borderRadius: "6px",
  border: "1px solid var(--color-rule)",
  background: "var(--color-bg-elevated)",
  color: "var(--color-ink)",
  fontSize: "12px",
  cursor: "pointer",
};

export interface DiskChangeBannerProps {
  change: DiskChange;
  comparing: boolean;
  onCompare: () => void;
  onKeep: () => void;
  onReload: () => void;
  onOverwrite: () => void;
  busy?: boolean;
}

function DiskChangeBannerBase({ change, comparing, onCompare, onKeep, onReload, onOverwrite, busy }: DiskChangeBannerProps) {
  return (
    <div
      role="alert"
      className="flex items-center gap-2 px-4 shrink-0"
      style={{
        minHeight: "34px",
        flexWrap: "wrap",
        fontSize: "12.5px",
        color: "var(--color-ink)",
        background: "color-mix(in srgb, var(--color-warning) 12%, transparent)",
        borderBottom: "1px solid var(--color-rule)",
      }}
    >
      <TriangleAlert size={14} aria-hidden style={{ color: "var(--color-warning)", flexShrink: 0 }} />
      <span style={{ flex: 1, minWidth: "160px" }}>
        <b style={{ fontWeight: 600 }}>Changed on disk</b> {ago(change.at)} · you have unsaved edits
      </span>
      <button type="button" style={{ ...btn, background: comparing ? "var(--color-anchor-bg)" : btn.background }} onClick={onCompare} aria-pressed={comparing}>
        Compare
      </button>
      <button type="button" style={btn} onClick={onKeep} title="Keep your buffer — Save overwrites the disk version">
        Keep editing
      </button>
      <button type="button" style={btn} onClick={onReload} title="Drop your edits and take the disk's version">
        Reload
      </button>
      <button type="button" style={btn} onClick={onOverwrite} disabled={busy} title="Save your buffer over the disk's version now">
        Overwrite
      </button>
    </div>
  );
}

export const DiskChangeBanner = memo(DiskChangeBannerBase);

/** The disk's version against the buffer: changed lines with two lines of
 *  context, the rest folded. */
function DiskCompareBase({ disk, buffer }: { disk: string; buffer: string }) {
  const rows = useMemo(() => {
    const ops = lineDiff(disk, buffer);
    const keep = ops.map((o, i) => o.kind !== "same" || ops.slice(Math.max(0, i - 2), i + 3).some((n) => n.kind !== "same"));
    const out: ({ fold: number } | (typeof ops)[number])[] = [];
    let folded = 0;
    ops.forEach((o, i) => {
      if (keep[i]) {
        if (folded) out.push({ fold: folded });
        folded = 0;
        out.push(o);
      } else folded++;
    });
    if (folded) out.push({ fold: folded });
    return out;
  }, [disk, buffer]);
  return (
    <div
      aria-label="Disk against your edits"
      className="shrink-0 rl-thin-scroll-y"
      style={{ maxHeight: "40%", overflow: "auto", borderBottom: "1px solid var(--color-rule)", background: "var(--color-paper)", font: "12px/18px var(--font-mono)" }}
    >
      <div className="px-4 py-1" style={{ font: "11.5px var(--font-sans)", color: "var(--color-ink-muted)" }}>
        − on disk · + your edits
      </div>
      {rows.map((r, i) =>
        "fold" in r ? (
          <div key={i} className="px-4" style={{ color: "var(--color-ink-muted)" }}>
            ⋯ {r.fold} unchanged
          </div>
        ) : (
          <div
            key={i}
            className="px-4"
            style={{
              whiteSpace: "pre",
              background: r.kind === "add" ? "color-mix(in srgb, var(--color-success) 14%, transparent)" : r.kind === "del" ? "color-mix(in srgb, var(--color-warning) 12%, transparent)" : undefined,
              color: r.kind === "del" ? "var(--color-ink-muted)" : "var(--color-ink)",
            }}
          >
            {r.kind === "add" ? "+ " : r.kind === "del" ? "− " : "  "}
            {r.text}
          </div>
        ),
      )}
    </div>
  );
}

export const DiskCompare = memo(DiskCompareBase);
