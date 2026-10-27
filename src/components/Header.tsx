// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { lazy, Suspense } from "react";
import type { ReactNode } from "react";
import type { InterceptionMode, ReviewSession } from "../types";
import type { ThemeName } from "../theme/themes";
import type { FontName } from "../theme/fonts";
import type { LintName } from "../theme/lint";
import { DownloadMenu } from "./DownloadMenu";
// The memory pill polls and renders a popover of its own; it is not first
// paint, so it rides its own chunk (about 9 kB of boot JS, W1).
const MemoryStatusPill = lazy(() => import("./MemoryStatusPill").then((m) => ({ default: m.MemoryStatusPill })));
import { LiveSessionMenu } from "./LiveSessionMenu";
import { SettingsGear } from "./SettingsGear";
import { Button } from "./ui/Button";
import { Pill } from "./ui/Pill";
import type { SoundConfig } from "../audio/beep";
import { latestDisplayVersion } from "../lib/revisionVersions";
import { beginWindowDrag, toggleWindowMaximize } from "../lib/windowDrag";

// The gear and its rows (lazy bodies, one warmed rows chunk) live in
// SettingsGear, which the flow shell's top bar mounts too.

// Programmatic window-drag (there is no native title bar — see windowDrag.ts).
// Lives in lib/ because the immersive hull rail stands in for this header and
// has to carry byte-identical behavior.

// Header controls are the shared ui/Button primitive (text labels for primary
// pane verbs — new users couldn't read the old bare-emoji buttons; low-traffic
// utilities stay glyph-only with a `title` tooltip + `aria-label`). The
// surface radio, the doc pin and the split button left with the workbench
// (W1): surfaces are tabs now, opened from the door's destinations, and
// tiling is the stage's own contextual entry.

interface HeaderProps {
  onOpenIntegrationHooks?: () => void;
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
  /** Harness mode: the harness's name, shown as the header's brand chip —
   *  the one piece of branding A5 swaps. null = stock Redline. */
  harnessName?: string | null;
  /** Exit the harness. null hides the exit (a boot-entered flavor IS its
   *  harness — there is no Redline underneath to return to). */
  onExitHarness?: (() => void) | null;
  /** Manifest-gated auxiliary surfaces. */
  collabEnabled: boolean;
  /** The Surfaces row content for the settings menu (SurfacesPanel). */
  surfacesPanel: ReactNode;
  memoryEnabled: boolean;
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
  harnessName = null,
  onExitHarness = null,
  collabEnabled,
  surfacesPanel,
  memoryEnabled,
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
  onOpenIntegrationHooks,
}: HeaderProps) {
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
      onMouseDown={beginWindowDrag}
      onDoubleClick={toggleWindowMaximize}
    >
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1.5">
          {/* Harness mode: the harness's name stands where stock Redline
              wears no brand at all — one chip that says WHERE you are and,
              when the entry was the user's, is the way back out. */}
          {harnessName && (
            <span
              className="flex items-center gap-1 rounded-full px-2.5 py-1 font-sans"
              style={{
                fontSize: "var(--rl-text-xs)",
                fontWeight: 700,
                lineHeight: 1,
                border: "1px solid var(--color-rule)",
                background: "var(--color-anchor-bg)",
                color: "var(--color-ink)",
                whiteSpace: "nowrap",
              }}
              title={
                onExitHarness
                  ? `Inside ${harnessName} — a harness running on Redline`
                  : harnessName
              }
            >
              {harnessName}
              {onExitHarness && (
                <button
                  type="button"
                  onClick={onExitHarness}
                  aria-label={`Exit ${harnessName}`}
                  title="Exit to Redline"
                  className="flex items-center"
                  style={{
                    color: "var(--color-ink-muted)",
                    cursor: "pointer",
                    marginLeft: "2px",
                  }}
                >
                  ✕
                </button>
              )}
            </span>
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
          {/* Snap-back (⌘⇧0): the layout cluster's escape hatch — return
              every plate to the canonical resting shape; pressed again from
              rest it closes the panes (full-bleed document). A momentary
              action, not a mode, so no `active` prop. Quiet glyph; the
              tour will point here, so it carries a stable anchor. */}
          <span data-tour="snapback" className="flex">
            <Button
              onClick={onSnapBack}
              title="Snap the layout to its resting shape — again to close the panes (⌘⇧0)"
              ariaLabel="Snap the layout to its resting shape — again to close the panes"
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
        {/* The ambient memory pill — Memory's one entry point (deliberately
            not a main-radio button; the pill opens the surface). */}
        {memoryEnabled && (
          <Suspense fallback={null}>
          <MemoryStatusPill
            onOpenMemory={onOpenMemory}
            onOpenInspector={onOpenMemoryInspector}
          />
          </Suspense>
        )}
        <SettingsGear
          onOpenIntegrationHooks={onOpenIntegrationHooks}
          mode={mode}
          onModeChange={onModeChange}
          theme={theme}
          onThemeChange={onThemeChange}
          font={font}
          onFontChange={onFontChange}
          lint={lint}
          onLintChange={onLintChange}
          flashEnabled={flashEnabled}
          onFlashEnabledChange={onFlashEnabledChange}
          flashColor={flashColor}
          onFlashColorChange={onFlashColorChange}
          flashSound={flashSound}
          onFlashSoundChange={onFlashSoundChange}
          flashSoundConfig={flashSoundConfig}
          onFlashSoundConfigChange={onFlashSoundConfigChange}
          onFlashSoundPreview={onFlashSoundPreview}
          onFlashTest={onFlashTest}
          surfacesPanel={surfacesPanel}
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
    </header>
  );
}
