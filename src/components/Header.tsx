// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { InterceptionMode, ReviewSession } from "../types";
import type { ThemeName } from "../theme/themes";
import type { FontName } from "../theme/fonts";
import { ThemePicker } from "./ThemePicker";
import { FontPicker } from "./FontPicker";
import { DownloadMenu } from "./DownloadMenu";
import { ModeToggle } from "./ModeToggle";
import { AlertSettings } from "./AlertSettings";
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

interface HeaderProps {
  session: ReviewSession | null;
  theme: ThemeName;
  onThemeChange: (name: ThemeName) => void;
  font: FontName;
  onFontChange: (name: FontName) => void;
  mode: InterceptionMode;
  onModeChange: (mode: InterceptionMode) => void;
  /** Download the currently-displayed revision as a clean .md file. */
  onExport: (sessionId: string, versionNumber: number) => void;
  /** Download the currently-displayed revision as a Word .docx file. */
  onExportDocx: (sessionId: string, versionNumber: number) => void;
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
  /** Whether the document view is showing in the center pane. */
  docOpen: boolean;
  /** Toggle the document view on/off. */
  onToggleDoc: () => void;
  /** Whether the embedded browser is currently showing in the center pane. */
  browserOpen: boolean;
  /** Toggle the embedded browser on/off. */
  onToggleBrowser: () => void;
  /** Both document and browser are on, so the split orientation control shows. */
  splitActive: boolean;
  /** true = stacked (column), false = side-by-side (row). */
  splitVertical: boolean;
  /** Flip the split between side-by-side and stacked. */
  onToggleSplitOrientation: () => void;
  /** Whether the Prompt Drafter is showing in the center pane. */
  drafterOpen: boolean;
  /** Toggle the Prompt Drafter on/off. */
  onToggleDrafter: () => void;
}

export function Header({
  session,
  theme,
  onThemeChange,
  font,
  onFontChange,
  mode,
  onModeChange,
  onExport,
  onExportDocx,
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
  docOpen,
  onToggleDoc,
  browserOpen,
  onToggleBrowser,
  splitActive,
  splitVertical,
  onToggleSplitOrientation,
  drafterOpen,
  onToggleDrafter,
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
      className="flex items-center justify-end gap-4 pl-20 pr-6 py-3"
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
          {/* The document is the default view; this toggle appears while a
              secondary pane (browser or drafter) is open, to add/remove the
              document from the split. */}
          {(browserOpen || drafterOpen) && (
            <button
              type="button"
              onClick={onToggleDoc}
              title={docOpen ? "Hide document" : "Show document"}
              aria-label={docOpen ? "Hide document" : "Show document"}
              aria-pressed={docOpen}
              className="flex items-center rounded-sm px-2 py-0.5"
              style={{
                fontSize: "13px",
                lineHeight: 1,
                border: "1px solid var(--color-rule)",
                background: docOpen
                  ? "var(--color-anchor-bg)"
                  : "var(--color-bg-elevated)",
                color: docOpen
                  ? "var(--color-anchor-text)"
                  : "var(--color-ink)",
                cursor: "pointer",
              }}
            >
              📄
            </button>
          )}
          <button
            type="button"
            onClick={onToggleBrowser}
            title={browserOpen ? "Hide browser" : "Show browser"}
            aria-label={browserOpen ? "Hide browser" : "Show browser"}
            aria-pressed={browserOpen}
            className="flex items-center rounded-sm px-2 py-0.5"
            style={{
              fontSize: "13px",
              lineHeight: 1,
              border: "1px solid var(--color-rule)",
              background: browserOpen
                ? "var(--color-anchor-bg)"
                : "var(--color-bg-elevated)",
              color: browserOpen
                ? "var(--color-anchor-text)"
                : "var(--color-ink)",
              cursor: "pointer",
            }}
          >
            🌐
          </button>
          <button
            type="button"
            onClick={onToggleDrafter}
            title={drafterOpen ? "Close prompt drafter" : "Draft a new prompt"}
            aria-label={
              drafterOpen ? "Close prompt drafter" : "Draft a new prompt"
            }
            aria-pressed={drafterOpen}
            className="flex items-center rounded-sm px-2 py-0.5"
            style={{
              fontSize: "13px",
              lineHeight: 1,
              border: "1px solid var(--color-rule)",
              background: drafterOpen
                ? "var(--color-anchor-bg)"
                : "var(--color-bg-elevated)",
              color: drafterOpen
                ? "var(--color-anchor-text)"
                : "var(--color-ink)",
              cursor: "pointer",
            }}
          >
            ✍️
          </button>
          {splitActive && (
            <button
              type="button"
              onClick={onToggleSplitOrientation}
              title={
                splitVertical
                  ? "Side-by-side split"
                  : "Stacked split"
              }
              aria-label={
                splitVertical ? "Side-by-side split" : "Stacked split"
              }
              className="flex items-center rounded-sm px-2 py-0.5"
              style={{
                fontSize: "13px",
                lineHeight: 1,
                border: "1px solid var(--color-rule)",
                background: "var(--color-bg-elevated)",
                color: "var(--color-ink)",
                cursor: "pointer",
              }}
            >
              {splitVertical ? "⬌" : "⬍"}
            </button>
          )}
        </div>
        <ModeToggle mode={mode} onChange={onModeChange} />
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
        <ThemePicker theme={theme} onThemeChange={onThemeChange} />
        <FontPicker font={font} onFontChange={onFontChange} />
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
          />
        )}
        {latest && (
          <span
            className="font-mono rounded-sm px-2 py-0.5"
            style={{
              background: "var(--color-anchor-bg)",
              color: "var(--color-anchor-text)",
              fontSize: "11px",
            }}
          >
            v{badgeVersion}
          </span>
        )}
      </div>
    </header>
  );
}
