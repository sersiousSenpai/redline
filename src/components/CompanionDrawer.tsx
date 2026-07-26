// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Mic } from "lucide-react";

import type {
  Companion,
  CompanionCancelledEvent,
  CompanionDeltaEvent,
  CompanionDoneEvent,
  CompanionErrorEvent,
  CompanionMessage,
} from "../types";
import { MarkdownView } from "./MarkdownView";
import { WorkingIndicator } from "./WorkingIndicator";

/** The drawer's docked width. App reserves this as a right margin on the root
 *  column while the drawer is open, so the window reflows beside it instead of
 *  being painted over — which is what makes the drawer usable over the
 *  browser surface (the native WKWebView would otherwise paint above it). */
export const COMPANION_DRAWER_WIDTH = 400;

interface CompanionDrawerProps {
  companion: Companion;
  companions: Companion[];
  onSwitch: (companionId: string) => void;
  onNew: () => void;
  onDelete: (companionId: string) => void;
  onClose: () => void;
  /** Open the voice panel for the current surface (closing this drawer
   *  first — one modality at a time). Null hides the mic (no voice target
   *  on this surface). */
  onVoice?: (() => void) | null;
}

type ChatStatus = "idle" | "streaming" | "error";

let tmpSeq = 0;
const tmpId = () => `ctmp-${++tmpSeq}`;

/** The per-turn surface chip: where the user was when the turn was sent —
 *  the Companion's analog of LinkedChat's tab chip. Pure for unit tests. */
export function surfaceChipLabel(
  msg: Pick<CompanionMessage, "role" | "surfaceKind" | "surfaceLabel">,
): string {
  if (msg.role !== "user") return "Companion";
  const names: Record<string, string> = {
    plan: "plan",
    drafter: "drafter",
    browser: "browser",
    review: "review",
    terminal: "terminal",
    welcome: "home",
  };
  const kind = msg.surfaceKind ? (names[msg.surfaceKind] ?? msg.surfaceKind) : null;
  if (!kind) return "You";
  const label = msg.surfaceLabel?.trim();
  return label ? `🧭 ${kind} — ${label}` : `🧭 ${kind}`;
}

/** The Companion drawer: a right-docked overlay hosting the ONE conversation
 *  that follows the user across every surface. Mounted at App root — an
 *  overlay sibling of MemoryInspector, deliberately OUTSIDE the secondary-pane
 *  exclusivity (it must coexist with the browser/drafter/review). The frontend
 *  passes nothing about location: `companion_send` grounds each turn on the
 *  backend's ActiveSurface mirror + journal delta. */
