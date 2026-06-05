// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { InterceptionMode, ReviewSession } from "../types";
import type { ThemeName } from "../theme/themes";
import { ThemePicker } from "./ThemePicker";
import { ModeToggle } from "./ModeToggle";
import { AlertSettings } from "./AlertSettings";
import type { SoundConfig } from "../audio/beep";

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
  mode: InterceptionMode;
  onModeChange: (mode: InterceptionMode) => void;
  /** Download the currently-displayed revision as a clean .md file. */
  onExport: (sessionId: string, versionNumber: number) => void;
  /** When the user is viewing a historical revision in the pane, the download
   *  button exports *that* version — "what you see is what you save". null
   *  means viewing the latest. */
  viewedVersionNumber?: number | null;
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
}

export function Header({
  session,
  theme,
  onThemeChange,
  mode,
  onModeChange,
  onExport,
  viewedVersionNumber = null,
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
}: HeaderProps) {
  const latest = session?.revisions[session.revisions.length - 1];
  const downloadVersion = viewedVersionNumber ?? latest?.versionNumber;
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
        {session && downloadVersion !== undefined && (
          <button
            type="button"
            onClick={() => onExport(session.sessionId, downloadVersion)}
            title={`Download v${downloadVersion} as a Markdown file`}
            className="rounded px-2.5 py-1 font-medium"
            style={{
              background: "var(--color-bg-elevated)",
              border: "1px solid var(--color-rule)",
              color: "var(--color-ink)",
              fontSize: "12px",
              cursor: "pointer",
            }}
          >
            Download .md
          </button>
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
            v{latest.versionNumber}
          </span>
        )}
      </div>
    </header>
  );
}
