// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useMemo } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Folder } from "lucide-react";
import { ComposerMenu } from "./ComposerMenu";

/** Panel width, px. Exported for the same reason `PANEL_WIDTH` is: the
 *  placement clamp and the rendered panel must agree, or the clamp keeps a
 *  narrower box on screen than the one that paints. */
export const PICKER_WIDTH = 304;

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
}: ProjectPickerProps) {

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
    try {
      const picked = await openDialog({ directory: true, multiple: false });
      if (typeof picked === "string") onChange(picked);
    } catch {
      /* user cancelled or dialog unavailable */
    } finally {
      onAfterPick?.();
    }
  };

  return <ComposerMenu label="Choose project" title="Choose the project to launch the plan in" value={value === null ? "home" : `path:${value.replace(/\/+$/, "")}`} icon={<Folder size={13}/>}
    options={[
      { value: "home", label: "Home (~)", detail: "Use your home directory" },
      ...merged.map(option => ({ value: `path:${option.path.replace(/\/+$/, "")}`, label: option.name, detail: option.path, group: "Projects" })),
      ...(onNewProject ? [{ value: "new", label: "New project…", detail: "Create a folder for this work", group: "Workspace" }] : []),
      { value: "browse", label: "Browse…", detail: "Choose another folder", group: "Workspace" },
    ]}
    onChange={next => {
      if (next === "browse") { void browse(); return; }
      if (next === "new") { onNewProject?.(); return; }
      onChange(next === "home" ? null : next.slice(5) || "/");
      onAfterPick?.();
    }}>{label}</ComposerMenu>;
}