export function CompanionDrawer({
  companion,
  companions,
  onSwitch,
  onNew,
  onDelete,
  onClose,
  onVoice = null,
}: CompanionDrawerProps) {
  const companionId = companion.companionId;
  const [messages, setMessages] = useState<CompanionMessage[]>([]);
  const [liveText, setLiveText] = useState("");
  const [status, setStatus] = useState<ChatStatus>("idle");
  const [draft, setDraft] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  useEffect(() => {
    let alive = true;
    setLoaded(false);
    setMessages([]);
    setLiveText("");
    setStatus("idle");

    void invoke<CompanionMessage[]>("companion_get_thread", { companionId })
      .then((rows) => {
        if (!alive) return;
        setMessages(rows);
        setLoaded(true);
      })
      .catch(() => {
        if (alive) setLoaded(true);
      });

    const mine = (p: { companionId: string }) => p.companionId === companionId;

    const deltaP = listen<CompanionDeltaEvent>("companion-delta", (e) => {
      if (!alive || !mine(e.payload)) return;
      setStatus("streaming");
      setLiveText((t) => t + e.payload.text);
    });
    const doneP = listen<CompanionDoneEvent>("companion-done", (e) => {
      if (!alive || !mine(e.payload)) return;
      setMessages((m) => [
        ...m,
        {
          id: e.payload.messageId,
          companionId,
          role: "assistant",
          body: e.payload.body,
          status: "complete",
          surfaceKind: null,
          surfaceId: null,
          surfaceLabel: null,
          createdAt: Date.now(),
        },
      ]);
      setLiveText("");
      setStatus("idle");
    });
    const errorP = listen<CompanionErrorEvent>("companion-error", (e) => {
      if (!alive || !mine(e.payload)) return;
      setMessages((m) => [
        ...m,
        {
          id: tmpId(),
          companionId,
          role: "assistant",
          body: e.payload.error,
          status: "error",
          surfaceKind: null,
          surfaceId: null,
          surfaceLabel: null,
          createdAt: Date.now(),
        },
      ]);
      setLiveText("");
      setStatus("error");
    });
    const cancelP = listen<CompanionCancelledEvent>("companion-cancelled", (e) => {
      if (!alive || !mine(e.payload)) return;
      setLiveText("");
      setStatus("idle");
    });

    return () => {
      alive = false;
      void deltaP.then((un) => un());
      void doneP.then((un) => un());
      void errorP.then((un) => un());
      void cancelP.then((un) => un());
    };
  }, [companionId]);

  useEffect(() => {
    stickRef.current = true;
  }, [companionId]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [messages, liveText]);

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  }

  function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || status === "streaming") return;
    stickRef.current = true;
    // Optimistic user bubble — the surface tag arrives on reload from the
    // backend row (it reads ActiveSurface server-side).
    setMessages((m) => [
      ...m,
      {
        id: tmpId(),
        companionId,
        role: "user",
        body: trimmed,
        status: "complete",
        surfaceKind: null,
        surfaceId: null,
        surfaceLabel: null,
        createdAt: Date.now(),
      },
    ]);
    setLiveText("");
    setStatus("streaming");
    void invoke("companion_send", {
      companionId,
      text: trimmed,
      cwd: null,
    }).catch((err) => {
      setStatus("error");
      setMessages((m) => [
        ...m,
        {
          id: tmpId(),
          companionId,
          role: "assistant",
          body: `Couldn't reach the Companion: ${err}`,
          status: "error",
          surfaceKind: null,
          surfaceId: null,
          surfaceLabel: null,
          createdAt: Date.now(),
        },
      ]);
    });
  }

  function cancel() {
    void invoke("companion_cancel", { companionId }).catch(() => {});
  }

  return (
    <div
      className="fixed inset-y-0 right-0 z-40 flex flex-col"
      style={{
        width: `${COMPANION_DRAWER_WIDTH}px`,
        maxWidth: "90vw",
        background: "var(--color-paper)",
        borderLeft: "1px solid var(--color-rule)",
        boxShadow: "-8px 0 28px rgba(0,0,0,0.22)",
      }}
      data-companion-drawer="true"
    >
      <div
        className="flex shrink-0 items-start gap-1.5 px-3 py-2"
        style={{ borderBottom: "1px solid var(--color-rule)" }}
      >
        <span style={{ fontSize: "14px", lineHeight: "18px" }}>🧭</span>
        <div className="flex min-w-0 flex-1 flex-col">
          <span
            className="truncate"
            style={{ fontSize: "12.5px", fontWeight: 600, color: "var(--color-ink)" }}
          >
            {companion.title}
          </span>
          <span
            className="truncate"
            style={{ fontSize: "10px", color: "var(--color-ink-muted)" }}
          >
            {status === "streaming"
              ? "thinking…"
              : "follows you across the whole app · ⌘J"}
          </span>
        </div>
        {onVoice && (
          <button
            type="button"
            onClick={onVoice}
            title="Switch to voice for this surface"
            aria-label="Switch to voice for this surface"
            className="px-1 leading-none opacity-60 hover:opacity-100"
            style={{ color: "var(--color-ink-muted)" }}
          >
            <Mic size={14} strokeWidth={2} />
          </button>
        )}
        <div className="relative">
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            title="Companion sessions"
            className="px-1 leading-none opacity-60 hover:opacity-100"
            style={{ fontSize: "13px", color: "var(--color-ink-muted)" }}
          >
            ⋯
          </button>
          {menuOpen && (
            <div
              className="absolute right-0 z-50 mt-1 flex w-56 flex-col rounded py-1"
              style={{
                background: "var(--color-bg-elevated)",
                border: "1px solid var(--color-rule)",
                boxShadow: "0 8px 24px rgba(0,0,0,0.25)",
              }}
            >
              {companions.map((c) => (
                <button
                  key={c.companionId}
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    onSwitch(c.companionId);
                  }}
                  className="truncate px-2.5 py-1 text-left"
                  style={{
                    fontSize: "11.5px",
                    color:
                      c.companionId === companionId
                        ? "var(--color-info)"
                        : "var(--color-ink)",
                  }}
                >
                  {c.title}
                </button>
              ))}
              <div style={{ borderTop: "1px solid var(--color-rule)", margin: "3px 0" }} />
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  onNew();
                }}
                className="px-2.5 py-1 text-left"
                style={{ fontSize: "11.5px", color: "var(--color-ink)" }}
              >
                + New companion
              </button>
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  onDelete(companionId);
                }}
                className="px-2.5 py-1 text-left"
                style={{ fontSize: "11.5px", color: "var(--color-warning)" }}
              >
                Delete this conversation
              </button>
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          title="Close (⌘J)"
          className="px-1 leading-none opacity-60 hover:opacity-100"
          style={{ fontSize: "13px", color: "var(--color-ink-muted)" }}
        >
          ✕
        </button>
      </div>

      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="rl-thin-scroll-y flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-3 py-3"
      >
        {!loaded ? null : messages.length === 0 && status === "idle" ? (
          <div
            style={{ fontSize: "12px", color: "var(--color-ink-muted)", lineHeight: 1.5 }}
          >
            One conversation that follows you everywhere — plans, drafts, the
            browser, reviews. I keep track of where you've been while we're not
            talking, and I can check in with any surface's own agent when you
            need a synthesis. Ask me anything, from anywhere.
          </div>
        ) : (
          messages.map((m) => <Bubble key={m.id} msg={m} />)
        )}
        {status === "streaming" &&
          (liveText ? (
            <StreamingBubble text={liveText} />
          ) : (
            <WorkingIndicator />
          ))}
      </div>

      <div className="shrink-0 px-3 py-2" style={{ borderTop: "1px solid var(--color-rule)" }}>
        <Composer
          draft={draft}
          setDraft={setDraft}
          streaming={status === "streaming"}
          onSend={() => {
            send(draft);
            setDraft("");
          }}
          onStop={cancel}
        />
      </div>
    </div>
  );
}

