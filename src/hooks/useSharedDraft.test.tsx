import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { readSharedDraft, useSharedDraft, writeSharedDraft } from "./useSharedDraft";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
it("shares draft updates between an inline anchor and island, including remounts", async () => {
  const key = "test-shared-thread"; localStorage.setItem(key, JSON.stringify("First thought"));
  const host=document.createElement("div"); document.body.append(host); const root=createRoot(host);
  function Editor({ name }: { name: string }) { const [draft,setDraft]=useSharedDraft(key); return <button data-name={name} onClick={() => setDraft(value => `${value} · continued`)}>{draft}</button>; }
  await act(async () => root.render(<><Editor name="inline"/><Editor name="island"/></>));
  await act(async () => host.querySelector<HTMLButtonElement>('[data-name="island"]')!.click());
  expect([...host.querySelectorAll("button")].map(button=>button.textContent)).toEqual(["First thought · continued","First thought · continued"]);
  await act(async () => root.render(<Editor name="returning"/>));
  expect(host.textContent).toBe("First thought · continued");
  await act(async () => root.unmount()); host.remove(); localStorage.removeItem(key);
});
// A keystroke used to JSON.parse the stored draft on every snapshot read and
// setItem it synchronously. Memory answers now, and the disk trails the typing.
it("reads every keystroke from memory and writes the disk once the typing pauses", async () => {
  window.dispatchEvent(new Event("pagehide")); // settle the test above
  vi.useFakeTimers();
  const key = "test-debounced-thread"; localStorage.setItem(key, JSON.stringify("Wh"));
  const getItem = vi.spyOn(Storage.prototype, "getItem"), setItem = vi.spyOn(Storage.prototype, "setItem");
  const host=document.createElement("div"); document.body.append(host); const root=createRoot(host);
  function Editor() { const [draft]=useSharedDraft(key); return <output>{draft}</output>; }
  await act(async () => root.render(<Editor/>));
  for (const draft of ["Why", "Why t", "Why there?"]) await act(async () => writeSharedDraft(key, draft));
  expect(host.textContent).toBe("Why there?");
  expect(getItem.mock.calls.filter(([read]) => read === key)).toHaveLength(1);
  expect(setItem).not.toHaveBeenCalled();
  await act(async () => { vi.advanceTimersByTime(299); });
  expect(setItem).not.toHaveBeenCalled();
  await act(async () => { vi.advanceTimersByTime(1); });
  expect(setItem.mock.calls).toEqual([[key, JSON.stringify("Why there?")]]);
  await act(async () => root.unmount()); host.remove(); localStorage.removeItem(key);
});
it("lands a pending write on pagehide, so a reload finds the last keystroke", () => {
  const key = "test-reloaded-thread";
  writeSharedDraft(key, "the very last words");
  expect(localStorage.getItem(key)).toBeNull();
  window.dispatchEvent(new Event("pagehide"));
  expect(localStorage.getItem(key)).toBe(JSON.stringify("the very last words"));
  localStorage.removeItem(key);
});
it("takes another window's newer write to a draft this one is showing", async () => {
  const key = "test-other-window";
  const host=document.createElement("div"); document.body.append(host); const root=createRoot(host);
  function Editor() { const [draft]=useSharedDraft(key); return <output>{draft}</output>; }
  await act(async () => root.render(<Editor/>));
  await act(async () => writeSharedDraft(key, "mine"));
  const theirs = JSON.stringify("theirs");
  localStorage.setItem(key, theirs);
  await act(async () => window.dispatchEvent(new StorageEvent("storage", { key, newValue: theirs })));
  expect(host.textContent).toBe("theirs");
  expect(readSharedDraft(key)).toBe("theirs");
  // Their write is the newest; ours must not land on top of it later.
  window.dispatchEvent(new Event("pagehide"));
  expect(localStorage.getItem(key)).toBe(theirs);
  await act(async () => root.unmount()); host.remove(); localStorage.removeItem(key);
});
