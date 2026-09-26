// SPDX-License-Identifier: Apache-2.0
export interface VideoFs { tabId: string | null; screen: boolean; ownsWindow: boolean }
export const EMPTY_VIDEO_FS: VideoFs = { tabId: null, screen: false, ownsWindow: false };
export type VideoFsEvent =
  | { type: "page"; tabId: string; on: boolean }
  | { type: "active"; prev: string; next: string }
  | { type: "surface"; active: boolean }
  | { type: "window"; fullscreen: boolean }
  | { type: "screen"; windowFullscreen: boolean }
  | { type: "exit" };
export type VideoFsEffect = { type: "exitPage"; tabId: string } | { type: "setWindow"; fullscreen: boolean } | { type: "focusPage"; tabId: string };
export function stageOf(state: VideoFs, activeId: string, surfaceActive: boolean): "off" | "browser" | "screen" {
  return !surfaceActive || !state.tabId || state.tabId !== activeId ? "off" : state.screen ? "screen" : "browser";
}
export function stepVideoFs(state: VideoFs, event: VideoFsEvent): { state: VideoFs; effects: VideoFsEffect[] } {
  const effects: VideoFsEffect[] = [];
  const reset = (exitPage: boolean) => {
    if (exitPage && state.tabId) effects.push({ type: "exitPage", tabId: state.tabId });
    if (state.ownsWindow) effects.push({ type: "setWindow", fullscreen: false });
    return { state: EMPTY_VIDEO_FS, effects };
  };
  switch (event.type) {
    case "page":
      if (!event.on) return event.tabId === state.tabId ? reset(false) : { state, effects };
      if (state.tabId === event.tabId) return { state, effects };
      reset(true);
      return { state: { ...EMPTY_VIDEO_FS, tabId: event.tabId }, effects };
    case "exit": return reset(true);
    case "active": return state.tabId && event.next !== state.tabId ? reset(true) : { state, effects };
    case "surface": return !event.active ? reset(true) : { state, effects };
    case "screen":
      if (!state.tabId || state.screen) return { state, effects };
      if (!event.windowFullscreen) effects.push({ type: "setWindow", fullscreen: true });
      effects.push({ type: "focusPage", tabId: state.tabId });
      return { state: { ...state, screen: true, ownsWindow: !event.windowFullscreen }, effects };
    case "window":
      if (!state.tabId || state.screen === event.fullscreen) return { state, effects };
      return { state: { ...state, screen: event.fullscreen, ownsWindow: event.fullscreen }, effects };
  }
}
