// SPDX-License-Identifier: Apache-2.0
import { useLayoutEffect, type RefObject } from "react";
import { invoke } from "@tauri-apps/api/core";

// Native browser pages retain their full viewport. These regions let the main
// webview show through and receive input only where a floating surface exists.
const regions = new Set<HTMLElement>();
let frame = 0, inFlight = false, again = false, last = "";
function schedule() {
  if (!frame) frame = requestAnimationFrame(() => { frame = 0; void publish(); });
}
async function publish() {
  if (inFlight) { again = true; return; }
  const rects = [...regions].filter(el => el.isConnected && el.getClientRects().length).map(el => {
    const rect = el.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, radius: parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0 };
  });
  const key = JSON.stringify(rects);
  if (last === key) return;
  inFlight = true;
  try { await invoke("browser_overlay_regions", { rects }); last = key; }
  catch (error) { console.warn("Could not position the floating browser overlay", error); }
  finally { inFlight = false; if (again) { again = false; schedule(); } }
}
export function useNativeOverlayRegion(ref: RefObject<HTMLElement | null>, enabled = true) {
  useLayoutEffect(() => {
    if (!enabled || !("__TAURI_INTERNALS__" in window) || !ref.current) return;
    const element = ref.current;
    regions.add(element);
    const resize = new ResizeObserver(schedule);
    resize.observe(element);
    // Moving the island changes position without changing size.
    const mutation = new MutationObserver(schedule);
    mutation.observe(element, { attributes: true, attributeFilter: ["style", "class"] });
    if (element.parentElement) mutation.observe(element.parentElement, { attributes: true, attributeFilter: ["style", "class"] });
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    schedule();
    return () => { resize.disconnect(); mutation.disconnect(); window.removeEventListener("resize", schedule); window.removeEventListener("scroll", schedule, true); regions.delete(element); schedule(); };
  }, [ref, enabled]);
}
