// SPDX-License-Identifier: Apache-2.0
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PreflightStatus } from "../lib/readiness";
import { IntegrationSetupDialog } from "./IntegrationSetupDialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom has no modal dialogs.
HTMLDialogElement.prototype.showModal = function () { this.open = true; };
HTMLDialogElement.prototype.close = function () { this.open = false; };
let host: HTMLDivElement, root: Root;
beforeEach(() => { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

function codexHealth(outdated: boolean): PreflightStatus {
  return { claude: { found: true, path: "/claude", source: "test" }, curl: { ok: true, version: null }, mode: "active", hook: { installed: true, conflictingUrl: null }, skill: { installed: true, outdated: false }, codex: { found: true, path: "/codex", source: "test", usable: true, signedIn: true, authState: "signed-in", profile: { installed: true, outdated: false, path: "/profile" } }, codexHook: { installed: true, outdated, available: true, stopFound: true, promptCaptureFound: true, hooksPath: "/hooks", trust: "trusted" }, codexSkill: { installed: true, outdated: false } };
}
async function render(outdated: boolean, pending = false) {
  await act(async () => root.render(<IntegrationSetupDialog backend="codex" health={codexHealth(outdated)} busy={false} progress={null} error={null}
    done={false} pending={pending} onInstall={() => {}} onDismiss={() => {}}/>));
  const hooks = [...host.querySelectorAll(".rl-integration-pieces > div")].find(row => row.textContent?.includes("Plan and prompt hooks"))!;
  return { hooks: hooks.textContent, primary: host.querySelector("button.primary")!.textContent };
}

describe("Codex setup dialog", () => {
  it("offers an earlier hook that still works an update, never a bare verify", async () => {
    expect(await render(true)).toEqual({ hooks: "○ Plan and prompt hooks Update available", primary: "Install integration" });
    expect((await render(true, true)).primary).toBe("Install and continue");
    expect(await render(false)).toEqual({ hooks: "✓ Plan and prompt hooks Installed", primary: "Verify and continue" });
  });
});