function Bubble({ msg }: { msg: CompanionMessage }) {
  const isUser = msg.role === "user";
  const isError = msg.status === "error";
  return (
    <div className="flex flex-col gap-0.5">
      <span
        className="truncate"
        style={{
          fontSize: "9px",
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: "0.07em",
          color: isUser ? "var(--color-ink-muted)" : "var(--color-info)",
        }}
      >
        {surfaceChipLabel(msg)}
      </span>
      {isError ? (
        <div
          style={{
            fontSize: "12.5px",
            lineHeight: 1.5,
            whiteSpace: "pre-wrap",
            color: "var(--color-warning)",
          }}
        >
          {msg.body}
        </div>
      ) : (
        <MarkdownView body={msg.body} compact rich />
      )}
    </div>
  );
}

function StreamingBubble({ text }: { text: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span
        style={{
          fontSize: "9px",
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: "0.07em",
          color: "var(--color-info)",
        }}
      >
        Companion
      </span>
      {text ? (
        <div>
          <MarkdownView body={text} compact />
          <span style={{ color: "var(--color-ink-muted)" }}>▌</span>
        </div>
      ) : (
        <div style={{ fontSize: "12.5px", lineHeight: 1.5, color: "var(--color-ink-muted)" }}>
          working…
        </div>
      )}
    </div>
  );
}

function Composer({
  draft,
  setDraft,
  streaming,
  onSend,
  onStop,
}: {
  draft: string;
  setDraft: (s: string) => void;
  streaming: boolean;
  onSend: () => void;
  onStop: () => void;
}) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const autosize = () => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  };
  useEffect(autosize, [draft]);
  return (
    <div className="flex items-end gap-1.5">
      <textarea
        ref={taRef}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          autosize();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            if (!streaming) onSend();
          }
        }}
        placeholder="Ask from anywhere…"
        rows={2}
        disabled={streaming}
        className="flex-1 rounded px-2 py-1"
        style={{
          fontSize: "12px",
          border: "1px solid var(--color-rule)",
          background: "var(--color-paper)",
          color: "var(--color-ink)",
          fontFamily: "inherit",
          resize: "none",
          overflow: "hidden",
        }}
      />
      {streaming ? (
        <button
          type="button"
          onClick={onStop}
          className="rounded px-2 py-1 font-medium"
          style={{
            background: "var(--color-bg-elevated)",
            border: "1px solid var(--color-rule)",
            color: "var(--color-ink)",
            fontSize: "11px",
          }}
        >
          Stop
        </button>
      ) : (
        <button
          type="button"
          onClick={onSend}
          disabled={!draft.trim()}
          className="rounded px-2 py-1 font-medium"
          style={{
            background: "var(--color-info)",
            color: "var(--color-on-accent)",
            fontSize: "11px",
            opacity: draft.trim() ? 1 : 0.5,
          }}
        >
          Send
        </button>
      )}
    </div>
  );
}
