// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The session's composer: it types into the CLI's own PTY, so what you send
//! is a prompt in your real Claude Code (or Codex) session — your hooks, your
//! skills, your slash commands.
//!
//! ```
//! Add to the plan…                                            the box
//! [Plan] [✦ Opus 4.5 · High] [📁 din]           🎙 [Talk] (↑)   the chips
//! ```
//!
//! - **Mode, model and folder always show** (4b), so "which model?" never
//!   comes up. Mode and model are live: a pick sends `/plan`, `/model` or
//!   `/effort` through the host while the CLI is idle (`convoSetMode` /
//!   `convoSetModel`), and the chip moves when the transcript confirms it.
//!   When it can't be done from here the chip says "Switch in terminal".
//!   The folder is the session's and can't change mid-session; the column
//!   and panel poses (4c, 5a) leave it out.
//! - **The model chip names the harness** when more than one is installed
//!   ("Codex · GPT-5.1-Codex · Medium"); its menu reads the live catalog
//!   (`useModelCatalogs`), the same one the Front Door's picker reads.
//! - **Voice stays one click away** (deviation 2): the mic dictates into the
//!   box (the shared dictation host), and Talk opens the spoken pose of this
//!   conversation, the voice panel.
//! - **One primary button** (`SendStopButton`): send; queue while a turn
//!   runs and there's text (the CLI takes type-ahead); Stop on an empty box
//!   while a turn runs.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AudioLines, Check, FilePenLine, Folder, Mic, Sparkles } from "lucide-react";
import { Panel, useClickPopover } from "../popover";
import { SendStopButton, sendState } from "../SendStopButton";
import { useDictationComposer } from "../../lib/dictationComposer";
import { useModelCatalogs } from "../../hooks/useModelCatalogs";
import { integrationHealth } from "../../lib/integrationHealth";
import { modelsFor, type Backend } from "../../lib/backendChoice";
import { EFFORT_OPTIONS } from "../../lib/seatAssign";
import { convoSetMode, convoSetModel } from "./convo/api";
import type { ConvoMode, SwitchResult } from "./convo/types";
import type { ModelFact } from "./convo/reducer";
import { effortLabel, modeLabel, modelChipLabel } from "./convo/status";
import "../ComposerMenu.css";
import "../CompactComposer.css";

export interface SessionComposerProps {
  terminalId: string | null;
  sessionId?: string | null;
  harness: "claude" | "codex";
  layout: "stage" | "column" | "panel";
  /** The CLI's permission mode, as the transcript last said it. */
  mode: ConvoMode | null;
  /** The model that last answered, and its effort. */
  model: ModelFact | null;
  /** The session's folder; the stage's composer shows it. */
  projectPath?: string | null;
  /** A turn is running: an empty box's button is Stop. */
  working: boolean;
  placeholder: string;
  /** Hand the text over; the conversation types it or queues it. */
  onSend: (text: string) => void;
  onStop: () => void;
  onShowTerminal: () => void;
  /** The voice panel is open on this conversation. */
  talking?: boolean;
  /** Open (or close) the voice panel. Without it, Talk asks the app to, by
   *  the `redline:flow-talk` window event. */
  onTalk?: () => void;
  /** Text handed back to the box (a queued send taken out of the queue). */
  restore?: { text: string; nonce: number } | null;
}

const BACKEND: Record<"claude" | "codex", Backend> = { claude: "claude-code", codex: "codex" };

/** The window event Talk raises when no `onTalk` is wired. */
export const FLOW_TALK_EVENT = "redline:flow-talk";

