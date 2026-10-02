// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { downloadToast, isDurableTabUrl } from "./browserOutput";

describe("isDurableTabUrl", () => {
  it("persists only http(s) addresses from the URL poll", () => {
    expect(isDurableTabUrl("https://arxiv.org/pdf/2401.00001")).toBe(true);
    expect(isDurableTabUrl("http://localhost:3000/")).toBe(true);
    expect(isDurableTabUrl("blob:https://example.com/3f2a")).toBe(false);
    expect(isDurableTabUrl("data:application/pdf;base64,JVBERi0=")).toBe(false);
    expect(isDurableTabUrl("file:///Users/me/x.pdf")).toBe(false);
    expect(isDurableTabUrl("about:blank")).toBe(false);
  });

  it("is what BrowserPane's URL poll gates on, and tabs are only built natively", () => {
    const pane = readFileSync(join(__dirname, "../components/BrowserPane.tsx"), "utf8");
    expect(pane).toContain("if (!isDurableTabUrl(url))");
    // The JS constructor can't carry the download handler.
    expect(pane).not.toMatch(/new Webview\(/);
    expect(pane).toContain('invoke("browser_create_tab"');
  });
});

describe("downloadToast", () => {
  const opener = () => {
    const o = { openPath: vi.fn(async () => {}), revealItemInDir: vi.fn(async () => {}) };
    return { o, load: () => Promise.resolve(o) };
  };

  it("offers Open and Show in Finder on the saved file", async () => {
    const { o, load } = opener();
    const toast = downloadToast({ label: "browser-t1", url: "https://x.test/a.zip", path: "/Users/me/Downloads/a (1).zip", name: "a (1).zip", success: true }, load);
    expect(toast.message).toBe("a (1).zip saved to Downloads");
    expect(toast.placement).toBe("top");
    expect(toast.action?.label).toBe("Open");
    expect(toast.secondaryAction?.label).toBe("Show in Finder");
    toast.action!.onAction();
    toast.secondaryAction!.onAction();
    await Promise.resolve(); await Promise.resolve();
    expect(o.openPath).toHaveBeenCalledWith("/Users/me/Downloads/a (1).zip");
    expect(o.revealItemInDir).toHaveBeenCalledWith("/Users/me/Downloads/a (1).zip");
  });

  it("reports a failure without actions", () => {
    const toast = downloadToast({ label: "browser-t1", url: "https://x.test/a.zip", path: null, name: "a.zip", success: false });
    expect(toast).toMatchObject({ message: "Couldn't download a.zip", tone: "warning" });
    expect(toast.action).toBeUndefined();
    expect(toast.secondaryAction).toBeUndefined();
  });
});
