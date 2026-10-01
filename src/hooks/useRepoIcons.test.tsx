import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useRepoIcons } from "./useRepoIcons";
import type { RepoIconResult } from "../lib/repoIcon";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("shares an in-flight logo with every consumer, including after the requester unmounts", async () => {
  const path = "/projects/shared-repo-logo";
  let resolve!: (icon: RepoIconResult) => void;
  mocks.invoke.mockReturnValue(new Promise<RepoIconResult>((done) => { resolve = done; }));
  function Consumer({ name }: { name: string }) {
    const icons = useRepoIcons([path]);
    return <span data-consumer={name}>{icons.get(path)?.dataUrl ?? "pending"}</span>;
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<><Consumer key="terminal" name="terminal" /><Consumer key="localhost" name="localhost" /></>));
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    await act(async () => root.render(<><Consumer key="localhost" name="localhost" /></>));
    await act(async () => resolve({ root: path, name: "shared", dataUrl: "data:image/png;base64,logo" }));
    expect(container.textContent).toBe("data:image/png;base64,logo");
    await act(async () => root.render(<><Consumer key="terminal" name="terminal" /><Consumer key="localhost" name="localhost" /></>));
    expect([...container.querySelectorAll("span")].map((el) => el.textContent)).toEqual(["data:image/png;base64,logo", "data:image/png;base64,logo"]);
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});