export function SessionComposer(props: SessionComposerProps) {
  const { terminalId, layout, working, onSend, onStop, onShowTerminal } = props;
  const [text, setText] = useState("");
  const frameRef = useRef<HTMLDivElement>(null);
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const [hint, setHint] = useState<string | null>(null);
  const stage = layout === "stage";

  // A queued send taken back: its text returns to the box, after whatever is
  // there.
  useEffect(() => {
    if (!props.restore) return;
    const back = props.restore.text;
    setText((prev) => (prev.trim() ? `${prev}\n${back}` : back));
    fieldRef.current?.focus();
  }, [props.restore]);

  // The box grows with what's in it, to a cap, then scrolls. A composer
  // mounted out of sight (the stage's portal host before it is placed)
  // measures 0: leave the height to the stylesheet then, or the field stays
  // pinned at nothing once it is shown.
  useLayoutEffect(() => {
    const field = fieldRef.current;
    if (!field) return;
    field.style.height = "auto";
    const height = field.scrollHeight;
    field.style.height = height ? `${Math.min(height, 220)}px` : "";
  }, [text]);

  // "Switch in terminal" is an answer to one pick, not a standing state.
  useEffect(() => {
    if (!hint) return;
    const t = window.setTimeout(() => setHint(null), 8000);
    return () => window.clearTimeout(t);
  }, [hint]);

  const dictation = useDictationComposer(frameRef, { send: true, polish: true }, fieldRef);

  const submit = () => {
    if (!text.trim()) return;
    onSend(text);
    setText("");
  };
  const switched = (result: SwitchResult) => setHint(result.status === "terminal" ? "Switch in terminal" : null);
  const talk = () => {
    if (props.onTalk) props.onTalk();
    else window.dispatchEvent(new CustomEvent(FLOW_TALK_EVENT, { detail: { terminalId, sessionId: props.sessionId ?? null } }));
  };
  const folder = props.projectPath ? props.projectPath.replace(/\/+$/, "").split("/").pop() || props.projectPath : null;
  const state = sendState(working, !!text.trim());

  return (
    // On the stage it is the compact composer (D27), the chat pane's box.
    <div ref={frameRef} className={`rl-convo-composer rl-glass rl-glass-sheet${stage ? " rl-compact-composer" : ""}`} data-layout={layout} data-compact-composer={stage || undefined}>
      <textarea
        ref={fieldRef}
        className="rl-convo-field"
        rows={1}
        value={text}
        placeholder={props.placeholder}
        aria-label={props.placeholder.replace(/…$/, "")}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <div className="rl-convo-chips">
        <ModeChip mode={props.mode} terminalId={terminalId} onResult={switched} />
        <ModelChip
          harness={props.harness}
          model={props.model}
          terminalId={terminalId}
          icon={stage}
          onResult={switched}
        />
        {stage && folder && (
          <span className="rl-convo-chip" data-chip="folder" title={props.projectPath ?? undefined}>
            <Folder size={12} aria-hidden className="rl-convo-chip-icon" />
            <span>{folder}</span>
          </span>
        )}
        {hint && (
          <button type="button" className="rl-convo-hint" onClick={onShowTerminal}>
            {hint}
          </button>
        )}
        <span className="rl-convo-spacer" />
        <button
          type="button"
          className="rl-convo-mic"
          data-hot={dictation.listening || undefined}
          aria-pressed={dictation.listening}
          aria-label={dictation.listening ? "Stop dictating" : "Dictate"}
          title={dictation.listening ? "Stop dictating" : "Dictate"}
          onClick={dictation.toggle}
        >
          <Mic size={14} aria-hidden />
        </button>
        <button
          type="button"
          className="rl-convo-chip rl-convo-talk"
          aria-pressed={!!props.talking}
          title={props.talking ? "Close the voice conversation" : "Talk this through out loud"}
          onClick={talk}
        >
          <AudioLines size={12} aria-hidden className="rl-convo-chip-icon" />
          <span>Talk</span>
        </button>
        <SendStopButton state={state} disabled={!text.trim()} onSend={submit} onStop={onStop} />
      </div>
    </div>
  );
}

const MODES: { mode: ConvoMode; detail: string }[] = [
  { mode: "plan", detail: "Plans first; changes nothing until you approve" },
  { mode: "default", detail: "Asks before each edit" },
  { mode: "acceptEdits", detail: "Edits files without asking" },
];

