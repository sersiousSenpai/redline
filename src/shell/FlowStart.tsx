// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The start screen's furniture in the flow shell (board 4a): the Chat | Plan
//! switch, the chips row's controls, and — under the composer — the four-step
//! strip, the first-run checklist and at most a couple of "Continue <title>"
//! links. The composer itself is FrontDoor's — it is on the boot path and owns
//! the sentence, the gates, the pickers and the zoom — and this is the part of
//! the screen that can arrive a frame late without anything moving: FrontDoor
//! holds each piece's place (`.rl-fs-slot`, and the strip's 18px slot in the
//! centred group) until it lands, and the checklist and links hang below the
//! strip, out of flow, so neither their arrival nor a fix clearing an item
//! ever moves the box you are typing in.
//!
//! The whole of it is the door's welcome (`.rl-fd-welcome` on the slot): it
//! recedes with the headline when the caret goes into the box (the focus
//! zoom), and sheds before the composer does on a short stage.
//!
//! The checklist is today's readiness strip turned into a first-run list. The
//! derivation is unchanged (lib/readiness.ts yields only faults, so a well
//! machine renders nothing here): every item is something that would break a
//! plan — the `claude` command missing, the hooks not installed or approved,
//! interception paused — with the fix that clears it, in place.

import type { ReactNode } from "react";
import { FilePenLine, MessageCircle, Mic, Paperclip } from "lucide-react";
import { FlowStrip } from "./FlowStrip";
import { Dot, FixControl } from "../components/ReadinessStrip";
import type { ReadinessItem } from "../lib/readiness";
import type { ContinueLink, FlowMode } from "../lib/flowStart";

export interface FlowStartOrbitProps {
  /** The strip, until the first approval retires it. */
  strip: boolean;
  /** The harness the next plan runs on, for the strip's "… plans". */
  harness: string;
  readiness: ReadinessItem[];
  onFix: (item: ReadinessItem) => Promise<boolean>;
  continues: ContinueLink[];
  onContinue: (id: string) => void;
}

export default function FlowStartOrbit({ strip, harness, readiness, onFix, continues, onContinue }: FlowStartOrbitProps) {
  return (
    <>
      {strip && <FlowStrip step={1} harness={harness} />}
      {(readiness.length > 0 || continues.length > 0) && (
        <div className="rl-fs-orbit">
          {readiness.length > 0 && <StartChecklist items={readiness} onFix={onFix} />}
          {continues.length > 0 && (
            <nav className="rl-fs-continue" aria-label="Continue a session">
              {continues.map((link) => (
                <button
                  key={link.id}
                  type="button"
                  title={link.title}
                  // A press never moves the caret on its way somewhere else.
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => onContinue(link.id)}
                >
                  Continue <span className="rl-fs-continue-title">{link.title}</span>
                </button>
              ))}
            </nav>
          )}
        </div>
      )}
    </>
  );
}

/** The one line beside the mode switch, saying what the mode does. The plan
 *  line is the design's own; the harness that will write the plan is named,
 *  so a Codex user isn't told Claude will. */
export function modeHint(mode: FlowMode, harness: string): string {
  return mode === "plan"
    ? `${harness} writes a plan for you to redline before anything is built.`
    : `Think it through with ${harness}. Nothing is planned or built until you say so.`;
}

/** Row one of the composer: Chat | Plan, and what the chosen mode does. A
 *  radio group, so the arrows move the choice. Plan chosen wears the plan
 *  blue's tint with a blue icon (start.css). */
