// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const toggleInto = vi.hoisted(() => vi.fn());
vi.mock("../audio/dictationHost", () => ({ toggleInto }));

import { setDictationLive, useDictation } from "./useDictation";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Mic({ name }: { name: string }) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const dictation = useDictation(ref);
  return (
    <div>
      <textarea ref={ref} aria-label={name} />
      <button type="button" aria-label={`mic ${name}`} data-hot={dictation.listening} onClick={dictation.toggle} />
    </div>
  );
}

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  setDictationLive(null);
});

describe("useDictation", () => {
  it("hands its own field to the dictation host, and lights only while that field is dictated into", async () => {
    await act(async () =>
      root.render(
        <>
          <Mic name="a" />
          <Mic name="b" />
        </>,
      ),
    );
    const field = (n: string) => host.querySelector(`textarea[aria-label="${n}"]`)!;
    const mic = (n: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="mic ${n}"]`)!;
    await act(async () => mic("a").click());
    expect(toggleInto).toHaveBeenCalledWith(field("a"));
    act(() => setDictationLive(field("a")));
    expect(mic("a").dataset.hot).toBe("true");
    expect(mic("b").dataset.hot).toBe("false");
    act(() => setDictationLive(null));
    expect(mic("a").dataset.hot).toBe("false");
  });
});
