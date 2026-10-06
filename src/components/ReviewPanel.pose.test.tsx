import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UseReview } from "../hooks/useReview";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("./git/GitRepositoryView", () => ({
  default: ({ repo }: { repo: string }) => <div data-testid="repository-view">{repo}</div>,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const KEY = "redline.reviewPose";
let root: Root;
let host: HTMLDivElement;

function review(overrides: Partial<UseReview> = {}): UseReview {
  const noop = vi.fn(async () => {});
  return {
    activeReviewId: null, review: null, repo: "/code/demo", source: "uncommitted", base: null, sha: null,
    diff: [], commits: [], annotations: [], viewed: new Set<string>(), loading: false, error: null, stale: false,
    getFingerprint: () => "", holdActive: false, submitReview: noop, dismissReview: noop, setSource: vi.fn(),
    setBase: vi.fn(), setSha: vi.fn(), openReview: noop, refreshDiff: noop, toggleViewed: noop,
    addAnnotation: noop, updateAnnotation: noop, deleteAnnotation: noop, questions: [], addQuestion: noop, deleteQuestion: noop,
    ...overrides,
  } as unknown as UseReview;
}

async function load() {
  vi.resetModules();
  const pose = await import("../hooks/useReviewPose");
  const { default: ReviewPanel } = await import("./ReviewPanel");
  return { pose, ReviewPanel };
}
async function flush() {
  for (let i = 0; i < 4; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}
const seg = (label: string) =>
  [...host.querySelectorAll<HTMLButtonElement>('[aria-label="Code review view"] button')].find((b) => b.textContent === label)!;

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (command: string) => (command === "get_ui_prefs" ? {} : null));
  localStorage.clear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("Code Review pose toggle", () => {
  it("switches Review ⇄ Repository, persists it, and syncs the ui pref", async () => {
    const { ReviewPanel } = await load();
    await act(async () => root.render(<ReviewPanel review={review()} projectOptions={[]} onClose={() => {}} />));
    await flush();
    expect(seg("Review").getAttribute("aria-pressed")).toBe("true");
    expect(host.querySelector('[aria-label="Diff source"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="repository-view"]')).toBeNull();

    await act(async () => seg("Repository").click());
    await flush();
    expect(host.querySelector('[data-testid="repository-view"]')?.textContent).toBe("/code/demo");
    expect(host.querySelector('[aria-label="Diff source"]')).toBeNull();
    // the repo picker keeps working in the Repository pose
    expect(host.querySelector('select[aria-label="Repository"]')).not.toBeNull();
    expect(JSON.parse(localStorage.getItem(KEY)!)).toBe("repository");
    expect(invokeMock).toHaveBeenCalledWith("set_ui_pref", { key: "reviewPose", value: "repository" });

    await act(async () => seg("Review").click());
    await flush();
    expect(host.querySelector('[data-testid="repository-view"]')).toBeNull();
    expect(JSON.parse(localStorage.getItem(KEY)!)).toBe("review");
  });

  it("migrates a stored Guided/Expert pose to Review", async () => {
    localStorage.setItem(KEY, JSON.stringify("guided"));
    const { pose } = await load();
    expect(pose.normalizeReviewPose("expert")).toBe("review");
    const { ReviewPanel } = await load();
    await act(async () => root.render(<ReviewPanel review={review()} projectOptions={[]} onClose={() => {}} />));
    await flush();
    expect(seg("Review").getAttribute("aria-pressed")).toBe("true");
    expect(JSON.parse(localStorage.getItem(KEY)!)).toBe("review");
  });

  it("restores a remembered Repository pose", async () => {
    localStorage.setItem(KEY, JSON.stringify("repository"));
    const { ReviewPanel } = await load();
    await act(async () => root.render(<ReviewPanel review={review()} projectOptions={[]} onClose={() => {}} />));
    await flush();
    expect(host.querySelector('[data-testid="repository-view"]')).not.toBeNull();
  });

  it("a held review request forces the Review pose", async () => {
    localStorage.setItem(KEY, JSON.stringify("repository"));
    const { ReviewPanel } = await load();
    await act(async () => root.render(<ReviewPanel review={review()} projectOptions={[]} onClose={() => {}} />));
    await flush();
    expect(host.querySelector('[data-testid="repository-view"]')).not.toBeNull();
    await act(async () => root.render(<ReviewPanel review={review({ holdActive: true, activeReviewId: "r1" })} projectOptions={[]} onClose={() => {}} />));
    await flush();
    expect(host.querySelector('[data-testid="repository-view"]')).toBeNull();
    expect(seg("Review").getAttribute("aria-pressed")).toBe("true");
    expect(host.textContent).toContain("Approve");
  });
});
