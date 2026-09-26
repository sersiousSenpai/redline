import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

type SendBuilder = (text: string) => Promise<Record<string, unknown>>;
const mocks = vi.hoisted(() => ({ snapshot: vi.fn(), build: null as SendBuilder | null }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => []) }));
vi.mock("../lib/domSnapshot", () => ({ captureSnapshotOrCached: mocks.snapshot }));
vi.mock("../hooks/useAgentTurn", () => ({ useAgentTurn: (config: { buildSendArgs: SendBuilder }) => {
  mocks.build = config.buildSendArgs;
  return { messages: [], liveText: "", status: "idle", startedAt: null, loaded: true,
    send: vi.fn(), cancel: vi.fn(), unqueue: vi.fn(), clear: vi.fn(), meter: null, activity: null, meters: {} };
} }));
vi.mock("./MarkdownView", () => ({ MarkdownView: () => null }));
vi.mock("./StreamingBubble", () => ({ default: () => null }));
vi.mock("./TurnFooter", () => ({ default: () => null, ThreadMeterStrip: () => null }));
import { BrowserChat } from "./BrowserChat";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  localStorage.clear(); mocks.snapshot.mockReset(); mocks.build = null;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

it.each(["regular", "old-mission"])("keeps captured %s ownership while the same chat awaits a snapshot", async (workspaceId) => {
  let resolveSnapshot!: (value: string) => void;
  mocks.snapshot.mockReturnValue(new Promise<string>((resolve) => { resolveSnapshot = resolve; }));
  await act(async () => root.render(<BrowserChat browseId="same-thread" label="browser-old-page" workspaceId={workspaceId} onClose={() => {}}/>));
  const pending = mocks.build!("Read this page");
  // A mission can adopt the existing thread without changing its React key.
  await act(async () => root.render(<BrowserChat browseId="same-thread" label="browser-new-page" workspaceId="new-mission" onClose={() => {}}/>));
  resolveSnapshot("original page snapshot");
  await expect(pending).resolves.toMatchObject({ browseId: "same-thread", targetLabel: "browser-old-page", workspaceId, snapshot: "original page snapshot" });
  expect(mocks.snapshot).toHaveBeenCalledWith("browser-old-page");
});
