// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { lazy, Suspense } from "react";
import type { ReactNode } from "react";
import type { InterceptionMode } from "../types";
import type { ThemeName } from "../theme/themes";
import type { FontName } from "../theme/fonts";
import type { LintName } from "../theme/lint";
import type { SoundConfig } from "../audio/beep";
import { SettingsMenu, settingsRow } from "./SettingsMenu";

// The gear and everything behind it, mounted by the header: the classic Header
// top bars: the classic Header and the flow top bar each render this one
// component, so a Settings row added here shows in both.
//
// Settings BODIES, not the settings trigger. The gear stays static — it has
// to, it is chrome — but the panels behind it are two of the heaviest
// components in the app (the seat chart's model/effort matrix, the extension
// marketplace) and they are behind a click that most launches never make.
// `SettingsMenu` only mounts its rows while the menu is open, so `lazy` here
// means the chunk is fetched on the first open and never on boot.
const AgentSeats = lazy(() =>
  import("./AgentSeats").then((m) => ({ default: m.AgentSeats })),
);
const ExtensionsPanel = lazy(() =>
  import("./ExtensionsPanel").then((m) => ({ default: m.ExtensionsPanel })),
);
// The lighter rows (mode, theme, font, linting, notifications) share
// one chunk, warmed as the pointer reaches the gear.
const ModeToggle = settingsRow("ModeToggle");
const ThemePicker = settingsRow("ThemePicker");
const FontPicker = settingsRow("FontPicker");
const TerminalSettings = settingsRow("TerminalSettings");
const TransparencySettings = settingsRow("TransparencySettings");
const LintPicker = settingsRow("LintPicker");
const AlertSettings = settingsRow("AlertSettings");

export interface SettingsGearProps {
  onOpenIntegrationHooks?: () => void;
  theme: ThemeName;
  onThemeChange: (name: ThemeName) => void;
  font: FontName;
  onFontChange: (name: FontName) => void;
  lint: LintName;
  onLintChange: (name: LintName) => void;
  mode: InterceptionMode;
  onModeChange: (mode: InterceptionMode) => void;
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
  /** The Surfaces row content for the settings menu (SurfacesPanel). */
  surfacesPanel: ReactNode;
  /** The flow top bar's bare gear (see SettingsMenu's `compact`). */
  compact?: boolean;
  triggerClassName?: string;
  icon?: ReactNode;
}

export function SettingsGear({
  onOpenIntegrationHooks,
  theme,
  onThemeChange,
  font,
  onFontChange,
  lint,
  onLintChange,
  mode,
  onModeChange,
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
  surfacesPanel,
  compact,
  triggerClassName,
  icon,
}: SettingsGearProps) {
  return (
    <SettingsMenu
      compact={compact}
      triggerClassName={triggerClassName}
      icon={icon}
      terminal={<TerminalSettings />}
      transparency={<TransparencySettings />}
      onOpenIntegrationHooks={onOpenIntegrationHooks}
      mode={<ModeToggle mode={mode} onChange={onModeChange} />}
      theme={<ThemePicker theme={theme} onThemeChange={onThemeChange} />}
      font={<FontPicker font={font} onFontChange={onFontChange} />}
      lint={<LintPicker lint={lint} onLintChange={onLintChange} />}
      agents={
        <Suspense fallback={null}>
          <AgentSeats />
        </Suspense>
      }
      surfaces={surfacesPanel}
      extensions={
        <Suspense fallback={null}>
          <ExtensionsPanel />
        </Suspense>
      }
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
  );
}
