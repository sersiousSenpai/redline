// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { EMPTY_VIDEO_FS, stageOf, stepVideoFs, type VideoFsEvent } from "./videoFullscreen";
const browser = { tabId: "one", screen: false, ownsWindow: false };
const screen = { tabId: "one", screen: true, ownsWindow: true };
describe("video fullscreen stages", () => {
  it("projects only the selected page on the active browser surface", () => {
    expect(stageOf(browser, "one", true)).toBe("browser");
    expect(stageOf(screen, "one", true)).toBe("screen");
    expect(stageOf(screen, "two", true)).toBe("off");
    expect(stageOf(screen, "one", false)).toBe("off");
  });
  it("enters idempotently and exits the previous page before replacing it", () => {
    expect(stepVideoFs(EMPTY_VIDEO_FS, { type: "page", tabId: "one", on: true }).state).toEqual(browser);
    expect(stepVideoFs(screen, { type: "page", tabId: "one", on: true })).toEqual({ state: screen, effects: [] });
    expect(stepVideoFs(screen, { type: "page", tabId: "two", on: true })).toEqual({ state: { ...browser, tabId: "two" }, effects: [{ type: "exitPage", tabId: "one" }, { type: "setWindow", fullscreen: false }] });
  });
  it.each<VideoFsEvent>([{ type: "exit" }, { type: "active", prev: "one", next: "two" }, { type: "surface", active: false }])("fully exits for $type", (event) => {
    expect(stepVideoFs(screen, event)).toEqual({ state: EMPTY_VIDEO_FS, effects: [{ type: "exitPage", tabId: "one" }, { type: "setWindow", fullscreen: false }] });
  });
  it("player exit restores only an owned window and ignores other pages' off events", () => {
    expect(stepVideoFs(screen, { type: "page", tabId: "one", on: false })).toEqual({ state: EMPTY_VIDEO_FS, effects: [{ type: "setWindow", fullscreen: false }] });
    expect(stepVideoFs(screen, { type: "page", tabId: "two", on: false })).toEqual({ state: screen, effects: [] });
  });
  it("requests a native window and focuses the video", () => {
    expect(stepVideoFs(browser, { type: "screen", windowFullscreen: false })).toEqual({ state: screen, effects: [{ type: "setWindow", fullscreen: true }, { type: "focusPage", tabId: "one" }] });
  });
  it("leaves a window that was already fullscreen alone on exit", () => {
    const entered = stepVideoFs(browser, { type: "screen", windowFullscreen: true });
    expect(entered.state.ownsWindow).toBe(false);
    expect(entered.effects).toEqual([{ type: "focusPage", tabId: "one" }]);
    expect(stepVideoFs(entered.state, { type: "exit" }).effects).toEqual([{ type: "exitPage", tabId: "one" }]);
  });
  it("promotes and demotes on user window changes while keeping the page pinned", () => {
    expect(stepVideoFs(browser, { type: "window", fullscreen: true })).toEqual({ state: screen, effects: [] });
    expect(stepVideoFs(screen, { type: "window", fullscreen: false })).toEqual({ state: browser, effects: [] });
    expect(stepVideoFs(EMPTY_VIDEO_FS, { type: "window", fullscreen: true }).state).toEqual(EMPTY_VIDEO_FS);
  });
});
