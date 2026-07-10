// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { CSSProperties, ReactNode } from "react";
import type { InterceptionMode, ReviewSession } from "../types";
import type { ThemeName } from "../theme/themes";
import type { FontName } from "../theme/fonts";
import type { LintName } from "../theme/lint";
import { ThemePicker } from "./ThemePicker";
import { FontPicker } from "./FontPicker";
import { LintPicker } from "./LintPicker";
import { DownloadMenu } from "./DownloadMenu";
import { ModeToggle } from "./ModeToggle";
import { AlertSettings } from "./AlertSettings";
import { MemoryStatusPill } from "./MemoryStatusPill";
import { CollaborateMenu } from "./CollaborateMenu";
import { SettingsMenu } from "./SettingsMenu";
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

// One header control, styled consistently. New users couldn't read the old
// bare-emoji buttons ("reminds me of dial-up"), so primary pane verbs now carry
// a text `label` beside the glyph; low-traffic utilities stay glyph-only but
// keep a `title` tooltip + `aria-label`. Same token-keyed look across themes.
function HeaderButton({
  onClick,
  active = false,
  disabled = false,
  title,
  ariaLabel,
  icon,
  label,
  iconMono = false,
  style,
}: {
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  title: string;
  ariaLabel: string;
  /** Omitted ⇒ text-only button (the default for primary verbs). */
  icon?: ReactNode;
  /** Present ⇒ the readable text label beside/instead of a glyph. */
  label?: string;
  /** A glyph that reads as a symbol in mono/bold (e.g. `±`, `⇲`). */
  iconMono?: boolean;
  style?: CSSProperties;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={ariaLabel}
      aria-pressed={active}
      className="flex items-center gap-1.5 rounded-sm px-2 py-0.5 font-sans"
      style={{
        fontSize: "11px",
        lineHeight: 1,
        border: "1px solid var(--color-rule)",
        background: active
          ? "var(--color-anchor-bg)"
          : "var(--color-bg-elevated)",
        color: active ? "var(--color-anchor-text)" : "var(--color-ink)",
        cursor: disabled ? "default" : "pointer",
        ...style,
      }}
    >
      {icon != null && (
        <span
          aria-hidden
          style={{
            fontSize: "13px",
            lineHeight: 1,
            ...(iconMono
              ? {
                  fontFamily: "var(--font-mono, ui-monospace, monospace)",
                  fontWeight: 700,
                }
              : null),
          }}
        >
          {icon}
        </span>
      )}
      {label && <span style={{ fontWeight: 600 }}>{label}</span>}
    </button>
  );
}

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
  /** Whether the Code Review pane is showing in the center pane. */
  reviewOpen: boolean;
  /** Toggle the Code Review pane on/off. */
  onToggleReview: () => void;
  /** The Companion drawer — the global cross-surface discussion (⌘J). */
  companionOpen: boolean;
  onToggleCompanion: () => void;
  /** Open the one quiet memory surface (the read-mostly inspector). */
  onOpenMemory: () => void;
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
  docOpen,
  onToggleDoc,
  browserOpen,
  onToggleBrowser,
  splitActive,
  splitVertical,
  onToggleSplitOrientation,
  drafterOpen,
  onToggleDrafter,
  companionOpen,
  onToggleCompanion,
  reviewOpen,
  onToggleReview,
  onOpenMemory,
  collabActive,
  canInvite,
  onInvite,
  onJoinSession,
  canShare,
  onShareSnapshot,
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
      className="flex items-center justify-end gap-4 pl-20 pr-6 py-2"
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
          {/* The document is the default view; this glyph-only toggle appears
              while a secondary pane (browser/drafter/review) is open, to
              add/remove the document from the split. Low-traffic → no label. */}
          {(browserOpen || drafterOpen || reviewOpen) && (
            <HeaderButton
              onClick={onToggleDoc}
              active={docOpen}
              title={docOpen ? "Hide document" : "Show document"}
              ariaLabel={docOpen ? "Hide document" : "Show document"}
              label="Document"
            />
          )}
          {/* Primary pane verbs — text-only labels (no glyphs; the emoji read
              as toy-like and one filled its button). The tooltip carries the
              longer description. */}
          <HeaderButton
            onClick={onToggleBrowser}
            active={browserOpen}
            title={browserOpen ? "Hide browser" : "Show browser"}
            ariaLabel={browserOpen ? "Hide browser" : "Show browser"}
            label="Browser"
          />
          <HeaderButton
            onClick={onToggleDrafter}
            active={drafterOpen}
            title={drafterOpen ? "Close prompt drafter" : "Draft a new prompt"}
            ariaLabel={
              drafterOpen ? "Close prompt drafter" : "Draft a new prompt"
            }
            label="Prompt Drafter"
          />
          <HeaderButton
            onClick={onToggleReview}
            active={reviewOpen}
            title={reviewOpen ? "Hide code review" : "Review code changes"}
            ariaLabel={reviewOpen ? "Hide code review" : "Review code changes"}
            label="Code Review"
          />
          <HeaderButton
            onClick={onToggleCompanion}
            active={companionOpen}
            title={
              companionOpen
                ? "Close the Companion (⌘J)"
                : "The Companion — one conversation that follows you everywhere (⌘J)"
            }
            ariaLabel={
              companionOpen ? "Close the Companion" : "Open the Companion"
            }
            label="Companion"
          />
          {/* Invite + Join folded into one Collaborate dropdown. */}
          <CollaborateMenu
            canInvite={canInvite}
            collabActive={collabActive}
            onInvite={onInvite}
            onJoinSession={onJoinSession}
            canShare={canShare}
            onShareSnapshot={onShareSnapshot}
          />
          {splitActive && (
            <HeaderButton
              onClick={onToggleSplitOrientation}
              title={splitVertical ? "Side-by-side split" : "Stacked split"}
              ariaLabel={
                splitVertical ? "Side-by-side split" : "Stacked split"
              }
              icon={splitVertical ? "⬌" : "⬍"}
            />
          )}
        </div>
        <SettingsMenu
          mode={<ModeToggle mode={mode} onChange={onModeChange} />}
          theme={<ThemePicker theme={theme} onThemeChange={onThemeChange} />}
          font={<FontPicker font={font} onFontChange={onFontChange} />}
          lint={<LintPicker lint={lint} onLintChange={onLintChange} />}
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
          memory={<MemoryStatusPill onOpen={onOpenMemory} />}
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
