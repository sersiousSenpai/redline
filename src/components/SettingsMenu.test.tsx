// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsMenu, settingsRow } from "./SettingsMenu";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

const gear = () => host.querySelector<HTMLButtonElement>('[data-tour="settings"] > button')!;
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

/** The menu with two of its rows' lazy controls; the other rows are empty. */
async function mount(Theme: ReturnType<typeof settingsRow<"ThemePicker">>, Mode: ReturnType<typeof settingsRow<"ModeToggle">>) {
  await act(async () => root.render(
    <SettingsMenu
      mode={<Mode mode="active" onChange={() => {}} />}
      theme={<Theme theme="aurora" onThemeChange={() => {}} />}
      font={null}
      lint={null}
      agents={null}
      surfaces={null}
      extensions={null}
      notifications={null}
    />,
  ));
}

// One file, one order: the first test opens before anything is warmed, and
// the rows' chunk is then in the module cache for the second.
describe("the settings rows' lazy chunk", () => {
  it("renders the rows once the chunk lands, on an open nothing warmed", async () => {
    await mount(settingsRow("ThemePicker"), settingsRow("ModeToggle"));
    await act(async () => gear().click());
    expect(host.querySelector('[aria-label="Settings"]')).not.toBeNull();
    expect(host.querySelector('[data-tour="theme"]')).toBeNull();
    await vi.waitFor(async () => {
      await settle();
      expect(host.querySelector('[data-tour="theme"]')).not.toBeNull();
    }, { timeout: 2000 });
    expect(host.querySelector('[data-tour="mode"]')).not.toBeNull();
  });

  it("warmed as the pointer reaches the gear, the first open renders its rows in the same commit", async () => {
    await mount(settingsRow("ThemePicker"), settingsRow("ModeToggle"));
    await act(async () => gear().dispatchEvent(new MouseEvent("pointerover", { bubbles: true })));
    await settle();
    act(() => gear().click());
    expect(host.querySelector('[data-tour="theme"]')).not.toBeNull();
    expect(host.querySelector('[data-tour="mode"]')).not.toBeNull();
  });
});
