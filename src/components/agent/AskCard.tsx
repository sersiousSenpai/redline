// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! A question the CLI is holding for you, answered in the conversation
//! instead of the terminal: a permission (Allow once · Always · Deny) or an
//! AskUserQuestion (its options, single or multi, plus words of your own).
//! The hook holding it releases with whatever this sends (`answerAsk`).
//!
//! "Answer in terminal" is always there: it releases the hook empty, so the
//! TUI asks natively, and flips the stage to the terminal. The card is the
//! glass sheet tier — it floats over the conversation's solid ground — with
//! the focus rim, because it is the one thing waiting on you.
//!
//! What is only a sentence and its answers — the build question, a dialog
//! waiting in the terminal, a stopped agent — is instead the one notice
//! strip (plan/NoticeStrip, D42), at the top of the conversation: a card is
//! for a question with options to read.

import { useState } from "react";
import { CircleHelp, ShieldQuestion } from "lucide-react";
import { NoticeStrip } from "../plan/NoticeStrip";
import { answerAsk } from "./convo/api";
import type { AskAnswer, AskQuestion, ConvoAsk } from "./convo/types";
import type { PermissionPrompt, ProceedPrompt } from "./convo/proceedPrompt";

export interface AskCardProps {
  ask: ConvoAsk;
  /** The stage's terminal view, for "Answer in terminal". */
  onShowTerminal: () => void;
}

export function AskCard({ ask, onShowTerminal }: AskCardProps) {
  const [sending, setSending] = useState<AskAnswer["kind"] | null>(null);
  const [failed, setFailed] = useState(false);
  const send = (answer: AskAnswer) => {
    setSending(answer.kind);
    setFailed(false);
    // The card leaves when `ask_closed` arrives, not here: a send that
    // failed must leave the question answerable.
    void answerAsk(ask.askId, answer).then(
      () => {
        if (answer.kind === "terminal") onShowTerminal();
      },
      () => {
        setSending(null);
        setFailed(true);
      },
    );
  };
  const busy = sending !== null;
  // ExitPlanMode asking leave to build is the CLI's "Ready to code?": a
  // sentence and its three answers, so a strip.
  if (ask.kind === "permission" && ask.toolName === "ExitPlanMode") {
    const always = (ask.suggestions?.length ?? 0) > 0;
    return (
      <NoticeStrip
        title="Ready to build this plan?"
        detail={failed ? "That answer didn't go through — try again, or answer in the terminal." : null}
        tip={always && ask.rule ? `Yes, accept edits: ${ask.rule}` : undefined}
        attrs={{ "data-ask": "permission" }}
        label="Ready to build this plan?"
      >
        <button type="button" className="rl-plan-notice-btn" data-primary="" disabled={busy} onClick={() => send({ kind: "allow" })}>
          {sending === "allow" ? "Starting…" : "Yes, build"}
        </button>
        {always && (
          <button type="button" className="rl-plan-notice-btn" disabled={busy} title={ask.rule ?? undefined} onClick={() => send({ kind: "always" })}>
            {sending === "always" ? "Starting…" : "Yes, accept edits"}
          </button>
        )}
        <button type="button" className="rl-plan-notice-btn" disabled={busy} onClick={() => send({ kind: "deny" })}>
          {sending === "deny" ? "Keeping…" : "Keep planning"}
        </button>
        <button type="button" className="rl-plan-notice-btn" disabled={busy} onClick={() => send({ kind: "terminal" })}>
          Answer in terminal
        </button>
      </NoticeStrip>
    );
  }
  const toTerminal = (
    <button type="button" className="rl-ask-terminal" disabled={busy} onClick={() => send({ kind: "terminal" })}>
      Answer in terminal
    </button>
  );
  return (
    <section
      className="rl-ask-card rl-glass rl-glass-sheet"
      role="group"
      aria-label={ask.kind === "permission" ? `Permission: ${ask.toolName}` : "Question"}
      data-ask={ask.kind}
      aria-busy={busy || undefined}
    >
      {ask.kind === "permission" ? (
        <Permission ask={ask} busy={busy} sending={sending} onAnswer={send} terminal={toTerminal} />
      ) : (
        <Questions ask={ask} busy={busy} onAnswer={send} terminal={toTerminal} />
      )}
      {failed && (
        <p className="rl-ask-note" role="alert">
          That answer didn't go through. Try again, or answer in the terminal.
        </p>
      )}
    </section>
  );
}

