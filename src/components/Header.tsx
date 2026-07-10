// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { CSSProperties, ReactNode } from "react";
import type { InterceptionMode, ReviewSession } from "../types";
import type { MainSurface } from "../lib/mainSurface";
import type { ThemeEntry, ThemeName } from "../theme/themes";
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
  /** User themes loaded from ~/.redline/themes — the picker's "user" section. */
  userThemes: ThemeEntry[];
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
  /** Which single surface owns the center pane. The four surface buttons are
   *  a radio group: clicking always full-switches, never tiles. */
  surface: MainSurface;
  onSelectSurface: (next: MainSurface) => void;
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
  userThemes,
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
  docPinned,
  onToggleDocPin,
  splitActive,
  splitVertical,
  onToggleSplitOrientation,
  companionOpen,
  onToggleCompanion,
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
        <div className="flex items-center gap-1.5" role="radiogroup" aria-label="Main pane surface">
          {/* Surface radio group — always visible, clicking full-switches the
              center pane (clicking the active surface is a no-op). Text-only
              labels (no glyphs; the emoji read as toy-like and one filled its
              button). The tooltip carries the longer description. */}
          {(
            [
              ["document", "Document", "Show the document"],
              ["browser", "Browser", "Switch to the browser"],
              ["drafter", "Prompt Drafter", "Draft a new prompt"],
              ["review", "Code Review", "Review code changes"],
            ] as const
          ).map(([key, label, title]) => (
            <HeaderButton
              key={key}
              onClick={() => {
                if (surface !== key) onSelectSurface(key);
              }}
              active={surface === key}
              title={surface === key ? `${label} is showing` : title}
              ariaLabel={title}
              label={label}
            />
          ))}
          {/* Explicit tiling: while a non-document surface is up, pin the
              document alongside it. Sticky — switching surfaces then swaps
              only the non-document tile. */}
          {surface !== "document" && (
            <HeaderButton
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
          {/* Invite + Join folded into one Live Session dropdown. */}
          <LiveSessionMenu
            canInvite={canInvite}
            collabActive={collabActive}
            onInvite={onInvite}
            onJoinSession={onJoinSession}
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
          theme={
            <ThemePicker
              theme={theme}
              onThemeChange={onThemeChange}
              userThemes={userThemes}
            />
          }
          font={<FontPicker font={font} onFontChange={onFontChange} />}
          lint={<LintPicker lint={lint} onLintChange={onLintChange} />}
          agents={<AgentSeats />}
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
            canShare={canShare}
            onShareSnapshot={onShareSnapshot}
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
