// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { createContext, useContext, useEffect } from "react";

// The browser pane is a native child webview painted by the OS *above* all
// React DOM, so a plain header dropdown (theme, mode, alerts, download) opens in
// a different compositing layer and is occluded by the pane — a z-index can't
// lift it out. The fix mirrors the existing drag/modal gating in App: while a
// menu is open it registers here, App folds the count into `browserVisible`, and
// the webview hides so the DOM menu shows through.
type Register = (delta: number) => void;

const MenuOverlayContext = createContext<Register | null>(null);

export const MenuOverlayProvider = MenuOverlayContext.Provider;

// Call from any header dropdown with its open state. While open, the browser
// webview is hidden so the menu isn't painted over. A no-op when rendered
// outside a provider.
export function useMenuOverlay(open: boolean): void {
  const register = useContext(MenuOverlayContext);
  useEffect(() => {
    if (!open || !register) return;
    register(1);
    return () => register(-1);
  }, [open, register]);
}