function Permission({
  ask,
  busy,
  sending,
  onAnswer,
  terminal,
}: {
  ask: ConvoAsk;
  busy: boolean;
  sending: AskAnswer["kind"] | null;
  onAnswer: (answer: AskAnswer) => void;
  terminal: React.ReactNode;
}) {
  // Always passes the payload's own suggestions back; with none there is no
  // rule to add, so there is no Always. (ExitPlanMode's leave to build is
  // the strip above, never this card.)
  const always = (ask.suggestions?.length ?? 0) > 0;
  return (
    <>
      <div className="rl-ask-head">
        <ShieldQuestion size={14} aria-hidden className="rl-ask-icon" />
        <span>{`Allow ${ask.toolName}?`}</span>
      </div>
      {ask.summary && <code className="rl-ask-summary">{ask.summary}</code>}
      <div className="rl-ask-actions">
        <button type="button" className="rl-ask-btn" data-primary disabled={busy} onClick={() => onAnswer({ kind: "allow" })}>
          {sending === "allow" ? "Allowing…" : "Allow once"}
        </button>
        {always && (
          <button type="button" className="rl-ask-btn" disabled={busy} title={ask.rule ?? undefined} onClick={() => onAnswer({ kind: "always" })}>
            {sending === "always" ? "Allowing…" : "Always"}
          </button>
        )}
        <button type="button" className="rl-ask-btn" data-danger disabled={busy} onClick={() => onAnswer({ kind: "deny" })}>
          {sending === "deny" ? "Denying…" : "Deny"}
        </button>
        <span className="rl-ask-spacer" />
        {terminal}
      </div>
      {always && ask.rule && <p className="rl-ask-rule">Always: {ask.rule}</p>}
    </>
  );
}

/** The CLI is showing a prompt of its own that no hook carried here (an
 *  older hook install, a dialog the CLI raises by itself): the agent waits on
 *  it, so the conversation says so and offers the terminal — never a bare
 *  "Needs you" with nothing to answer. */
export function TerminalAskCard({ harness, onShowTerminal }: { harness: string; onShowTerminal: () => void }) {
  return (
    <NoticeStrip title={`${harness} is asking in the terminal`} label="Question in the terminal" attrs={{ "data-ask": "terminal" }}>
      <button type="button" className="rl-plan-notice-btn" data-primary="" onClick={onShowTerminal}>
        Answer in terminal
      </button>
    </NoticeStrip>
  );
}

/** Each question's pick: the chosen labels, and words of its own. */
type Picks = Record<string, { labels: string[]; other: string }>;

/** What `updatedInput.answers` carries for one question: its labels
 *  comma-joined (a multi-select), the free text instead when there is some
 *  and nothing was picked, both when both. */
export function answerFor(question: AskQuestion, pick: { labels: string[]; other: string } | undefined): string | null {
  const labels = pick?.labels ?? [];
  const other = pick?.other.trim() ?? "";
  const parts = question.multiSelect ? [...labels, ...(other ? [other] : [])] : labels.length ? labels : other ? [other] : [];
  return parts.length ? parts.join(", ") : null;
}

