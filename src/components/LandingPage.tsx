// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useEffect, useState } from "react";
import { PulseLogo } from "./PulseLogo";
import { Button } from "./ui/Button";

// The document plate's landing (A4): a live first page, not an instruction
// card. The caret line reads like placeholder text in an empty document —
// clicking it (or just typing; App's landing listener owns that path) opens
// a fresh Drafter document, and the words typed mid-handoff carry through.
// Quiet secondary lines point at the sidebar and the how-it-works card.
export function LandingPage({
  visible,
  sessionsExist,
  onStart,
  onHowItWorks,
}: {
  /** Boot doors settled and sessions loaded — the page resolves after the
   *  choreography, never through it. */
  visible: boolean;
  /** Plans exist in the sidebar (the landing also shows when a session was
   *  merely deselected) — earns the "or open a recent plan" line. */
  sessionsExist: boolean;
  /** The caret line's click path: same fresh document, no seed text. */
  onStart: () => void;
  onHowItWorks: () => void;
}) {
  // Mount at opacity 0 and flip a frame later so the fade actually runs —
  // a class present at first paint would land already opaque.
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    if (!visible) return;
    const raf = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(raf);
  }, [visible]);

  return (
    <div
      className={`rl-landing font-sans${entered ? " rl-landing-in" : ""}`}
      data-tour="landing"
    >
      <PulseLogo state="idle" size={30} title="Redline" />
      <button
        type="button"
        className="rl-landing-start font-serif"
        onClick={onStart}
      >
        <span className="rl-landing-caret" aria-hidden />
        Draft a new plan
      </button>
      <p className="rl-landing-hint">just start typing</p>
      <div className="rl-landing-lines">
        {sessionsExist && (
          <p className="rl-landing-hint">or open a recent plan from the sidebar</p>
        )}
        <Button
          variant="ghost"
          onClick={onHowItWorks}
          label="How Redline works →"
        />
      </div>
    </div>
  );
}
