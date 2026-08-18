// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

// The agent shelf (harness program A3): the non-coder's path — list, build,
// preview-on-a-copy, run — over the A2 `harness_agent_*` commands. These
// tests pin the wiring that path depends on: the live markdown rides every
// run (the mirror-flush contract `draft_instruct` set), the preview collects
// its copy's events and DISCARDS the copy, and nothing here ever applies an
// edit itself.

const AGENTS = [
  {
    agentId: "ha-1",
    name: "Header tightener",
    instruction: "Tighten every heading to five words.",
    folderId: null,
    starred: false,
    createdAt: 1,
    updatedAt: 3,
    lastRunAt: null,
    runCount: 0,
  },
  {
    agentId: "ha-2",
    name: "Test checker",
    instruction: "Flag sections without a test plan.",
    folderId: null,
    starred: true,
    createdAt: 2,
    updatedAt: 2,
    lastRunAt: 1,
    runCount: 3,
  },
];

const invoked: { cmd: string; args: Record<string, unknown> }[] = [];
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string, args: Record<string, unknown>) => {
    invoked.push({ cmd, args: args ?? {} });
    if (cmd === "harness_agent_list") return Promise.resolve(AGENTS);
    if (cmd === "bookshelf_list")
      return Promise.resolve({ folders: [], drafts: [] });
    if (cmd === "harness_agent_preview") return Promise.resolve("preview-77");
    if (cmd === "harness_agent_create")
      return Promise.resolve({ ...AGENTS[0], agentId: "ha-new" });
    return Promise.resolve(null);
  }),
}));

// Captured event subscriptions, fireable from tests.
type Handler = (e: { payload: unknown }) => void;
const handlers = new Map<string, Handler[]>();
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((name: string, cb: Handler) => {
    const list = handlers.get(name) ?? [];
    list.push(cb);
    handlers.set(name, list);
    return Promise.resolve(() => {
      const cur = handlers.get(name) ?? [];
      handlers.set(
        name,
        cur.filter((h) => h !== cb),
      );
    });
  }),
}));

const fire = (name: string, payload: unknown) => {
  for (const h of handlers.get(name) ?? []) h({ payload });
};

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

import { AgentShelf } from "./AgentShelf";

const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  invoked.length = 0;
  handlers.clear();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.clearAllMocks();
});

const button = (name: string) =>
  [...host.querySelectorAll("button")].find(
    (b) =>
      b.getAttribute("title") === name ||
      b.getAttribute("aria-label") === name ||
      b.textContent?.trim() === name,
  );

const type = (el: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  const proto =
    el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
};

function mount(over: Partial<Parameters<typeof AgentShelf>[0]> = {}) {
  return act(async () => {
    root.render(
      createElement(AgentShelf, {
        draftId: "d-1",
        projectPath: "/proj",
        getLiveMarkdown: () => "# Live doc",
        onRunStarted: () => {},
        onClose: () => {},
        ...over,
      }),
    );
  });
}

describe("AgentShelf — the list", () => {
  it("renders the shelf starred-first and runs with the LIVE markdown", async () => {
    const onRunStarted = vi.fn();
    await mount({ onRunStarted });
    await flush();

    const text = host.textContent ?? "";
    expect(text).toContain("Header tightener");
    expect(text).toContain("Test checker");
    // Starred sorts first even though the other row updated later.
    expect(text.indexOf("Test checker")).toBeLessThan(
      text.indexOf("Header tightener"),
    );

    const runs = [...host.querySelectorAll("button")].filter(
      (b) => b.textContent?.trim() === "Run",
    );
    await act(async () => runs[0]?.click());
    await flush();

    const call = invoked.find((c) => c.cmd === "harness_agent_run");
    expect(call, "run never reached the backend").toBeDefined();
    expect(call!.args.agentId).toBe("ha-2");
    expect(call!.args.draftId).toBe("d-1");
    expect(call!.args.draftMarkdown, "the live mirror must ride the run").toBe(
      "# Live doc",
    );
    expect(call!.args.projectPath).toBe("/proj");
    expect(onRunStarted).toHaveBeenCalledWith("Test checker");
  });

  it("delete asks first, then deletes", async () => {
    await mount();
    await flush();
    await act(async () => button("Delete this agent")?.click());
    await flush();
    expect(invoked.some((c) => c.cmd === "harness_agent_delete")).toBe(false);
    expect(host.textContent).toContain("Delete this agent?");
    await act(async () => button("Delete")?.click());
    await flush();
    expect(invoked.some((c) => c.cmd === "harness_agent_delete")).toBe(true);
  });
});

