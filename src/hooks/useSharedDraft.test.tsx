import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { useSharedDraft } from "./useSharedDraft";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
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