function Questions({
  ask,
  busy,
  onAnswer,
  terminal,
}: {
  ask: ConvoAsk;
  busy: boolean;
  onAnswer: (answer: AskAnswer) => void;
  terminal: React.ReactNode;
}) {
  const questions = ask.questions ?? [];
  const [picks, setPicks] = useState<Picks>({});
  const toggle = (q: AskQuestion, label: string) =>
    setPicks((prev) => {
      const cur = prev[q.question] ?? { labels: [], other: "" };
      const labels = q.multiSelect
        ? cur.labels.includes(label)
          ? cur.labels.filter((l) => l !== label)
          : [...cur.labels, label]
        : [label];
      // A single choice is the option OR your own words, never both.
      return { ...prev, [q.question]: { labels, other: q.multiSelect ? cur.other : "" } };
    });
  const setOther = (q: AskQuestion, other: string) =>
    setPicks((prev) => {
      const cur = prev[q.question] ?? { labels: [], other: "" };
      return { ...prev, [q.question]: { labels: q.multiSelect ? cur.labels : [], other } };
    });
  const answers: Record<string, string> = {};
  for (const q of questions) {
    const answer = answerFor(q, picks[q.question]);
    if (answer !== null) answers[q.question] = answer;
  }
  const complete = questions.length > 0 && questions.every((q) => q.question in answers);
  return (
    <>
      {questions.map((q, qi) => (
        <fieldset key={q.question} className="rl-ask-question" disabled={busy}>
          <legend className="rl-ask-head">
            <CircleHelp size={14} aria-hidden className="rl-ask-icon" />
            <span>{q.question}</span>
            {q.header && <span className="rl-ask-tag">{q.header}</span>}
          </legend>
          <div className="rl-ask-options" role={q.multiSelect ? "group" : "radiogroup"} aria-label={q.question}>
            {q.options.map((option) => {
              const on = picks[q.question]?.labels.includes(option.label) ?? false;
              return (
                <button
                  key={option.label}
                  type="button"
                  role={q.multiSelect ? "checkbox" : "radio"}
                  aria-checked={on}
                  className="rl-ask-option"
                  onClick={() => toggle(q, option.label)}
                >
                  <span className="rl-ask-mark" data-multi={q.multiSelect || undefined} aria-hidden />
                  <span className="rl-ask-option-text">
                    <strong>{option.label}</strong>
                    {option.description && <small>{option.description}</small>}
                  </span>
                </button>
              );
            })}
            <label className="rl-ask-other">
              <span className="sr-only">Your own answer to: {q.question}</span>
              <input
                type="text"
                placeholder={q.multiSelect ? "Something else…" : "Or say something else…"}
                value={picks[q.question]?.other ?? ""}
                onChange={(e) => setOther(q, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.nativeEvent.isComposing && complete && qi === questions.length - 1) {
                    e.preventDefault();
                    onAnswer({ kind: "answers", answers });
                  }
                }}
              />
            </label>
          </div>
        </fieldset>
      ))}
      <div className="rl-ask-actions">
        <button type="button" className="rl-ask-btn" data-primary disabled={busy || !complete} onClick={() => onAnswer({ kind: "answers", answers })}>
          {busy ? "Answering…" : "Answer"}
        </button>
        <span className="rl-ask-spacer" />
        {terminal}
      </div>
    </>
  );
}

/** The agent's CLI is gone from its terminal (killed, crashed, exited) — the
 *  Detached notice of a session past its review. A plan in review gets the
 *  plan's own Restore; one approved and building gets Retry, which resumes
 *  the same conversation to carry on the build (App's `buildApproved`). Never
 *  a bare "Needs you": a dead agent needs nothing it can say. */
export function StoppedCard({ harness, building, onRetry, onShowTerminal }: {
  harness: string;
  building: boolean;
  onRetry: (() => void) | null;
  onShowTerminal: () => void;
}) {
  const [retrying, setRetrying] = useState(false);
  const title = building ? `${harness} stopped before the build finished` : `${harness} stopped`;
  return (
    <NoticeStrip
      title={title}
      tip={building ? "Retry resumes the same conversation to carry on the build." : `${harness}'s process left its terminal.`}
      label={`${harness} stopped`}
      attrs={{ "data-ask": "stopped" }}
    >
      {onRetry && (
        <button
          type="button"
          className="rl-plan-notice-btn"
          data-primary=""
          disabled={retrying}
          onClick={() => {
            setRetrying(true);
            onRetry();
          }}
        >
          {retrying ? "Resuming…" : "Retry"}
        </button>
      )}
      <button type="button" className="rl-plan-notice-btn" onClick={onShowTerminal}>
        Open terminal
      </button>
    </NoticeStrip>
  );
}

