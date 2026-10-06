import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { useSync } from "./useSync";
import type { SyncCheck } from "../components/guided/types";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const result = (count: number): SyncCheck => ({
  incoming: [],
  incomingCount: count,
  outgoing: 0,
  overlaps: [],
  action: { commands: [], conflict: null, message: "Checked" },
});
it("a slow check cannot overwrite the newly selected workspace", async () => {
  let finishOld!: (value: SyncCheck) => void;
  vi.mocked(invoke).mockImplementation((_cmd, args) =>
    (args as { repo: string }).repo === "/old"
      ? new Promise((resolve) => {
          finishOld = resolve as typeof finishOld;
        })
      : Promise.resolve(result(2)),
  );
  let latest: ReturnType<typeof useSync> | undefined;
  function Harness({ repo }: { repo: string }) {
    latest = useSync(repo);
    return null;
  }
  const host = document.createElement("div"),
    root = createRoot(host);
  try {
    await act(async () => {
      root.render(createElement(Harness, { repo: "/old" }));
    });
    await act(async () => {
      root.render(createElement(Harness, { repo: "/new" }));
    });
    expect(latest?.check?.incomingCount).toBe(2);
    await act(async () => {
      finishOld(result(9));
    });
    expect(latest?.check?.incomingCount).toBe(2);
    expect(invoke).toHaveBeenCalledTimes(2);
  } finally {
    await act(async () => root.unmount());
  }
});
