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

import { useState } from "react";
import { CircleHelp, ShieldQuestion } from "lucide-react";
import { answerAsk } from "./convo/api";
import type { AskAnswer, AskQuestion, ConvoAsk } from "./convo/types";

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
  // rule to add, so there is no Always.
  const always = (ask.suggestions?.length ?? 0) > 0;
  return (
    <>
      <div className="rl-ask-head">
        <ShieldQuestion size={14} aria-hidden className="rl-ask-icon" />
        <span>Allow {ask.toolName}?</span>
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