function ModeChip({
  mode,
  terminalId,
  onResult,
}: {
  mode: ConvoMode | null;
  terminalId: string | null;
  onResult: (result: SwitchResult) => void;
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  const pop = useClickPopover(anchor, "left", "above", 260, true);
  const pick = (next: ConvoMode) => {
    pop.close();
    anchor.current?.focus();
    if (!terminalId || next === mode) return;
    void convoSetMode(terminalId, next).then(onResult, () => onResult({ status: "terminal", reason: "failed" }));
  };
  return (
    <>
      <button
        ref={anchor}
        type="button"
        className="rl-convo-chip"
        data-mode={mode ?? "unknown"}
        aria-haspopup="menu"
        aria-expanded={pop.open}
        aria-label={`Mode: ${modeLabel(mode)}`}
        onClick={pop.toggle}
      >
        <FilePenLine size={12} aria-hidden />
        <span>{modeLabel(mode)}</span>
      </button>
      {pop.open && (
        <Panel label="Mode" {...pop.panelProps} className="rl-composer-menu" style={{ ...pop.panelProps.style, width: 260 }}>
          <div className="rl-composer-menu-scroll">
            <div className="rl-composer-menu-heading">Mode</div>
            {MODES.map((option) => (
              <button
                key={option.mode}
                type="button"
                role="menuitemradio"
                aria-checked={mode === option.mode}
                className="rl-composer-option"
                onClick={() => pick(option.mode)}
              >
                <span>
                  <strong>{modeLabel(option.mode)}</strong>
                  <small>{option.detail}</small>
                </span>
                {mode === option.mode && <Check size={14} className="rl-composer-check" />}
              </button>
            ))}
          </div>
        </Panel>
      )}
    </>
  );
}

/** Whether the catalog row `slug` is the model `id` the CLI reported: the
 *  same id, or one is the family alias of the other — a launch flag says
 *  `opus` where the catalog lists `claude-opus-4-5`, and the transcript
 *  reports the full id where a catalog lists the alias. */
function isModel(slug: string, id: string | undefined): boolean {
  if (!id) return false;
  const bare = (value: string) => value.replace(/^claude-/, "").replace(/\[1m\]$/i, "");
  const a = bare(slug), b = bare(id);
  return a === b || a.startsWith(`${b}-`) || b.startsWith(`${a}-`);
}

/** Whether a second harness is installed, from what the shared health
 *  probe already knows. A Claude session asks about Codex only when its
 *  menu opens, as the page chat's picker does: a Claude-only user's
 *  machine never runs a codex probe for a chip. */
function useShowHarness(harness: "claude" | "codex", asked: boolean): boolean {
  const known = () => {
    for (const backend of [null, "codex", "claude-code"] as const) {
      const health = integrationHealth.peek({ backend, extension: false });
      if (!health) continue;
      if (harness === "codex") return health.preflight.claude.found;
      if (health.preflight.codex) return health.preflight.codex.found;
    }
    // Claude is the app's default harness: a Codex session says so unless
    // Claude is known to be missing.
    return harness === "codex" ? true : null;
  };
  const [show, setShow] = useState<boolean | null>(known);
  useEffect(() => {
    if (!asked || harness !== "claude" || show !== null) return;
    let live = true;
    integrationHealth.ensure({ backend: "codex", extension: false }).then(
      (health) => live && setShow(!!health.preflight.codex?.found),
      () => live && setShow(false),
    );
    return () => {
      live = false;
    };
  }, [asked, harness, show]);
  return show ?? false;
}

function ModelChip({
  harness,
  model,
  terminalId,
  icon,
  onResult,
}: {
  harness: "claude" | "codex";
  model: ModelFact | null;
  terminalId: string | null;
  icon: boolean;
  onResult: (result: SwitchResult) => void;
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  const pop = useClickPopover(anchor, "left", "above", 280, true);
  const { catalogs, errors, request } = useModelCatalogs();
  const backend = BACKEND[harness];
  const [asked, setAsked] = useState(false);
  const showHarness = useShowHarness(harness, asked);
  // The chip names the model the way the catalog does ("Opus 4.5"), so the
  // catalog is read as soon as there is a model to name, not only when the
  // menu opens; the hook caches it per backend.
  useEffect(() => {
    if (pop.open || model) request(backend, backend);
  }, [pop.open, !!model, backend, request]);
  const catalog = catalogs[backend] ?? [];
  const models = modelsFor(backend, catalogs);
  const current = catalog.find((entry) => isModel(entry.slug, model?.model));
  const label = modelChipLabel(current && model ? { ...model, model: current.slug } : model, { harness, showHarness, catalog });
  const efforts = current?.efforts.length ? current.efforts : harness === "claude" ? EFFORT_OPTIONS : [];
  const pick = (nextModel: string | null, nextEffort: string | null) => {
    pop.close();
    anchor.current?.focus();
    if (!terminalId) return;
    void convoSetModel(terminalId, nextModel, nextEffort).then(onResult, () => onResult({ status: "terminal", reason: "failed" }));
  };
  return (
    <>
      <button
        ref={anchor}
        type="button"
        className="rl-convo-chip"
        aria-haspopup="menu"
        aria-expanded={pop.open}
        aria-label={`Model: ${label}`}
        onClick={() => {
          setAsked(true);
          pop.toggle();
        }}
      >
        {icon && <Sparkles size={12} aria-hidden className="rl-convo-chip-icon" />}
        <span>{label}</span>
      </button>
      {pop.open && (
        <Panel label="Model and effort" {...pop.panelProps} className="rl-composer-menu" style={{ ...pop.panelProps.style, width: 280 }}>
          <div className="rl-composer-menu-scroll">
            <div className="rl-composer-menu-heading">Model</div>
            {models.map((option) => {
              const on = isModel(option.value, model?.model);
              return (
                <button
                  key={option.value}
                  type="button"
                  role="menuitemradio"
                  aria-checked={on}
                  className="rl-composer-option"
                  title={option.hint}
                  onClick={() => (on ? pop.close() : pick(option.value, null))}
                >
                  <span>
                    <strong>{option.label}</strong>
                  </span>
                  {on && <Check size={14} className="rl-composer-check" />}
                </button>
              );
            })}
            {errors[backend] && <div className="rl-fd-menu-note">{errors[backend]}</div>}
            {efforts.length > 0 && <div className="rl-composer-menu-heading">Effort</div>}
            {efforts.map((effort) => {
              const on = model?.effort === effort;
              return (
                <button
                  key={effort}
                  type="button"
                  role="menuitemradio"
                  aria-checked={on}
                  className="rl-composer-option"
                  onClick={() => (on ? pop.close() : pick(null, effort))}
                >
                  <span>
                    <strong>{effortLabel(effort)}</strong>
                  </span>
                  {on && <Check size={14} className="rl-composer-check" />}
                </button>
              );
            })}
          </div>
        </Panel>
      )}
    </>
  );
}
