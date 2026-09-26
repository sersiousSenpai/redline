// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Window } from "@tauri-apps/api/window";
import { Webview } from "@tauri-apps/api/webview";
import { EMPTY_VIDEO_FS, stageOf, stepVideoFs, type VideoFsEvent } from "../lib/videoFullscreen";

/** Keep native fullscreen observations separate from our own animated requests. */
export function useVideoFullscreen(activeId: string, surfaceActive: boolean, onError: (message: string) => void) {
  const [state, setState] = useState(EMPTY_VIDEO_FS);
  const current = useRef(state);
  const mounted = useRef(true);
  const report = useRef(onError); report.current = onError;
  const observedWindow = useRef<boolean | null>(null);
  const pendingWindow = useRef<{ target: boolean; generation: number } | null>(null);
  const generation = useRef(0);
  const queue = useRef(Promise.resolve());
  const monitor = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const dispatchRef = useRef<(event: VideoFsEvent) => void>(() => {});
  const exitPage = (tabId: string) => invoke("browser_eval", { label: `browser-${tabId}`, script: "window.__redline_fs_exit&&window.__redline_fs_exit()" });
  const setWindow = useCallback((target: boolean) => {
    const token = ++generation.current;
    pendingWindow.current = { target, generation: token };
    clearTimeout(monitor.current);
    queue.current = queue.current.catch(() => {}).then(async () => {
      if (token !== generation.current) return;
      const win = Window.getCurrent();
      let attempts = 0, deadline = Date.now() + 1500;
      const fail = (error: unknown) => {
        if (token !== generation.current) return;
        pendingWindow.current = null;
        if (mounted.current) {
          report.current(`Could not change video fullscreen: ${String(error)}`);
          void win.isFullscreen().then((fullscreen) => {
            observedWindow.current = fullscreen;
            dispatchRef.current({ type: "window", fullscreen });
          }).catch(() => {});
        }
      };
      const check = async () => {
        if (token !== generation.current) return;
        try {
          const fullscreen = await win.isFullscreen();
          if (token !== generation.current) return;
          if (fullscreen === target) { observedWindow.current = fullscreen; pendingWindow.current = null; return; }
          if (Date.now() >= deadline) {
            if (attempts++ > 0) { fail("the window did not finish its fullscreen transition"); return; }
            deadline = Date.now() + 1500;
            await win.setFullscreen(target);
          }
          monitor.current = setTimeout(() => { void check(); }, 100);
        } catch (error) { fail(error); }
      };
      try { await win.setFullscreen(target); await check(); } catch (error) { fail(error); }
    });
  }, []);
  const dispatch = useCallback((event: VideoFsEvent) => {
    const result = stepVideoFs(current.current, event);
    current.current = result.state;
    if (mounted.current) setState(result.state);
    for (const effect of result.effects) {
      if (effect.type === "setWindow") setWindow(effect.fullscreen);
      else if (effect.type === "exitPage") void exitPage(effect.tabId).catch((error) => { if (mounted.current) report.current(`Could not exit video fullscreen: ${String(error)}`); });
      else void Webview.getByLabel(`browser-${effect.tabId}`).then((view) => view?.setFocus()).catch(() => {});
    }
  }, [setWindow]);
  dispatchRef.current = dispatch;
  const observeWindow = useCallback(async () => {
    try {
      const fullscreen = await Window.getCurrent().isFullscreen();
      if (!mounted.current) return;
      const pending = pendingWindow.current;
      if (pending) {
        if (fullscreen === pending.target) { observedWindow.current = fullscreen; pendingWindow.current = null; }
        return;
      }
      const previous = observedWindow.current;
      observedWindow.current = fullscreen;
      if (previous !== null && previous !== fullscreen) dispatch({ type: "window", fullscreen });
    } catch { /* Window can disappear during application shutdown. */ }
  }, [dispatch]);
  const requestScreen = useCallback(async () => {
    const tabId = current.current.tabId;
    try {
      const fullscreen = await Window.getCurrent().isFullscreen();
      if (tabId && current.current.tabId === tabId) dispatch({ type: "screen", windowFullscreen: fullscreen });
    } catch (error) { report.current(`Could not enter video fullscreen: ${String(error)}`); }
  }, [dispatch]);
  const previousActive = useRef(activeId);
  useEffect(() => { dispatch({ type: "active", prev: previousActive.current, next: activeId }); previousActive.current = activeId; }, [activeId, dispatch]);
  useEffect(() => { dispatch({ type: "surface", active: surfaceActive }); }, [surfaceActive, dispatch]);
  useEffect(() => {
    mounted.current = true;
    void observeWindow();
    return () => {
      mounted.current = false;
      const previous = current.current;
      current.current = EMPTY_VIDEO_FS;
      if (previous.tabId) void exitPage(previous.tabId).catch(() => {});
      if (previous.ownsWindow) setWindow(false);
    };
  }, [observeWindow, setWindow]);
  return { state, stage: stageOf(state, activeId, surfaceActive), dispatch, observeWindow, requestScreen };
}
