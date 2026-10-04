// SPDX-License-Identifier: Apache-2.0
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { calls, pending } = vi.hoisted(() => ({ calls: [] as { cmd: string; args: unknown }[], pending: { rows: [] as unknown[] } }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args: unknown) => {
    calls.push({ cmd, args });
    return cmd === "scaled_pending" ? pending.rows : null;
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
import { ScaledBuildCards, ScaledBuildDialog } from "./ScaledBuild";
import type { ScaleConfig, ScaledView } from "../lib/scaledBuild";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, host: HTMLDivElement;
beforeEach(() => { calls.length = 0; host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

const config: ScaleConfig = { scale: "auto", maxAgents: 8, tokenBudget: 5_000_000, timeBudgetMins: 240, leadModel: "sonnet", workerModel: null, scoutModel: "haiku", effort: null, verify: true, steer: null };
const base: ScaledView = {
  runId: "sb-1", planSessionId: "plan-1", config, startedAt: null, phase: { kind: "preflight" },
  limits: { agents: 8, tokens: 5_000_000, minutes: 240 }, usage: { agents: 0, tokens: 0, minutes: 0 },
  preflight: { name: "build-auth", description: "Build the auth rework", phases: ["Explore", "Build"], callSites: 3, dynamic: false,
    models: [["sonnet", 2], ["opus", 1]], estimate: { agents: 3, agentsExact: true, tokens: 900_000, minutes: 29 },
    warnings: ["1 agent call(s) use `opus`, which is outside this build's models (haiku, sonnet)."], script: "export const meta = {}" },
};
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === label);
const render = async (rows: unknown[], onIdle = () => {}) => {
  pending.rows = rows;
  await act(async () => root.render(<ScaledBuildCards nonce={1} onIdle={onIdle} onToast={() => {}} />));
};

describe("the team build pre-flight", () => {
  it("shows the estimate, the limits and the warnings, and Run allows it", async () => {
    await render([base]);
    const card = document.querySelector("[data-scaled-preflight]")!;
    expect(card.textContent).toContain("Estimate: ~3 agents · ~900k tokens · ~29 min");
    expect(card.textContent).toContain("Limits: 8 agents · 5M tokens · 4 h");
    expect(card.textContent).toContain("Explore → Build");
    expect(document.querySelector("[data-scaled-warnings]")!.textContent).toContain("`opus`");
    await act(async () => button("Run")!.click());
    expect(calls.find((c) => c.cmd === "scaled_preflight_decide")?.args).toEqual({ runId: "sb-1", decision: "run", note: null });
  });

  it("Edit sends the user's note; Later only hides the card", async () => {
    await render([base]);
    await act(async () => button("Edit…")!.click());
    expect(button("Send changes")!.disabled).toBe(true);
    const ta = document.querySelector<HTMLTextAreaElement>("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(ta, "use 2 agents");
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button("Send changes")!.click());
    expect(calls.find((c) => c.cmd === "scaled_preflight_decide")?.args).toEqual({ runId: "sb-1", decision: "edit", note: "use 2 agents" });

    calls.length = 0;
    await render([base]);
    await act(async () => button("Later")!.click());
    expect(calls.some((c) => c.cmd === "scaled_preflight_decide")).toBe(false);
    const pill = document.querySelector<HTMLButtonElement>("[data-scaled-pill]")!;
    expect(pill.textContent).toContain("Team build waiting for you");
    await act(async () => pill.click());
    expect(document.querySelector("[data-scaled-preflight]")).not.toBeNull();
  });

  it("asks Extend or Stop at a limit, previewing the new limit", async () => {
    await render([{ ...base, phase: { kind: "paused", reason: "agents" }, usage: { agents: 8, tokens: 2_000_000, minutes: 30 } }]);
    expect(document.querySelector("[data-scaled-pause]")!.textContent).toContain("8 of 8 agents started");
    const extend = document.querySelector<HTMLButtonElement>("[data-scaled-extend]")!;
    expect(extend.textContent).toBe("Extend to 12 agents");
    await act(async () => extend.click());
    expect(calls.find((c) => c.cmd === "scaled_pause_decide")?.args).toEqual({ runId: "sb-1", decision: "extend" });
    await act(async () => document.querySelector<HTMLButtonElement>("[data-scaled-stop]")!.click());
    expect(calls.filter((c) => c.cmd === "scaled_pause_decide").map((c) => (c.args as { decision: string }).decision)).toEqual(["extend", "stop"]);
  });

  it("goes idle when nothing is waiting", async () => {
    const onIdle = vi.fn();
    await render([], onIdle);
    expect(onIdle).toHaveBeenCalled();
    expect(document.querySelector("[data-scaled-preflight]")).toBeNull();
  });
});

describe("the Custom team build", () => {
  it("launches with the edited scale", async () => {
    const onLaunch = vi.fn();
    await act(async () => root.render(<ScaledBuildDialog defaults={config} onLaunch={onLaunch} onClose={() => {}} />));
    const agents = document.querySelector<HTMLInputElement>("#sb-agents")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(agents, "3");
      agents.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const worker = document.querySelector<HTMLSelectElement>("#sb-worker")!;
    await act(async () => {
      worker.value = "haiku";
      worker.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => document.querySelector<HTMLButtonElement>("[data-scaled-launch]")!.click());
    expect(onLaunch).toHaveBeenCalledWith({ ...config, scale: "custom", maxAgents: 3, workerModel: "haiku" });
  });
});
