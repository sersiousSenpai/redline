// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useMemo, useRef } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Folder } from "lucide-react";
import { Panel, useClickPopover } from "./popover";

/** Panel width, px. Exported for the same reason `PANEL_WIDTH` is: the
 *  placement clamp and the rendered panel must agree, or the clamp keeps a
 *  narrower box on screen than the one that paints. */
export const PICKER_WIDTH = 280;

export interface ProjectOption {
  /** Absolute directory path. */
  path: string;
  /** Display label (basename / project name). */
  name: string;
  /** Where it came from, for the muted source hint. `workspace` = registered
   *  in ~/.redline/workspace.json by project_create, before any session. */
  source: "session" | "folder" | "workspace";
}

interface ProjectPickerProps {
  options: ProjectOption[];
  /** Selected project dir, or null for "Home (~)". */
  value: string | null;
  onChange: (path: string | null) => void;
  /** Re-focus the editor after the native folder dialog steals focus. */
  onAfterPick?: () => void;
  /** When given, the menu offers `＋ New project…` beside `Browse…`. On a
   *  genuine first run `options` is empty — every entry is derived from
   *  existing sessions and open folders — so without this the only way to
   *  build is in $HOME or in someone else's directory. The caller owns the
   *  naming step; this row only asks for it. */
  onNewProject?: () => void;
  /** Render the trigger as a front-door glass pill (`.rl-fd-tool`) instead of
   *  the drafter's bordered control. Inline styles would beat the class, so
   *  this is a swap rather than an override. */
  chromeless?: boolean;
}

function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return trimmed.slice(idx + 1) || path;
}

// A small dropdown of candidate project directories: review sessions and open
// folder workspaces (deduped by path), a Home fallback, plus a native
// "Browse…" folder picker.
//
// The menu rides the shared popover primitive rather than its own
// `position: absolute; bottom: calc(100% + 4px)` block. That block was two
// separate bugs. It was *always* upward, with no flip and no viewport
// awareness. And it was not portalled, so it was clipped by whatever ancestor
// happened to clip — `.rl-doorframe { overflow: hidden }` on the Front Door,
// and worst, the Send-to-Claude-Code dialog card, which is itself
// `maxHeight: 90vh; overflowY: auto`. `overflow-y: auto` computes `overflow-x`
// to `auto` as well, so that card clips BOTH axes: the menu grew up through
// the card's own title and out of the clip, and scrolling the card moved
// trigger and menu together. The rows were permanently unreachable.
//
// `useClickPopover` fixes all three call sites at once: it portals to
// `document.body` (escaping every ancestor clip), flips to whichever side has
// room, caps the list at the room actually there, and registers
// `useMenuOverlay` internally so the native browser webview hides while the
// menu is open (same as the header dropdowns).
export function ProjectPicker({
  options,
  value,
  onChange,
  onAfterPick,
  onNewProject,
  chromeless = false,
}: ProjectPickerProps) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const pop = useClickPopover(triggerRef, "left", "below", PICKER_WIDTH);

  // Dedupe by normalized path; sessions win over folders on a tie.
  const merged = useMemo(() => {
    const seen = new Map<string, ProjectOption>();
    for (const opt of options) {
      const key = opt.path.replace(/\/+$/, "") || "/";
      if (!seen.has(key)) seen.set(key, opt);
    }
    return [...seen.values()];
  }, [options]);

  // No local mousedown listener: `useClickPopover` runs `useDismiss`, which
  // covers outside-mousedown AND Escape (which this never had).

  const label =
    value === null ? "Home (~)" : basename(value);

  const browse = async () => {
    pop.close();
    try {
      const picked = await openDialog({ directory: true, multiple: false });
      if (typeof picked === "string") onChange(picked);
    } catch {
      /* user cancelled or dialog unavailable */
    } finally {
      onAfterPick?.();
    }
  };

  return (
    <div data-no-drag="true">
      <button
        type="button"
        ref={triggerRef}
        onClick={pop.toggle}
        aria-haspopup="menu"
        aria-expanded={pop.open}
        title="Choose the project to launch the plan in"
        className={
          chromeless
            ? "rl-fd-tool is-wide"
            : "flex items-center gap-1 rounded-sm px-2"
        }
        style={
          chromeless
            ? { maxWidth: "220px" }
            : {
                height: "30px",
                maxWidth: "220px",
                fontSize: "12px",
                border: "1px solid var(--color-rule)",
                background: "var(--color-bg-elevated)",
                color: "var(--color-ink)",
                cursor: "pointer",
              }
        }
      >
        {chromeless ? (
          <Folder size={13} style={{ opacity: 0.65, flexShrink: 0 }} />
        ) : (
          <span style={{ opacity: 0.7 }}>📁</span>
        )}
        <span
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {label}
        </span>
        <span className={chromeless ? "rl-fd-caret" : undefined} style={chromeless ? undefined : { opacity: 0.6, fontSize: "10px" }}>
          ▾
        </span>
      </button>
      {pop.open && (
        <Panel label="Choose project" {...pop.panelProps}>
          <div
            className="rl-thin-scroll-y"
            // Bounded by Panel's placement-derived `maxHeight`; `minHeight: 0`
            // is what lets this flex child shrink below its content and
            // therefore scroll.
            style={{
              flex: "1 1 auto",
              minHeight: 0,
              overflowY: "auto",
              padding: "4px",
            }}
          >
            <MenuRow
              label="Home (~)"
              selected={value === null}
              onClick={() => {
                onChange(null);
                pop.close();
              }}
            />
            {merged.length > 0 && <RowDivider />}
            {merged.map((opt) => (
              <MenuRow
                key={opt.path}
                label={opt.name}
                hint={
                  opt.source === "session"
                    ? "session"
                    : opt.source === "folder"
                      ? "open folder"
                      : "project"
                }
                selected={
                  (value?.replace(/\/+$/, "") || "") ===
                  (opt.path.replace(/\/+$/, "") || "")
                }
                onClick={() => {
                  onChange(opt.path);
                  pop.close();
                }}
              />
            ))}
            <RowDivider />
            {onNewProject && (
              <MenuRow
                label="＋ New project…"
                onClick={() => {
                  pop.close();
                  onNewProject();
                }}
              />
            )}
            <MenuRow label="📁 Browse…" onClick={browse} />
          </div>
        </Panel>
      )}
    </div>
  );
}

function RowDivider() {
  return (
    <div
      aria-hidden
      style={{ height: "1px", background: "var(--color-rule)", margin: "4px 0" }}
    />
  );
}

function MenuRow({
  label,
  hint,
  selected,
  onClick,
}: {
  label: string;
  hint?: string;
  selected?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center justify-between gap-3 rounded-sm px-2 py-1.5 text-left hover-elevated"
      style={{
        fontSize: "12px",
        background: selected ? "var(--color-anchor-bg)" : "transparent",
        color: selected ? "var(--color-anchor-text)" : "var(--color-ink)",
        cursor: "pointer",
        border: "none",
      }}
    >
      <span
        style={{
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {label}
      </span>
      {hint && (
        <span style={{ opacity: 0.5, fontSize: "10px", flexShrink: 0 }}>
          {hint}
        </span>
      )}
    </button>
  );
}
