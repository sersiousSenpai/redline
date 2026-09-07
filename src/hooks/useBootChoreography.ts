// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useEffect, useState } from "react";
import {
  advance,
  BOOT_ATTR,
  BOOT_OPEN_MS,
  type BootEvent,
  type BootPhase,
} from "../lib/boot";
import { markOnce } from "../lib/bootMarks";

// The doors-open run (A2). main.tsx armed <html data-rl-boot="closed"> before
// React mounted, so the first frame the hidden window is revealed with holds
// the plates gathered over the document. This hook parts them: one frame
// after the reveal's double-rAF cadence it flips the attribute to "opening",
// and a hard timeout — never transitionend — removes it. Any keydown or
// pointerdown skips straight to settled; the user outranks the choreography.
// All transitions go through the pure machine in lib/boot.ts; this file only
// binds its events to frames and the attribute.
//
// The run is DECORATIVE, and the type below is what enforces that. It reports
// exactly one thing — "are the plates mid-flight" — because that is the only
// question with a legitimate consumer: a native child webview ignores DOM
// transforms and would paint over the moving plates, so the browser pane
// hides for the composition transition. Nothing actionable may read it. The
// hook used to also report `bootSettled`, and the front door rendered
// `visible={bootSettled && !loading}`, which is how a decorative animation
// became a ~750 ms floor on every launch before the composer took focus.
// Removing the field is the guard: there is no longer a boolean to gate on.

export interface BootChoreography {
  /** Doors mid-flight. Joins the `browserVisible` conjunction — the native
   *  webview ignores DOM transforms and would paint over the moving plates.
   *  False the moment the boot never armed (reduced motion, a replay, or the
   *  dead-man switch fired before mount). */
  bootAnimating: boolean;
}

export function useBootChoreography(): BootChoreography {
  const [settled, setSettled] = useState(
    () => document.documentElement.getAttribute(BOOT_ATTR) !== "closed",
  );
  useEffect(() => {
    if (settled) return;
    const html = document.documentElement;
    let raf1 = 0;
    let raf2 = 0;
    let raf3 = 0;
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
        markOnce("rl:boot-settled");
        setSettled(true);
      }
    };
    const skip = () => apply("skip");
    // This effect registers before the reveal effect (hook call order), so
    // its second rAF lands in the same frame that fires show_main_window:
    // the closed frame is what the window appears with, and the doors part
    // on the following frame.
    raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        raf3 = requestAnimationFrame(() => {
          // The main.tsx dead-man switch may have fired (React mounted
          // late) — never resurrect an attribute it force-removed.
          apply(html.getAttribute(BOOT_ATTR) === "closed"
            ? "reveal"
            : "timeout");
        });
      });
    });
    window.addEventListener("keydown", skip, true);
    window.addEventListener("pointerdown", skip, true);
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      cancelAnimationFrame(raf3);
      window.clearTimeout(open);
      window.removeEventListener("keydown", skip, true);
      window.removeEventListener("pointerdown", skip, true);
    };
  }, [settled]);
  return { bootAnimating: !settled };
}