export function FlowModeRow({ mode, chatEnabled, harness, onMode }: {
  mode: FlowMode;
  chatEnabled: boolean;
  harness: string;
  onMode: (mode: FlowMode) => void;
}) {
  const modes: FlowMode[] = chatEnabled ? ["chat", "plan"] : ["plan"];
  return (
    <>
      <div
        className="rl-fs-modes"
        role="radiogroup"
        aria-label="Mode"
        onKeyDown={(e) => {
          if (modes.length < 2 || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
          e.preventDefault();
          const next: FlowMode = mode === "plan" ? "chat" : "plan";
          onMode(next);
          e.currentTarget.querySelector<HTMLElement>(`[data-mode="${next}"]`)?.focus();
        }}
      >
        {modes.map((m) => (
          <button key={m} type="button" role="radio" data-mode={m} aria-checked={mode === m} tabIndex={mode === m ? 0 : -1} onClick={() => onMode(m)}>
            {m === "chat" ? <MessageCircle size={13} aria-hidden="true" /> : <FilePenLine size={13} aria-hidden="true" />}
            {m === "chat" ? "Chat" : "Plan"}
          </button>
        ))}
      </div>
      <span className="rl-fs-hint">{modeHint(mode, harness)}</span>
    </>
  );
}

/** The chips row, in the board's order: the folder and the model (the door's
 *  own pickers, handed in), a spacer, 📎, the voice pair — the mic dictates
 *  into the box; Talk speaks the sentence into a chat, the voice-first way
 *  in before any session exists to have a voice panel — and Start. A
 *  modifier on Start, as on ⏎, runs it directly; its tooltip says what that
 *  means on this harness. */
export function FlowStartTools({ picker, model, mode, combining, onAttach, listening, onDictate, talk, startable, opening, run, onStart }: {
  picker: ReactNode;
  model: ReactNode;
  mode: FlowMode;
  /** Plans pilled to combine: Start combines them into one plan. */
  combining: number;
  onAttach: () => void;
  listening: boolean;
  onDictate: () => void;
  talk?: { on: boolean; onToggle: () => void };
  startable: boolean;
  /** A chat is being opened from the last Start. */
  opening: boolean;
  /** The harness a ⌘-Start runs on directly, or null where it has no run. */
  run: string | null;
  onStart: (run: boolean) => void;
}) {
  const chat = mode === "chat" && combining === 0;
  return (
    <>
      {picker}
      {model}
      <span className="rl-fs-spacer" aria-hidden="true" />
      <button type="button" onClick={onAttach} title="Attach files as context" aria-label="Attach files" className="rl-fs-icon">
        <Paperclip size={15} aria-hidden="true" />
      </button>
      <div className="rl-fs-voice" role="group" aria-label="Voice">
        <button
          type="button"
          onClick={onDictate}
          title={listening ? "Stop dictating" : "Dictate into the box"}
          aria-label={listening ? "Stop dictating" : "Dictate"}
          aria-pressed={listening}
          className={`rl-fs-icon${listening ? " is-hot" : ""}`}
        >
          <Mic size={15} aria-hidden="true" />
        </button>
        {talk && (
          <button
            type="button"
            onClick={talk.onToggle}
            title={talk.on ? "Stop talking" : "Talk it through: a spoken chat, sent when you say “send it”"}
            aria-pressed={talk.on}
            className="rl-fs-talk"
          >
            Talk
          </button>
        )}
      </div>
      <button
        type="button"
        onClick={(e) => onStart(e.metaKey || e.ctrlKey)}
        disabled={!startable}
        // Pressed on the resting screen it launches; it doesn't zoom first.
        data-rl-door-go=""
        title={
          opening ? "Opening the conversation…"
          : combining > 0 ? `Combine ${combining} plans into one new plan (⏎)`
          : chat ? "Start a chat (⏎)"
          : run ? `Plan this first (⏎) · ⌘⏎ runs it now: no plan, ${run === "codex" ? "no approvals, no sandbox" : "auto mode"}`
          : "Plan this first (⏎)"
        }
        className="rl-fs-go"
      >
        {chat ? "Start chat" : "Start plan"}
        <span className="rl-fs-key" aria-hidden="true">↵</span>
      </button>
    </>
  );
}

/** The first-run checklist: one row per fault, its fix beside it. Titled for
 *  what it is for, so a returning user who paused interception reads it as a
 *  checklist and not as an error wall. */
export function StartChecklist({ items, onFix }: {
  items: ReadinessItem[];
  onFix: (item: ReadinessItem) => Promise<boolean>;
}) {
  return (
    <section className="rl-fs-checklist" aria-label="Before you start">
      <h2 className="rl-fs-checklist-head">Before you start</h2>
      <ul>
        {items.map((item) => (
          <li key={item.id} className="rl-fs-check" title={item.detail}>
            <Dot state={item.state} />
            <span className="rl-fs-check-text">
              <span className="rl-fs-check-label">{item.label}</span>
              <span className="rl-fs-check-detail">{item.detail}</span>
            </span>
            <FixControl item={item} onFix={onFix} />
          </li>
        ))}
      </ul>
    </section>
  );
}
