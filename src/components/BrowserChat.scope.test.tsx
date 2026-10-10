import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

type SendBuilder = (text: string) => Promise<Record<string, unknown>>;
const mocks = vi.hoisted(() => ({ snapshot: vi.fn(), build: null as SendBuilder | null }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => []) }));
vi.mock("../lib/domSnapshot", () => ({ captureSnapshotOrCached: mocks.snapshot }));
vi.mock("../hooks/useAgentTurn", () => ({ useAgentTurn: (config: { buildSendArgs: SendBuilder }) => {
  mocks.build = config.buildSendArgs;
  return { messages: [], queue: [], liveText: "", status: "idle", startedAt: null, loaded: true,
    send: vi.fn(), cancel: vi.fn(), unqueue: vi.fn(), clear: vi.fn(), meter: null, activity: null, meters: {} };
} }));
vi.mock("./MarkdownView", () => ({ MarkdownView: () => null }));
vi.mock("./StreamingText", () => ({ StreamingText: () => null }));
vi.mock("../lib/useDictation", () => ({ useDictation: () => ({ listening: false, partial: "", error: null, toggle: () => {} }) }));
import { BrowserChat } from "./BrowserChat";
import type { ResolvedConversation } from "../lib/browserChat/scope";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  localStorage.clear(); mocks.snapshot.mockReset(); mocks.build = null;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

const onPage = (targetLabel: string): ResolvedConversation => ({
  kind: "shared", browseId: "same-thread", title: "Browser chat", targetLabel, targetTitle: "Page", targetNumber: 1,
  scope: "following-tabs", anchoredFrom: null, exception: false,
});

// A Mosaic, like regular browsing, has no mission (BC-13): it goes out as "regular".
it.each([["regular", "regular"], ["old-mission", "old-mission"], ["mosaic:grid", "regular"]])("keeps captured %s ownership while the same chat awaits a snapshot", async (workspace, workspaceId) => {
  let resolveSnapshot!: (value: string) => void;
  mocks.snapshot.mockReturnValue(new Promise<string>((resolve) => { resolveSnapshot = resolve; }));
  await act(async () => root.render(<BrowserChat conversation={onPage("browser-old-page")} workspace={workspace} onClose={() => {}}/>));
  const pending = mocks.build!("Read this page");
  // A mission can adopt the existing thread without changing its React key.
  await act(async () => root.render(<BrowserChat conversation={onPage("browser-new-page")} workspace="new-mission" onClose={() => {}}/>));
  resolveSnapshot("original page snapshot");
  await expect(pending).resolves.toEqual({ browseId: "same-thread", text: "Read this page", targetLabel: "browser-old-page", followingTabs: true, workspaceId, cwd: null, snapshot: "original page snapshot" });
  expect(mocks.snapshot).toHaveBeenCalledWith("browser-old-page");
});
