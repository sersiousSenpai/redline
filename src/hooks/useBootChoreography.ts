// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useEffect, useRef, useState } from "react";
import {
  advance,
  BOOT_ATTR,
  BOOT_OPEN_MS,
  holdMs,
  type BootEvent,
  type BootPhase,
} from "../lib/boot";

// The doors-open run (A2). main.tsx armed <html data-rl-boot="closed"> before
// React mounted, so the first frame the hidden window is revealed with holds
// the plates gathered over the document. This hook parts them: one frame
// after the reveal's double-rAF cadence it flips the attribute to "opening",
// and a hard timeout — never transitionend — removes it. Any keydown or
// pointerdown skips straight to settled; the user outranks the choreography.
// All transitions go through the pure machine in lib/boot.ts; this file only
// binds its events to frames, timers and the attribute.

export interface BootChoreography {
  /** Doors mid-flight. Joins the `browserVisible` conjunction — the native
   *  webview ignores DOM transforms and would paint over the moving plates. */
  bootAnimating: boolean;
  /** The resting layout is authoritative. Immediately true when the boot
   *  never armed (reduced motion, a replay, or the dead-man switch fired
   *  before mount). */
  bootSettled: boolean;
}

export function useBootChoreography(firstLaunch: boolean): BootChoreography {
  const [settled, setSettled] = useState(
    () => document.documentElement.getAttribute(BOOT_ATTR) !== "closed",
  );
  // Read once — onboarding completing mid-animation must not re-run the run.
  const firstLaunchRef = useRef(firstLaunch);
  useEffect(() => {
    if (settled) return;
    const html = document.documentElement;
    let raf1 = 0;
    let raf2 = 0;
    let raf3 = 0;
    let hold = 0;
    let open = 0;
    let phase: BootPhase = "closed";
    const apply = (event: BootEvent) => {
      const next = advance(phase, event);
      if (next === phase) return;
      phase = next;
      if (next === "opening") {
        html.setAttribute(BOOT_ATTR, "opening");
        open = window.setTimeout(() => apply("timeout"), BOOT_OPEN_MS);
      } else {
        html.removeAttribute(BOOT_ATTR);
        setSettled(true);
      }
    };
    const skip = () => apply("skip");
    // This effect registers before the reveal effect (hook call order), so
    // its second rAF lands in the same frame that fires show_main_window:
    // the closed frame is what the window appears with, and the doors part
    // on the following frame — after a first-launch breath on the hold.
    raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        hold = window.setTimeout(() => {
          raf3 = requestAnimationFrame(() => {
            // The main.tsx dead-man switch may have fired (React mounted
            // late) — never resurrect an attribute it force-removed.
            apply(html.getAttribute(BOOT_ATTR) === "closed"
              ? "reveal"
              : "timeout");
          });
        }, holdMs(firstLaunchRef.current));
      });
    });
    window.addEventListener("keydown", skip, true);
    window.addEventListener("pointerdown", skip, true);
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      cancelAnimationFrame(raf3);
      window.clearTimeout(hold);
      window.clearTimeout(open);
      window.removeEventListener("keydown", skip, true);
      window.removeEventListener("pointerdown", skip, true);
    };
  }, [settled]);
  return { bootAnimating: !settled, bootSettled: settled };
}
