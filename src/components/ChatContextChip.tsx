// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

import { contextSummary, deliveryLabel, repoState, type ChatContext } from "../lib/chatRoom";

// What the room knows. The chat's first turn carries a workspace brief that
// Redline read from local state, so the agent answers without curling; this
// chip shows exactly what went in, so the user can see what the room can and
// cannot speak to. Collapsed by default: a summary line, never a wall.

export function ChatContextChip({
  context,
  onOpenPlan,
  maxWidth,
}: {
  context: ChatContext;
  onOpenPlan?: (sessionId: string) => void;
  maxWidth: number;
}) {
  const [open, setOpen] = useState(false);
  const parts = contextSummary(context);
  if (parts.length === 0) return null;
  const b = context.brief;
  return (
    <div data-chat-context className="font-sans shrink-0" style={{ paddingInline: 20, paddingTop: 8 }}>
      <div style={{ maxWidth, margin: "0 auto" }}>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          title="What Redline handed this conversation"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            maxWidth: "100%",
            fontSize: 11.5,
            padding: "3px 10px",
            borderRadius: 999,
            border: "1px solid var(--color-rule)",
            background: "transparent",
            color: "var(--color-ink-muted)",
            cursor: "pointer",
          }}
        >
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <span style={{ color: "var(--color-ink)", fontWeight: 600 }}>Context</span>
          <span className="truncate">· {parts.join(" · ")}</span>
        </button>
        {open && (
          <div
            data-chat-context-panel
            className="rl-thin-scroll-y"
            style={{
              marginTop: 6,
              maxHeight: 260,
              overflowY: "auto",
              padding: "10px 12px",
              borderRadius: 10,
              border: "1px solid var(--color-rule)",
              background: "var(--color-bg-elevated)",
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
      </div>
    </div>
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
