// SPDX-License-Identifier: Apache-2.0
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useStableHandlers, useStableValue } from "./useStable";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
});

describe("useStableHandlers", () => {
  it("hands back the same wrappers every render, each calling the newest handler", async () => {
    const seen: string[] = [];
    let handlers: { onSelect: (id: string) => void } | null = null;
    function Shell({ label }: { label: string }) {
      handlers = useStableHandlers({ onSelect: (id: string) => seen.push(`${label}:${id}`) });
      return null;
    }
    await act(async () => root.render(<Shell label="first" />));
    const first = handlers!;
    await act(async () => root.render(<Shell label="second" />));
    expect(handlers).toBe(first);
    first.onSelect("a");
    expect(seen).toEqual(["second:a"]);
  });
});

describe("useStableValue", () => {
  it("keeps the previous value while a re-derived one equals it", async () => {
    let value: ReadonlySet<string> | null = null;
    function Shell({ ids }: { ids: string[] }) {
      value = useStableValue(new Set(ids));
      return null;
    }
    await act(async () => root.render(<Shell ids={["t1", "t2"]} />));
    const first = value;
    await act(async () => root.render(<Shell ids={["t2", "t1"]} />));
    expect(value).toBe(first);
    await act(async () => root.render(<Shell ids={["t1"]} />));
    expect(value).not.toBe(first);
    expect([...value!]).toEqual(["t1"]);
  });
});
