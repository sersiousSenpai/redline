// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useEffect, useId, useRef, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

import { contextSummary, deliveryLabel, repoState, type ChatContext } from "../lib/chatRoom";

// What the room knows. The chat's first turn carries a workspace brief that
// Redline read from local state, so the agent answers without curling; this
// chip shows exactly what went in, so the user can see what the room can and
// cannot speak to. Collapsed by default: a summary line, never a wall.
//
// It lives in the room's header row and its list opens OVER the thread. A new
// chat learns its context during its first turn, and a row of its own arriving
// then would push the thread down under the reader mid-reply.

export function ChatContextChip({
  context,
  onOpenPlan,
  maxWidth,
}: {
  context: ChatContext;
  onOpenPlan?: (sessionId: string) => void;
  /** The thread's column: the list is no wider (nor wider than it reads). */
  maxWidth: number;
}) {
  const [open, setOpen] = useState(false);
  const chip = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const id = useId();
  // An overlay closes on a press anywhere else (which still lands) or Esc.
  // Esc shuts the list first wherever the caret is — a click never focuses
  // the chip in WebKit, so it is usually still in the composer — and the
  // room (or the door around it) hears the next one.
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!chip.current?.contains(target) && !list.current?.contains(target)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      if (list.current?.contains(document.activeElement)) chip.current?.focus();
      setOpen(false);
    };
    document.addEventListener("pointerdown", away, true);
    window.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerdown", away, true);
      window.removeEventListener("keydown", escape, true);
    };
  }, [open]);
  const parts = contextSummary(context);
  if (parts.length === 0) return null;
  const b = context.brief;
  return (
    <span
      data-chat-context
      className="font-sans"
      style={{ display: "contents" }}
    >
      <button
        ref={chip}
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((v) => !v)}
        title="What Redline handed this conversation"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          // The title yields first; past half the row the summary does.
          flex: "0 1 auto",
          minWidth: 0,
          maxWidth: "50%",
          // The header's own pills' metrics, so its arrival never changes the
          // row's height.
          fontSize: 11,
          padding: "3px 10px",
          borderRadius: 999,
          border: "1px solid var(--color-rule)",
          background: "transparent",
          color: "var(--color-ink-muted)",
          whiteSpace: "nowrap",
          cursor: "pointer",
        }}
      >
        {open ? <ChevronDown size={12} style={{ flexShrink: 0 }} /> : <ChevronRight size={12} style={{ flexShrink: 0 }} />}
        <span style={{ color: "var(--color-ink)", fontWeight: 600 }}>Context</span>
        <span className="truncate">· {parts.join(" · ")}</span>
      </button>
      {open && (
        <div
          ref={list}
          id={id}
          data-chat-context-panel
          className="rl-thin-scroll-y"
          style={{
            // Hung from the header over the thread, never taking its height,
            // and dropped from the chip's end of the row.
            position: "absolute",
            top: "calc(100% + 4px)",
            left: 12,
            right: 12,
            zIndex: 30,
            maxWidth: Math.min(maxWidth, 480),
            marginLeft: "auto",
            maxHeight: 260,
            overflowY: "auto",
            padding: "10px 12px",
            borderRadius: 10,
            border: "1px solid var(--color-rule)",
            background: "var(--color-bg-elevated)",
            boxShadow: "0 10px 30px rgba(0,0,0,0.18)",
            fontSize: 12,
            lineHeight: 1.55,
            color: "var(--color-ink)",
          }}
        >
          <p style={{ margin: "0 0 8px", color: "var(--color-ink-muted)" }}>{deliveryLabel(context.delivery)}</p>
          {b.plans.length > 0 && (
            <Section title="Plans">
              {b.plans.map((p) => (
                <li key={p.sessionId}>
                  {onOpenPlan ? (
                    <button type="button" onClick={() => onOpenPlan(p.sessionId)} style={linkStyle}>
                      {p.title}
                    </button>
                  ) : (
                    p.title
                  )}{" "}
                  <Muted>· {p.status} · {p.project}</Muted>
                </li>
              ))}
            </Section>
          )}
          {b.repos.length > 0 && (
            <Section title="Repos">
              {b.repos.map((r) => (
                <li key={r.path} title={r.path}>
                  {r.name} <Muted>· {repoState(r)}</Muted>
                </li>
              ))}
            </Section>
          )}
          {b.readyCount != null && b.readyCount > 0 && (
            <Section title={`Ready work (${b.readyCount})`}>
              {b.ready.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </Section>
          )}
          {b.mission && (
            <Section title="Mission">
              <li>
                {b.mission.title} <Muted>· {b.mission.goal}</Muted>
              </li>
            </Section>
          )}
          {b.decisions.length > 0 && (
            <Section title="Recent decisions">
              {b.decisions.map((d, i) => (
                <li key={i}>{d}</li>
              ))}
            </Section>
          )}
          {b.pages.length > 0 && (
            <Section title="Recently browsed">
              {b.pages.map((p) => (
                <li key={p.url} title={p.url}>
                  {p.title}
                </li>
              ))}
            </Section>
          )}
          {context.memory && (
            <Section title="Memory">
              <li>{context.memory}</li>
            </Section>
          )}
        </div>
      )}
    </span>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.04em", color: "var(--color-ink-muted)" }}>{title}</div>
      <ul style={{ margin: "2px 0 0", paddingLeft: 16 }}>{children}</ul>
    </div>
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return <span style={{ color: "var(--color-ink-muted)" }}>{children}</span>;
}

const linkStyle: React.CSSProperties = {
  padding: 0,
  border: "none",
  background: "none",
  color: "var(--color-info-text)",
  textDecoration: "underline",
  cursor: "pointer",
  font: "inherit",
};
