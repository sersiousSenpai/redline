// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
const shim = readFileSync("src-tauri/src/browser_fullscreen.js", "utf8");
const page = window as unknown as Record<string, any>;
const originalMode = vi.fn();
beforeAll(() => {
  (HTMLVideoElement.prototype as unknown as Record<string, any>).webkitSetPresentationMode = originalMode;
  window.eval(shim);
});
beforeEach(() => { vi.useFakeTimers(); originalMode.mockClear(); document.body.innerHTML = '<div id="ancestor"><div id="player"></div><video controls></video></div>'; });
afterEach(() => { page.__redline_fs_exit(); document.body.innerHTML = ""; vi.useRealTimers(); vi.restoreAllMocks(); });
describe("fullscreen shim", () => {
  it("pins a player, exposes standard and legacy getters, and bubbles events from it", async () => {
    const player = document.querySelector<HTMLElement>("#player")!;
    const events: EventTarget[] = [];
    const listener = (event: Event) => events.push(event.target!);
    document.addEventListener("fullscreenchange", listener);
    await player.requestFullscreen();
    expect(document.fullscreenElement).toBe(player);
    expect((document as unknown as Record<string, any>).webkitCurrentFullScreenElement).toBe(player);
    expect((document as unknown as Record<string, any>).webkitIsFullScreen).toBe(true);
    expect(page.__redline_fs).toBe(true);
    expect(document.documentElement.classList.contains("__redline_fs_on")).toBe(true);
    await document.exitFullscreen();
    document.removeEventListener("fullscreenchange", listener);
    expect(events).toEqual([player, player]);
    expect(document.fullscreenElement).toBeNull(); expect(page.__redline_fs).toBe(false);
  });
  it("captures Escape before page handlers and clears the force-exit state", async () => {
    await document.querySelector<HTMLElement>("#player")!.requestFullscreen();
    const handler = vi.fn(); document.addEventListener("keydown", handler, true);
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    document.dispatchEvent(escape); document.removeEventListener("keydown", handler, true);
    expect(handler).not.toHaveBeenCalled(); expect(escape.defaultPrevented).toBe(true);
    expect(page.__redline_fs).toBe(false);
    await document.querySelector<HTMLElement>("#player")!.requestFullscreen(); page.__redline_fs_exit();
    expect(document.fullscreenElement).toBeNull();
  });
  it("lifts fixed containing blocks and restores their existing attributes on exit", async () => {
    const ancestor = document.querySelector<HTMLElement>("#ancestor")!;
    ancestor.style.transform = "translateY(10px)"; ancestor.setAttribute("data-rl-fs-lift", "saved");
    await document.querySelector<HTMLElement>("#player")!.requestFullscreen();
    expect(ancestor.getAttribute("data-rl-fs-lift")).toBe("");
    expect(document.getElementById("__redline_fs__")!.textContent).toContain("filter:none!important");
    page.__redline_fs_exit();
    expect(ancestor.getAttribute("data-rl-fs-lift")).toBe("saved");
    expect(document.documentElement.classList.contains("__redline_fs_on")).toBe(false);
  });
  it("exits a removed player and sends its change event to the document", async () => {
    const player = document.querySelector<HTMLElement>("#player")!;
    await player.requestFullscreen(); player.remove();
    const listener = vi.fn(); document.addEventListener("fullscreenchange", listener);
    vi.advanceTimersByTime(1000); document.removeEventListener("fullscreenchange", listener);
    expect(page.__redline_fs).toBe(false); expect(listener.mock.calls[0][0].target).toBe(document);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("routes video APIs to the pin and preserves native picture-in-picture", () => {
    const video = document.querySelector("video")! as unknown as Record<string, any>;
    video.webkitEnterFullscreen(); expect(document.fullscreenElement).toBe(video);
    expect(video.webkitDisplayingFullscreen).toBe(true);
    video.webkitExitFullScreen(); expect(document.fullscreenElement).toBeNull();
    video.webkitSetPresentationMode("fullscreen"); expect(document.fullscreenElement).toBe(video);
    video.webkitSetPresentationMode("picture-in-picture");
    expect(document.fullscreenElement).toBeNull(); expect(originalMode).toHaveBeenCalledWith("picture-in-picture");
  });
  it("catches the native video controls' fullscreen event", () => {
    const video = document.querySelector("video")!;
    video.dispatchEvent(new Event("webkitbeginfullscreen"));
    expect(originalMode).toHaveBeenCalledWith("inline"); expect(document.fullscreenElement).toBe(video);
  });
  it("cascades iframe exit and ignores unrelated window messages", () => {
    const frame = document.createElement("iframe"); document.body.appendChild(frame);
    const post = vi.spyOn(frame.contentWindow!, "postMessage");
    window.dispatchEvent(new MessageEvent("message", { data: { __rl_fs: "enter" }, source: frame.contentWindow }));
    expect(document.fullscreenElement).toBe(frame); expect(page.__redline_fs).toBe(true);
    window.dispatchEvent(new MessageEvent("message", { data: { __rl_fs: "force-exit" }, source: window }));
    expect(page.__redline_fs).toBe(true);
    page.__redline_fs_exit();
    expect(post).toHaveBeenCalledWith({ __rl_fs: "force-exit" }, "*");
    expect(frame.classList.contains("__redline_fs_iframe__")).toBe(false); expect(page.__redline_fs).toBe(false);
  });
  it("pins elements in open shadow roots with local styles", async () => {
    const host = document.querySelector<HTMLElement>("#player")!;
    const root = host.attachShadow({ mode: "open" }); const video = document.createElement("video"); root.appendChild(video);
    await video.requestFullscreen();
    expect(root.querySelector("style")?.textContent).toContain("__redline_fs_pin__");
    expect(document.fullscreenElement).toBe(video);
  });
});