describe("AgentShelf — the builder", () => {
  it("creates from plain English, and previews on a copy it later discards", async () => {
    await mount();
    await flush();
    await act(async () => button("New agent")?.click());
    await flush();

    // Save is gated until both fields hold words.
    const save = button("Save to shelf") as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    const inputs = host.querySelectorAll("input");
    const name = [...inputs].find((i) =>
      i.getAttribute("placeholder")?.includes("Header"),
    ) as HTMLInputElement;
    const instruction = host.querySelector("textarea") as HTMLTextAreaElement;
    await act(async () => {
      type(name, "Checklist adder");
      type(instruction, "Add a checklist of open questions at the end.");
    });
    await flush();

    // Preview: runs against a COPY, collects that copy's events only.
    await act(async () =>
      (button("Preview on a copy") ?? button("Previewing…"))?.click(),
    );
    await flush();
    const prev = invoked.find((c) => c.cmd === "harness_agent_preview");
    expect(prev, "preview never reached the backend").toBeDefined();
    expect(prev!.args.draftId).toBe("d-1");
    expect(prev!.args.draftMarkdown).toBe("# Live doc");
    expect(prev!.args.name).toBe("Checklist adder");

    await act(async () => {
      fire("drafter-suggestion", {
        id: "s-1",
        draftId: "preview-77",
        op: "append",
        blockId: null,
        original: null,
        markdown: "## Open questions",
        agentId: "shelf:preview-77",
        body: "Added the checklist.",
        status: "pending",
        createdAt: 1,
      });
      // A different draft's suggestion must not leak into the rehearsal.
      fire("drafter-suggestion", {
        id: "s-x",
        draftId: "d-other",
        op: "append",
        blockId: null,
        original: null,
        markdown: "noise",
        agentId: null,
        body: null,
        status: "pending",
        createdAt: 1,
      });
      fire("draft-chat-done", {
        draftId: "preview-77",
        body: "Appended one checklist section.",
      });
    });
    await flush();

    const text = host.textContent ?? "";
    expect(text).toContain("It would make 1 edit");
    expect(text).toContain("Open questions");
    expect(text).not.toContain("noise");
    expect(text).toContain("Appended one checklist section.");

    // Saving keeps the agent and throws the rehearsal copy away.
    await act(async () => (button("Save to shelf") as HTMLButtonElement).click());
    await flush();
    const create = invoked.find((c) => c.cmd === "harness_agent_create");
    expect(create).toBeDefined();
    expect(create!.args.instruction).toBe(
      "Add a checklist of open questions at the end.",
    );
    const discard = invoked.find((c) => c.cmd === "harness_preview_discard");
    expect(discard, "the preview copy must be discarded").toBeDefined();
    expect(discard!.args.previewId).toBe("preview-77");
  });

  it("cancel discards a live preview copy too", async () => {
    await mount();
    await flush();
    await act(async () => button("New agent")?.click());
    await flush();
    const inputs = host.querySelectorAll("input");
    const name = [...inputs].find((i) =>
      i.getAttribute("placeholder")?.includes("Header"),
    ) as HTMLInputElement;
    const instruction = host.querySelector("textarea") as HTMLTextAreaElement;
    await act(async () => {
      type(name, "X");
      type(instruction, "Do a thing.");
    });
    await flush();
    await act(async () => button("Preview on a copy")?.click());
    await flush();
    await act(async () => button("Cancel")?.click());
    await flush();
    expect(
      invoked.find((c) => c.cmd === "harness_preview_discard")?.args.previewId,
    ).toBe("preview-77");
  });
});
