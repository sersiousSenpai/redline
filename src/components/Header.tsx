// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { InterceptionMode, ReviewSession } from "../types";
import type { MainSurface } from "../lib/mainSurface";
import type { SurfaceDescriptor, ToggleableSurface } from "../config/workspace";
import { useMenuOverlay } from "./menuOverlay";
import type { ThemeName } from "../theme/themes";
import type { FontName } from "../theme/fonts";
import type { LintName } from "../theme/lint";
import { ThemePicker } from "./ThemePicker";
import { FontPicker } from "./FontPicker";
import { AgentSeats } from "./AgentSeats";
import { LintPicker } from "./LintPicker";
import { DownloadMenu } from "./DownloadMenu";
import { ModeToggle } from "./ModeToggle";
import { AlertSettings } from "./AlertSettings";
import { MemoryStatusPill } from "./MemoryStatusPill";
import { LiveSessionMenu } from "./LiveSessionMenu";
import { SettingsMenu } from "./SettingsMenu";
import { ExtensionsPanel } from "./ExtensionsPanel";
import { Button } from "./ui/Button";
import { MenuSurface } from "./ui/MenuSurface";
import { Pill } from "./ui/Pill";
import type { SoundConfig } from "../audio/beep";
import { latestDisplayVersion } from "../lib/revisionVersions";

// Programmatic window-drag. Tauri 2's data-tauri-drag-region attribute does
// not reliably walk ancestors in this build — only exact mousedown targets
// were dragging, leaving the header mostly inert. Instead, we listen on the
// header itself and trigger startDragging() unless the mousedown originated
// on an interactive control (buttons, selects, links, inputs). Double-click
// invokes the platform's title-bar action (zoom on macOS).
const INTERACTIVE_TAGS = new Set(["BUTTON", "A", "INPUT", "SELECT", "TEXTAREA"]);

function isInteractive(target: EventTarget | null): boolean {
  let el = target as HTMLElement | null;
  while (el) {
    if (INTERACTIVE_TAGS.has(el.tagName)) return true;
    if (el.dataset?.noDrag === "true") return true;
    if (el.tagName === "HEADER") return false;
    el = el.parentElement;
  }
  return false;
}

// Header controls are the shared ui/Button primitive (text labels for primary
// pane verbs — new users couldn't read the old bare-emoji buttons; low-traffic
// utilities stay glyph-only with a `title` tooltip + `aria-label`). The
// surface radio group below composes them into one segmented control.

interface HeaderProps {
  session: ReviewSession | null;
  theme: ThemeName;
  onThemeChange: (name: ThemeName) => void;
  font: FontName;
  onFontChange: (name: FontName) => void;
  lint: LintName;
  onLintChange: (name: LintName) => void;
  mode: InterceptionMode;
  onModeChange: (mode: InterceptionMode) => void;
  /** Download the currently-displayed revision as a clean .md file. */
  onExport: (sessionId: string, versionNumber: number) => void;
  /** Download the currently-displayed revision as a Word .docx file. */
  onExportDocx: (sessionId: string, versionNumber: number) => void;
  /** Save the currently-displayed revision as a note in the Obsidian vault. */
  onSaveObsidian: (sessionId: string, versionNumber: number) => void;
  /** When the user is viewing a historical revision in the pane, the download
   *  button exports *that* version — "what you see is what you save". null
   *  means viewing the latest. */
  viewedVersionNumber?: number | null;
  /** The user is browsing files (folder view), not a plan — grey out Download. */
  downloadDisabled?: boolean;
  // Flash-on-intercept alert preferences (owned by App, persisted).
  flashEnabled: boolean;
  onFlashEnabledChange: (next: boolean) => void;
  flashColor: string;
  onFlashColorChange: (next: string) => void;
  flashSound: boolean;
  onFlashSoundChange: (next: boolean) => void;
  flashSoundConfig: SoundConfig;
  onFlashSoundConfigChange: (next: SoundConfig) => void;
  onFlashSoundPreview: (config: SoundConfig) => void;
  onFlashTest: () => void;
  /** Which single surface owns the center pane. The surface buttons are
   *  a radio group: clicking always full-switches, never tiles. */
  surface: MainSurface;
  onSelectSurface: (next: MainSurface) => void;
  /** The main-pane radio group, composed by the workspace manifest — order
   *  and membership come from ~/.redline/workspace.json (see workspace.ts). */
  surfaces: SurfaceDescriptor[];
  /** Edit-in-place: right-click a surface button → hide / move. Both write
   *  the workspace manifest — customization happens where the thing is. */
  onHideSurface: (id: ToggleableSurface) => void;
  onMoveSurface: (id: MainSurface, delta: -1 | 1) => void;
  /** Manifest-gated auxiliary surfaces. */
  collabEnabled: boolean;
  /** The Surfaces row content for the settings menu (SurfacesPanel). */
  surfacesPanel: ReactNode;
  memoryEnabled: boolean;
  /** Explicit tiling: keep the document alongside a non-document surface. */
  docPinned: boolean;
  onToggleDocPin: () => void;
  /** The doc pin is on over a non-document surface, so the split orientation
   *  control shows. */
  splitActive: boolean;
  /** true = stacked (column), false = side-by-side (row). */
  splitVertical: boolean;
  /** Flip the split between side-by-side and stacked. */
  onToggleSplitOrientation: () => void;
  /** Snap every plate back to the canonical resting shape (⌘⇧0). */
  onSnapBack: () => void;
  /** Open the ⌘K command palette. The button matters beyond discoverability:
   *  keystrokes focused inside the native browser webview never reach our
   *  DOM, so over the browser surface this is how ⌘K exists at all. */
  onOpenPalette: () => void;
  /** Land on the Memory main surface (the pill popover's primary action). */
  onOpenMemory: () => void;
  /** The quick-inspector modal (the pill popover's escape hatch). */
  onOpenMemoryInspector: () => void;
  /** A live collaboration room is active (sharing or joined). */
  collabActive: boolean;
  /** Invite needs an active plan session to share. */
  canInvite: boolean;
  onInvite: () => void;
  onJoinSession: () => void;
  /** Async snapshot share needs an active plan session too. */
  canShare: boolean;
  onShareSnapshot: () => void;
}

