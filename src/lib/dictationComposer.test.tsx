// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { act, StrictMode, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const toggleInto = vi.hoisted(() => vi.fn());
vi.mock("../audio/dictationHost", () => ({ toggleInto }));

import { composerAt, fallbackComposer } from "../audio/dictationTarget";
import { composerGone, setDictationLive, useDictationComposer, type ComposerSpec } from "./dictationComposer";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Composer({ name, spec }: { name: string; spec: ComposerSpec }) {
  const frame = useRef<HTMLDivElement | null>(null);
  const field = useRef<HTMLTextAreaElement | null>(null);
  const dictation = useDictationComposer(frame, spec, field);
  return (
    <div ref={frame} aria-label={`frame ${name}`}>
      <input aria-label={`title ${name}`} />
      <textarea ref={field} aria-label={name} />
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

const q = <T extends Element>(sel: string) => host.querySelector<T>(sel)!;

describe("a composer's registration", () => {
  it("says how every field inside its frame takes dictation, and where the strip sits", async () => {
    await act(async () => root.render(<Composer name="a" spec={{ send: true, polish: true }} />));
    const found = composerAt(q('input[aria-label="title a"]'));
    expect(found?.frame).toBe(q('[aria-label="frame a"]'));
    expect(found?.spec).toEqual({ send: true, polish: true });
    // Its mic's field, not merely the first one in the frame.
    expect(found?.field).toBe(q('textarea[aria-label="a"]'));
    expect(composerAt(document.body)).toBeNull();
  });

  it("follows a spec that changes with the composer's state", async () => {
    await act(async () => root.render(<Composer name="a" spec={{ send: false }} />));
    await act(async () => root.render(<Composer name="a" spec={{ send: true }} />));
    expect(composerAt(q("textarea"))?.spec.send).toBe(true);
  });

  it("finds the box that takes what is said with nothing focused, while it shows", async () => {
    await act(async () => root.render(<Composer name="door" spec={{ fallback: false }} />));
    expect(fallbackComposer()).toBeNull();
    await act(async () => root.render(<Composer name="door" spec={{ fallback: true }} />));
    expect(fallbackComposer()?.field).toBe(q("textarea"));
  });

  it("stays registered through the development build's mount, unmount and mount again", async () => {
    await act(async () =>
      root.render(
        <StrictMode>
          <Composer name="a" spec={{ send: true }} />
        </StrictMode>,
      ),
    );
    expect(composerAt(q("textarea"))?.spec.send).toBe(true);
  });

  it("says when a composer goes, so a capture into it can stand down", async () => {
    const gone = vi.fn();
    composerGone.add(gone);
    await act(async () => root.render(<Composer name="card" spec={{}} />));
    const frame = q('[aria-label="frame card"]');
    await act(async () => root.render(<></>));
    composerGone.delete(gone);
    expect(gone).toHaveBeenCalledWith(frame);
    expect(composerAt(frame)).toBeNull();
  });
});

describe("a composer's mic", () => {
  it("hands its own field to the dictation host, and lights only while that composer is dictated into", async () => {
    await act(async () =>
      root.render(
        <>
          <Composer name="a" spec={{}} />
          <Composer name="b" spec={{}} />
        </>,
      ),
    );
    const mic = (n: string) => q<HTMLButtonElement>(`button[aria-label="mic ${n}"]`);
    await act(async () => mic("a").click());
    expect(toggleInto).toHaveBeenCalledWith(q('textarea[aria-label="a"]'));
    act(() => setDictationLive(q('textarea[aria-label="a"]')));
    expect(mic("a").dataset.hot).toBe("true");
    expect(mic("b").dataset.hot).toBe("false");
    act(() => setDictationLive(null));
    expect(mic("a").dataset.hot).toBe("false");
  });
});
