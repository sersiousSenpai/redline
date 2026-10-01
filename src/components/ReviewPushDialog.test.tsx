// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CommitDraft } from "../types";
import type { UsePush } from "../hooks/usePush";
import ReviewPushDialog from "./ReviewPushDialog";

vi.mock("./menuOverlay", () => ({ useMenuOverlay: () => {} }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let push: UsePush;
const draft: CommitDraft = {
  subject: "Update reviewed files", body: "", branch: "update-reviewed-files",
  prTitle: "Update reviewed files", prBody: "Update reviewed files",
  notice: "AI took too long. Used a basic draft from the changed filenames.",
};
const render = (open = true, reviewId = "review-1") => act(async () => {
  root.render(<ReviewPushDialog open={open} onClose={() => {}} repo="/repo"
    reviewId={reviewId} push={push} branches={null} reviewedPaths={["x.rs"]} />);
});
const clickDraft = () => act(async () => {
  host.querySelector<HTMLButtonElement>('button[title^="Quick AI"]')!.click();
});
const message = () => host.querySelector<HTMLTextAreaElement>(".rl-push-textarea")!;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  push = {
    status: null, lastPush: null, pushing: false, log: [], outcome: null, error: null,
    drafting: false, refreshStatus: vi.fn(), push: vi.fn(), draft: vi.fn(), clearResult: vi.fn(),
  };
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

it("shows an editable fallback and explains its origin", async () => {
  vi.mocked(push.draft).mockResolvedValue(draft);
  await render();
  await clickDraft();
  expect(message().value).toBe(draft.subject);
  expect(message().disabled).toBe(false);
  expect(host.querySelector('[role="status"]')?.textContent).toBe(draft.notice);
  expect(push.push).not.toHaveBeenCalled();
});

it("clears the fallback notice after a successful AI retry", async () => {
  vi.mocked(push.draft).mockResolvedValueOnce(draft).mockResolvedValueOnce({ ...draft, notice: undefined });
  await render();
  await clickDraft();
  await clickDraft();
  expect(host.querySelector('[role="status"]')).toBeNull();
});

it("keeps the user's edits when the draft arrives later", async () => {
  let resolve!: (value: CommitDraft) => void;
  vi.mocked(push.draft).mockReturnValue(new Promise(done => { resolve = done; }));
  await render();
  await clickDraft();
  await act(async () => {
    const textarea = message();
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "My own commit");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => resolve(draft));
  expect(message().value).toBe("My own commit");
  expect(host.querySelector('[role="status"]')).toBeNull();
});

it.each(["reopen", "switch review"])("ignores an old result after %s", async (action) => {
  let resolve!: (value: CommitDraft) => void;
  vi.mocked(push.draft).mockReturnValue(new Promise(done => { resolve = done; }));
  await render();
  await clickDraft();
  if (action === "reopen") {
    await render(false);
    await render();
  } else {
    await render(true, "review-2");
  }
  await act(async () => resolve(draft));
  expect(message().value).toBe("");
  expect(host.querySelector('[role="status"]')).toBeNull();
});
