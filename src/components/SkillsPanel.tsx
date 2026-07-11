// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useMenuOverlay } from "./menuOverlay";

// The Skills panel — duplicate-and-edit for the skill library. Built-in
// skills render as cards; "Duplicate" copies one into ~/.redline/skills/
// where it's freely editable (presence-only — reinstall never clobbers it).
// Remixing an opinionated default beats authoring from scratch: the defaults
// teach the format. Self-contained like AgentSeats: loads on open.

interface SkillCard {
  name: string;
  builtin: boolean;
  version?: number;
  path?: string;
  description?: string;
}

export function SkillsPanel() {
  const [open, setOpen] = useState(false);
  const [cards, setCards] = useState<SkillCard[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useMenuOverlay(open);

  const refresh = () => {
    void invoke<SkillCard[]>("list_skill_cards")
      .then(setCards)
      .catch((e) => setError(String(e)));
  };

  useEffect(() => {
    if (!open) return;
    refresh();
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const duplicate = async (name: string) => {
    setBusy(name);
    setError(null);
    try {
      await invoke<string>("duplicate_skill", { name });
      // Sync the copy to ~/.claude/skills like any user skill.
      await invoke("install_skill").catch(() => {});
      refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const builtins = cards.filter((c) => c.builtin);
  const mine = cards.filter((c) => !c.builtin);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="font-sans rounded-sm px-2 py-0.5"
        style={{
          fontSize: "11px",
          border: "1px solid var(--color-rule)",
          background: "var(--color-paper)",
          color: "var(--color-ink)",
          cursor: "pointer",
        }}
      >
        Browse ▾
      </button>
      {open && (
        <div
          role="menu"
          aria-label="Skills"
          className="absolute right-0 z-50 rounded-md overflow-y-auto"
          style={{
            top: "calc(100% + 6px)",
            width: "300px",
            maxHeight: "60vh",
            border: "1px solid var(--color-rule)",
            background: "var(--color-bg-elevated)",
            boxShadow: "0 8px 24px rgba(0,0,0,0.28)",
          }}
        >
          {mine.length > 0 && (
            <div
              className="px-3 pt-2 pb-1 font-sans"
              style={{
                fontSize: "10px",
                fontWeight: 700,
                color: "var(--color-ink-muted)",
                textTransform: "uppercase",
                letterSpacing: "0.06em",
              }}
            >
              Your skills
            </div>
          )}
          {mine.map((card) => (
            <div
              key={card.name}
              className="px-3 py-2"
              style={{ borderBottom: "1px solid var(--color-rule)" }}
            >
              <div
                className="font-mono"
                style={{ fontSize: "11px", color: "var(--color-ink)" }}
              >
                {card.name}
              </div>
              {card.description && (
                <div
                  className="font-sans mt-0.5"
                  style={{ fontSize: "10px", color: "var(--color-ink-muted)" }}
                >
                  {card.description}
                </div>
              )}
              <div
                className="font-mono mt-1"
                style={{ fontSize: "9px", color: "var(--color-ink-muted)" }}
              >
                {card.path}
              </div>
            </div>
          ))}
          <div
            className="px-3 pt-2 pb-1 font-sans"
            style={{
              fontSize: "10px",
              fontWeight: 700,
              color: "var(--color-ink-muted)",
              textTransform: "uppercase",
              letterSpacing: "0.06em",
            }}
          >
            Built-in
          </div>
          {builtins.map((card) => (
            <div
              key={card.name}
              className="flex items-start gap-2 px-3 py-2"
              style={{ borderBottom: "1px solid var(--color-rule)" }}
            >
              <div className="flex-1 min-w-0">
                <span
                  className="font-mono"
                  style={{ fontSize: "11px", color: "var(--color-ink)" }}
                >
                  {card.name}
                </span>
                <span
                  className="font-mono ml-1.5"
                  style={{ fontSize: "9px", color: "var(--color-ink-muted)" }}
                >
                  v{card.version}
                </span>
                {card.description && (
                  <div
                    className="font-sans mt-0.5"
                    style={{
                      fontSize: "10px",
                      color: "var(--color-ink-muted)",
                    }}
                  >
                    {card.description}
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={() => void duplicate(card.name)}
                disabled={busy !== null}
                title={`Copy ${card.name} into ~/.redline/skills as my-${card.name} — yours to edit`}
                className="font-sans rounded-sm px-1.5 py-0.5 shrink-0"
                style={{
                  fontSize: "10px",
                  border: "1px solid var(--color-rule)",
                  background: "var(--color-paper)",
                  color: "var(--color-ink)",
                  cursor: busy ? "default" : "pointer",
                }}
              >
                {busy === card.name ? "Copying…" : "Duplicate"}
              </button>
            </div>
          ))}
          <div
            className="px-3 py-2 font-sans"
            style={{ fontSize: "10px", color: "var(--color-ink-muted)" }}
          >
            {error ??
              "Duplicates land in ~/.redline/skills/ — edit them freely; reinstall never overwrites yours."}
          </div>
        </div>
      )}
    </div>
  );
}
