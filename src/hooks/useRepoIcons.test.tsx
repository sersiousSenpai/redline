import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { MAX_REPO_DIRS, useRepoIcons } from "./useRepoIcons";
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

function Icons({ cwds, onIcons }: { cwds: string[]; onIcons: (icons: Map<string, RepoIconResult>) => void }) {
  onIcons(useRepoIcons(cwds));
  return null;
}

it("keeps one copy of a repo's mark however many of its directories ask", async () => {
  // Each answer is a distinct object, as each decoded IPC response is.
  mocks.invoke.mockImplementation(async () => ({
    root: "/projects/one-copy",
    name: "one-copy",
    dataUrl: `data:image/png;base64,${"logo".repeat(4)}`,
  }));
  const dirs = ["/projects/one-copy", "/projects/one-copy/src", "/projects/one-copy/src/lib"];
  let icons = new Map<string, RepoIconResult>();
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Icons cwds={dirs} onIcons={(next) => { icons = next; }} />));
    const [first, ...rest] = dirs.map((dir) => icons.get(dir));
    expect(first?.dataUrl).toContain("logo");
    for (const other of rest) expect(other).toBe(first);
  } finally {
    act(() => root.unmount());
  }
});

it("forgets the earliest directories past the cap, never one a tab is showing", async () => {
  mocks.invoke.mockImplementation(async (_cmd: string, args: { cwd: string }) => ({
    root: args.cwd.split("/").slice(0, 3).join("/"),
    name: "walk",
    dataUrl: null,
  }));
  let icons = new Map<string, RepoIconResult>();
  const record = (next: Map<string, RepoIconResult>) => { icons = next; };
  const pinned = document.createElement("div");
  const walker = document.createElement("div");
  const pinnedRoot = createRoot(pinned);
  const walkerRoot = createRoot(walker);
  try {
    // One tab sits in a directory the whole time; another wanders.
    await act(async () => pinnedRoot.render(<Icons cwds={["/walk/home/stays"]} onIcons={() => {}} />));
    for (let i = 0; i < MAX_REPO_DIRS + 40; i++) {
      await act(async () => walkerRoot.render(<Icons cwds={[`/walk/r${i % 3}/dir${i}`]} onIcons={record} />));
    }
    expect(icons.size).toBe(MAX_REPO_DIRS);
    expect(icons.has("/walk/home/stays")).toBe(true);
    expect(icons.has("/walk/r0/dir0")).toBe(false);
    const last = MAX_REPO_DIRS + 39;
    expect(icons.has(`/walk/r${last % 3}/dir${last}`)).toBe(true);
    // Coming back to a forgotten directory asks again.
    const asked = mocks.invoke.mock.calls.length;
    await act(async () => walkerRoot.render(<Icons cwds={["/walk/r0/dir0"]} onIcons={record} />));
    expect(mocks.invoke.mock.calls.length).toBe(asked + 1);
    expect(icons.has("/walk/r0/dir0")).toBe(true);
  } finally {
    act(() => pinnedRoot.unmount());
    act(() => walkerRoot.unmount());
  }
});
