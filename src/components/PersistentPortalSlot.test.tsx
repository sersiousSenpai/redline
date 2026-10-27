// SPDX-License-Identifier: Apache-2.0
import { act, useEffect } from "react";
import { createPortal } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBoundedPortalHost, PersistentPortalSlot } from "./PersistentPortalSlot";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement, host: HTMLDivElement, root: Root;
beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  host = createBoundedPortalHost("browser");
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

describe("persistent workspace portal containment", () => {
  it("removes browser chrome before the document paints and keeps the browser instance alive on return", async () => {
    let mounts = 0, unmounts = 0;
    function Browser() {
      useEffect(() => { mounts += 1; return () => { unmounts += 1; }; }, []);
      return <input aria-label="Browser address" defaultValue="https://example.test" />;
    }
    function Workspace({ browser }: { browser: boolean }) {
      return <>{browser ? <PersistentPortalSlot key="browser" name="browser" host={host} /> : <div data-front-door>Front Door</div>}{createPortal(<Browser />, host)}</>;
    }
    await act(async () => root.render(<Workspace browser />));
    const address = host.querySelector("input")!;
    address.value = "https://example.test/kept-page";
    expect(container.querySelector("[data-front-door]")).toBeNull();

    await act(async () => root.render(<Workspace browser={false} />));
    expect(container.textContent).toBe("Front Door");
    expect(container.querySelector("[data-portal-host]")).toBeNull();
    expect(host.parentElement).toBeNull();
    expect(unmounts).toBe(0);

    await act(async () => root.render(<Workspace browser />));
    expect(container.querySelector("[data-front-door]")).toBeNull();
    expect(container.querySelector("input")).toBe(address);
    expect(address.value).toBe("https://example.test/kept-page");
    expect(mounts).toBe(1);
  });

  it("moves an existing conversation between bounded slots without losing its composer", async () => {
    function Workspace({ side }: { side: "regular" | "browser" }) {
      return <><section>{side === "regular" && <PersistentPortalSlot name="regular" host={host} />}</section><aside>{side === "browser" && <PersistentPortalSlot name="browser" host={host} />}</aside>{createPortal(<textarea defaultValue="Unsent thought" />, host)}</>;
    }
    await act(async () => root.render(<Workspace side="regular" />));
    const textarea = host.querySelector("textarea");
    await act(async () => root.render(<Workspace side="browser" />));
    expect(container.querySelector("section")?.textContent).toBe("");
    expect(container.querySelector("aside textarea")).toBe(textarea);
    expect(host.style.position).toBe("absolute");
    expect(host.style.inset).toBe("0");
    expect(host.style.overflow).toBe("hidden");
    const slot = host.parentElement!;
    expect(slot.classList.contains("min-h-0")).toBe(true);
    expect(slot.classList.contains("min-w-0")).toBe(true);
    expect(slot.classList.contains("overflow-hidden")).toBe(true);
  });

  it("an inactive slot never takes the host, so a hidden kept tab cannot steal it from the showing one", async () => {
    function Workspace({ showing }: { showing: "a" | "b" | "none" }) {
      return <><section><PersistentPortalSlot name="a" host={host} active={showing === "a"} /></section><aside><PersistentPortalSlot name="b" host={host} active={showing === "b"} /></aside>{createPortal(<textarea defaultValue="Kept" />, host)}</>;
    }
    await act(async () => root.render(<Workspace showing="a" />));
    const textarea = host.querySelector("textarea");
    expect(container.querySelector("section textarea")).toBe(textarea);
    expect(container.querySelector("aside textarea")).toBeNull();
    // Inactive is invisible in the DOM: the slot renders exactly as before.
    expect(container.querySelector("aside [data-surface-slot]")?.attributes.length).toBe(container.querySelector("section [data-surface-slot]")?.attributes.length);

    await act(async () => root.render(<Workspace showing="b" />));
    expect(container.querySelector("aside textarea")).toBe(textarea);
    expect(container.querySelector("section textarea")).toBeNull();

    // Both inactive: the host is held by neither, and nothing unmounted.
    await act(async () => root.render(<Workspace showing="none" />));
    expect(host.parentElement).toBeNull();
    expect(host.querySelector("textarea")).toBe(textarea);
  });
});
