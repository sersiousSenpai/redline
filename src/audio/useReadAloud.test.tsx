// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// A chat's read-aloud warms Kokoro only on intent — a hover or a press on its
// control, or a reply starting while it is on — and never starts the one-time
// fp32 upgrade, a 325 MB download that only the voice panel and its settings
// may begin. Every chat mount used to warm it, and so could start that
// download from a conversation that never spoke.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { calls, settings } = vi.hoisted(() => ({
  calls: [] as Array<[string, unknown]>,
  settings: { engine: "kokoro" },
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args?: unknown) => {
    calls.push([cmd, args]);
    return cmd === "tts_get_settings" ? settings : null;
  }),
}));
vi.mock("./cloudTts", () => ({ cloudTtsDriver: () => ({ speak: () => {}, cancel: () => {} }) }));
vi.mock("./speech", async (original) => ({
  ...(await original<typeof import("./speech")>()),
  // The queue speaks through drivers this test has no use for.
  SpeechQueue: class {
    setPrefs() {}
    setDriver() {}
    cancel() {}
    primeTurn() {}
    enqueue() {}
    flush() {}
  },
}));

import { useReadAloud, type ReadAloud } from "./useReadAloud";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, host: HTMLDivElement, hook: ReadAloud;
function Chat(props: { enabled: boolean; streaming: boolean }) {
  hook = useReadAloud({ ...props, liveText: "", threadKey: "chat-1" });
  return null;
}
const render = (props: { enabled: boolean; streaming: boolean }) => act(async () => root.render(<Chat {...props} />));
const warms = () => calls.filter(([cmd]) => cmd === "tts_kokoro_warm");

beforeEach(() => {
  calls.length = 0;
  settings.engine = "kokoro";
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("a chat's read-aloud", () => {
  it("never warms the engine because a chat mounted, read-aloud on or off", async () => {
    await render({ enabled: false, streaming: false });
    await render({ enabled: true, streaming: false });
    expect(calls.map(([cmd]) => cmd)).toEqual(["tts_get_settings"]);
  });

  it("warms on intent, without the model upgrade", async () => {
    await render({ enabled: false, streaming: false });
    act(() => hook.warm());
    expect(warms()).toEqual([["tts_kokoro_warm", { upgrade: false }]]);
  });

  it("warms when a reply starts with reading aloud on, and not when it is off", async () => {
    await render({ enabled: false, streaming: false });
    await render({ enabled: false, streaming: true });
    expect(warms()).toEqual([]);
    await render({ enabled: true, streaming: false });
    await render({ enabled: true, streaming: true });
    expect(warms()).toEqual([["tts_kokoro_warm", { upgrade: false }]]);
  });

  it("has nothing to warm on the system voice", async () => {
    settings.engine = "system";
    await render({ enabled: true, streaming: false });
    act(() => hook.warm());
    expect(warms()).toEqual([]);
  });

  it("leaves the upgrade to the voice panel and its settings", () => {
    const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");
    // The backend upgrades unless a caller says not to…
    expect(read("src-tauri/src/tts.rs")).toContain("if upgrade.unwrap_or(true) && tts.needs_model_upgrade()");
    // …the voice panel's warms (open, and the engine picked in its settings)
    // do not say so, and no chat surface warms on its own.
    const panel = read("src/components/VoicePanel.tsx");
    expect(panel.match(/invoke\("tts_kokoro_warm"\)/g)).toHaveLength(2);
    for (const chat of ["src/components/ChatRoom.tsx", "src/components/BrowserChat.tsx"]) expect(read(chat)).not.toContain("tts_kokoro_warm");
  });
});