export function Header({
  session,
  theme,
  onThemeChange,
  font,
  onFontChange,
  lint,
  onLintChange,
  mode,
  onModeChange,
  onExport,
  onExportDocx,
  onSaveObsidian,
  viewedVersionNumber = null,
  downloadDisabled = false,
  flashEnabled,
  onFlashEnabledChange,
  flashColor,
  onFlashColorChange,
  flashSound,
  onFlashSoundChange,
  flashSoundConfig,
  onFlashSoundConfigChange,
  onFlashSoundPreview,
  onFlashTest,
  surface,
  onSelectSurface,
  surfaces,
  onHideSurface,
  onMoveSurface,
  collabEnabled,
  surfacesPanel,
  memoryEnabled,
  docPinned,
  onToggleDocPin,
  splitActive,
  splitVertical,
  onToggleSplitOrientation,
  onSnapBack,
  onOpenPalette,
  onOpenMemory,
  onOpenMemoryInspector,
  collabActive,
  canInvite,
  onInvite,
  onJoinSession,
  canShare,
  onShareSnapshot,
}: HeaderProps) {
  // Edit-in-place context menu: right-click a surface button to hide or move
  // it. Each action writes the workspace manifest — the file is the store.
  const [ctxMenu, setCtxMenu] = useState<{
    x: number;
    y: number;
    id: MainSurface;
  } | null>(null);
  useMenuOverlay(!!ctxMenu);
  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setCtxMenu(null);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [ctxMenu]);

  const ctxItems: { label: string; onPick: () => void }[] = [];
  if (ctxMenu) {
    const idx = surfaces.findIndex((d) => d.id === ctxMenu.id);
    if (idx > 0) {
      ctxItems.push({
        label: "Move left",
        onPick: () => onMoveSurface(ctxMenu.id, -1),
      });
    }
    if (idx >= 0 && idx < surfaces.length - 1) {
      ctxItems.push({
        label: "Move right",
        onPick: () => onMoveSurface(ctxMenu.id, 1),
      });
    }
    if (ctxMenu.id !== "document") {
      ctxItems.push({
        label: "Hide",
        onPick: () => onHideSurface(ctxMenu.id as ToggleableSurface),
      });
    }
  }

  const latest = session?.revisions[session.revisions.length - 1];
  const downloadVersion = viewedVersionNumber ?? latest?.versionNumber;
  // Badge shows the substantive version — restores re-use the version they
  // restore rather than advancing the count.
  const badgeVersion = session
    ? latestDisplayVersion(session.revisions, latest?.versionNumber ?? 0)
    : 0;
  return (
    <header
      className="rl-app-header flex items-center justify-end gap-4 pl-20 pr-6 py-2"
      onMouseDown={(e) => {
        if (e.button !== 0) return;
        if (isInteractive(e.target)) return;
        void getCurrentWindow().startDragging();
      }}
      onDoubleClick={(e) => {
        if (isInteractive(e.target)) return;
        void getCurrentWindow().toggleMaximize();
      }}
    >
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1.5">
          {/* Surface picker — one segmented control (a floating control
              cluster on the canvas) instead of a loose row of buttons.
              Clicking full-switches the center pane (clicking the active
              surface is a no-op). Membership and order come from the
              workspace manifest; right-click edits in place. Text-only
              labels; the tooltip carries the longer description. */}
          <div
            className="flex items-stretch overflow-hidden"
            role="radiogroup"
            aria-label="Main pane surface"
            style={{
              border: "1px solid var(--color-rule)",
              borderRadius: "var(--rl-radius-control)",
              background: "var(--color-bg-elevated)",
            }}
          >
            {surfaces.map(({ id, label, title }, i) => (
              <span
                key={id}
                className="flex"
                onContextMenu={(e) => {
                  e.preventDefault();
                  setCtxMenu({ x: e.clientX, y: e.clientY, id });
                }}
              >
                <button
                  type="button"
                  role="radio"
                  aria-checked={surface === id}
                  aria-label={title}
                  title={surface === id ? `${label} is showing` : title}
                  onClick={() => {
                    if (surface !== id) onSelectSurface(id);
                  }}
                  className="font-sans px-2.5 py-1"
                  style={{
                    fontSize: "var(--rl-text-xs)",
                    fontWeight: 600,
                    lineHeight: 1,
                    background:
                      surface === id ? "var(--color-anchor-bg)" : "transparent",
                    color:
                      surface === id
                        ? "var(--color-ink)"
                        : "var(--color-ink-muted)",
                    borderLeft:
                      i > 0 ? "1px solid var(--color-rule)" : "none",
                    cursor: "pointer",
                  }}
                >
                  {label}
                </button>
              </span>
            ))}
          </div>
          {/* Explicit tiling: while a non-document surface is up, pin the
              document alongside it. Sticky — switching surfaces then swaps
              only the non-document tile. */}
          {surface !== "document" && (
            <Button
              onClick={onToggleDocPin}
              active={docPinned}
              title={
                docPinned
                  ? "Untile the document"
                  : "Tile the document alongside"
              }
              ariaLabel={
                docPinned
                  ? "Untile the document"
                  : "Tile the document alongside"
              }
              icon="◫"
            />
          )}
          {/* Invite + Join folded into one Live Session dropdown. */}
          {collabEnabled && (
            <LiveSessionMenu
              canInvite={canInvite}
              collabActive={collabActive}
              onInvite={onInvite}
              onJoinSession={onJoinSession}
            />
          )}
          {splitActive && (
            <Button
              onClick={onToggleSplitOrientation}
              title={splitVertical ? "Side-by-side split" : "Stacked split"}
              ariaLabel={
                splitVertical ? "Side-by-side split" : "Stacked split"
              }
              icon={splitVertical ? "⬌" : "⬍"}
            />
          )}
          {/* Snap-back (⌘⇧0): the layout cluster's escape hatch — return
              every plate to the canonical resting shape. Quiet glyph; the
              tour will point here, so it carries a stable anchor. */}
          <span data-tour="snapback" className="flex">
            <Button
              onClick={onSnapBack}
              title="Snap the layout back to its resting shape (⌘⇧0)"
              ariaLabel="Snap the layout back to its resting shape"
              icon="⌂"
            />
          </span>
          <Button
            onClick={onOpenPalette}
            title="Command palette (⌘K)"
            ariaLabel="Open the command palette"
            icon="⌘K"
            iconMono
          />
        </div>
        {/* The ambient memory pill — header chrome, no longer buried in the
            Settings dropdown (Memory is a main surface now). */}
        {memoryEnabled && (
          <MemoryStatusPill
            onOpenMemory={onOpenMemory}
            onOpenInspector={onOpenMemoryInspector}
          />
        )}
        <SettingsMenu
          mode={<ModeToggle mode={mode} onChange={onModeChange} />}
          theme={<ThemePicker theme={theme} onThemeChange={onThemeChange} />}
          font={<FontPicker font={font} onFontChange={onFontChange} />}
          lint={<LintPicker lint={lint} onLintChange={onLintChange} />}
          agents={<AgentSeats />}
          surfaces={surfacesPanel}
          extensions={<ExtensionsPanel />}
          notifications={
            <AlertSettings
              enabled={flashEnabled}
              onEnabledChange={onFlashEnabledChange}
              color={flashColor}
              onColorChange={onFlashColorChange}
              sound={flashSound}
              onSoundChange={onFlashSoundChange}
              soundConfig={flashSoundConfig}
              onSoundConfigChange={onFlashSoundConfigChange}
              onSoundPreview={onFlashSoundPreview}
              onTest={onFlashTest}
            />
          }
        />
        {session && downloadVersion !== undefined && (
          <DownloadMenu
            version={downloadVersion}
            disabled={downloadDisabled}
            onExportMarkdown={() =>
              onExport(session.sessionId, downloadVersion)
            }
            onExportDocx={() =>
              onExportDocx(session.sessionId, downloadVersion)
            }
            onSaveObsidian={() =>
              onSaveObsidian(session.sessionId, downloadVersion)
            }
            canShare={canShare}
            onShareSnapshot={onShareSnapshot}
          />
        )}
        {latest && <Pill mono>v{badgeVersion}</Pill>}
      </div>
      {ctxMenu && ctxItems.length > 0 && (
        <MenuSurface
          ariaLabel="Customize surface"
          className="fixed z-50 py-1"
          style={{ left: ctxMenu.x, top: ctxMenu.y, minWidth: "120px" }}
          // Keep the click-away closer from eating the item click.
          onMouseDown={(e) => e.stopPropagation()}
        >
          {ctxItems.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className="block w-full text-left px-3 py-1 font-sans"
              style={{
                fontSize: "var(--rl-text-xs)",
                background: "transparent",
                border: "none",
                color: "var(--color-ink)",
                cursor: "pointer",
              }}
              onClick={() => {
                item.onPick();
                setCtxMenu(null);
              }}
            >
              {item.label}
            </button>
          ))}
        </MenuSurface>
      )}
    </header>
  );
}