/** The CLI's own "Ready to code? Would you like to proceed?" read off its
 *  terminal (`convo/proceedPrompt`) — no hook carried it here — as the card
 *  a held ExitPlanMode would have been: its approving choices build, the
 *  other sends you to the terminal to say what to change. Each choice is
 *  answered with the keys a person would press there. */
export function ProceedCard({ prompt, onChoose, onShowTerminal }: {
  prompt: ProceedPrompt;
  onChoose: (n: number) => Promise<void>;
  onShowTerminal: () => void;
}) {
  const [sending, setSending] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const choose = (n: number, thenTerminal: boolean) => {
    setSending(n);
    setFailed(false);
    onChoose(n)
      .then(() => {
        if (thenTerminal) onShowTerminal();
      })
      .catch(() => {
        setSending(null);
        setFailed(true);
      });
  };
  const approving = prompt.options.filter((o) => o.approves);
  const other = prompt.options.find((o) => !o.approves) ?? null;
  return (
    <NoticeStrip
      title="Ready to build this plan?"
      detail={failed ? "That answer didn't reach the terminal — try again, or answer there." : null}
      label="Ready to build this plan?"
      attrs={{ "data-ask": "proceed" }}
    >
      {approving.map((o, i) => (
        <button key={o.n} type="button" className="rl-plan-notice-btn" data-primary={i === 0 ? "" : undefined} disabled={sending !== null} title={o.label} onClick={() => choose(o.n, false)}>
          {sending === o.n ? "Starting…" : i === 0 ? `Yes, build · ${o.label.replace(/^Yes,\s*(and\s*)?/i, "")}` : o.label}
        </button>
      ))}
      {other && (
        <button type="button" className="rl-plan-notice-btn" disabled={sending !== null} title={other.label} onClick={() => choose(other.n, true)}>
          {other.label}
        </button>
      )}
      <button type="button" className="rl-plan-notice-btn" onClick={onShowTerminal}>
        Answer in terminal
      </button>
    </NoticeStrip>
  );
}

/** A tool permission the CLI asks in its own terminal (`convo/proceedPrompt`'s
 *  `parsePermissionPrompt`): no hook carried it here, so it is the card the
 *  PermissionRequest hook would have armed, answered with the keys a person
 *  would press there. The refusing choice sends you to the terminal to say
 *  what to do instead. */
export function PermissionPromptCard({ prompt, harness, onChoose, onShowTerminal }: {
  prompt: PermissionPrompt;
  harness: string;
  onChoose: (n: number) => Promise<void>;
  onShowTerminal: () => void;
}) {
  const [sending, setSending] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const choose = (n: number, thenTerminal: boolean) => {
    setSending(n);
    setFailed(false);
    onChoose(n)
      .then(() => {
        if (thenTerminal) onShowTerminal();
      })
      .catch(() => {
        setSending(null);
        setFailed(true);
      });
  };
  const title = prompt.question ?? `${harness} asks to use a tool`;
  return (
    <section className="rl-ask-card rl-glass rl-glass-sheet" role="group" aria-label={title} data-ask="permission-prompt">
      <div className="rl-ask-head">
        <ShieldQuestion size={14} aria-hidden className="rl-ask-icon" />
        <span>{title}</span>
      </div>
      <div className="rl-ask-actions">
        {prompt.options.map((o, i) => (
          <button
            key={o.n}
            type="button"
            className="rl-ask-btn"
            data-primary={(o.approves && i === 0) || undefined}
            data-danger={!o.approves || undefined}
            disabled={sending !== null}
            onClick={() => choose(o.n, !o.approves)}
          >
            {sending === o.n ? "Sending…" : o.label}
          </button>
        ))}
        <span className="rl-ask-spacer" />
        <button type="button" className="rl-ask-terminal" onClick={onShowTerminal}>
          Answer in terminal
        </button>
      </div>
      {failed && (
        <p className="rl-ask-note" role="alert">
          That answer didn't reach the terminal. Try again, or answer there.
        </p>
      )}
    </section>
  );
}
