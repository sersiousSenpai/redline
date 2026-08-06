// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useEffect, useMemo, useRef, useState } from "react";
import { rankCommands, type PaletteCommand } from "../lib/commands";
import { useMenuOverlay } from "./menuOverlay";
import { MenuSurface } from "./ui/MenuSurface";

// The ⌘K command palette (A5). Rendering and focus only — the registry and
// the fuzzy ranking are pure (lib/commands.ts), and App owns the open state
// plus the command closures. Registers with useMenuOverlay while open, the
// same contract as every header dropdown: the native browser webview paints
// above all DOM, so it must hide for the palette to be visible over it.
//
// Known limit (by design): keystrokes focused *inside* the native webview
// never reach our DOM, so ⌘K can't fire there — the header's ⌘K button is
// the mitigation.

interface CommandPaletteProps {
  open: boolean;
  commands: PaletteCommand[];
  onClose: () => void;
}

export function CommandPalette({ open, commands, onClose }: CommandPaletteProps) {
  useMenuOverlay(open);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const selectedRef = useRef<HTMLDivElement | null>(null);

  // A fresh open starts from a blank browse, not last search's leftovers.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSelected(0);
  }, [open]);

  const ranked = useMemo(
    () => rankCommands(commands, query),
    [commands, query],
  );
  // Clamp, don't reset, when the list shrinks under the cursor.
  const cursor = Math.min(selected, Math.max(0, ranked.length - 1));

  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: "nearest" });
  }, [cursor, ranked]);

  if (!open) return null;

  const run = (cmd: PaletteCommand) => {
    onClose();
    cmd.run();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (ranked.length) setSelected((cursor + 1) % ranked.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (ranked.length)
        setSelected((cursor - 1 + ranked.length) % ranked.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (ranked[cursor]) run(ranked[cursor]);
    }
  };

  const browsing = !query.trim();

  return (
    <div
      className="fixed inset-0"
      style={{ zIndex: 70 }}
      onMouseDown={onClose}
      onKeyDown={onKeyDown}
    >
      <MenuSurface
        role="dialog"
        ariaLabel="Command palette"
        className="absolute flex flex-col overflow-hidden"
        style={{
          top: "12vh",
          left: "50%",
          transform: "translateX(-50%)",
          width: "min(560px, calc(100vw - 32px))",
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSelected(0);
          }}
          placeholder="Type a command or a plan title…"
          aria-label="Search commands"
          spellCheck={false}
          className="font-sans w-full"
          style={{
            padding: "12px 16px",
            fontSize: "var(--rl-text-md)",
            background: "transparent",
            border: "none",
            outline: "none",
            color: "var(--color-ink)",
            borderBottom: "1px solid var(--color-rule)",
          }}
        />
        <div
          role="listbox"
          aria-label="Commands"
          className="overflow-y-auto"
          style={{ maxHeight: "52vh", padding: "6px 0" }}
        >
          {ranked.length === 0 && (
            <div
              className="font-sans px-4 py-3"
              style={{
                fontSize: "var(--rl-text-sm)",
                color: "var(--color-ink-muted)",
              }}
            >
              No matching commands
            </div>
          )}
          {ranked.map((cmd, i) => (
            <div key={cmd.id}>
              {browsing && (i === 0 || ranked[i - 1].group !== cmd.group) && (
                <div
                  className="font-sans px-4 pt-2 pb-1"
                  style={{
                    fontSize: "var(--rl-text-xs)",
                    fontWeight: 600,
                    letterSpacing: "0.04em",
                    textTransform: "uppercase",
                    color: "var(--color-ink-muted)",
                  }}
                >
                  {cmd.group}
                </div>
              )}
              <div
                ref={i === cursor ? selectedRef : undefined}
                role="option"
                aria-selected={i === cursor}
                className="flex items-center gap-3 px-4 py-1.5"
                style={{
                  cursor: "pointer",
                  background:
                    i === cursor ? "var(--color-anchor-bg)" : "transparent",
                }}
                // Keep focus in the input so typing never drops keystrokes.
                onMouseDown={(e) => e.preventDefault()}
                onMouseMove={() => {
                  if (i !== cursor) setSelected(i);
                }}
                onClick={() => run(cmd)}
              >
                <span
                  className="font-sans truncate"
                  style={{
                    fontSize: "var(--rl-text-sm)",
                    color: "var(--color-ink)",
                  }}
                >
                  {cmd.title}
                </span>
                {cmd.detail && (
                  <span
                    className="font-sans truncate"
                    style={{
                      fontSize: "var(--rl-text-xs)",
                      color: "var(--color-ink-muted)",
                    }}
                  >
                    {cmd.detail}
                  </span>
                )}
                {cmd.keys && (
                  <span className="rl-shortcut-keys ml-auto shrink-0" style={{ minWidth: 0 }}>
                    {cmd.keys.map((k) => (
                      <kbd key={k}>{k}</kbd>
                    ))}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      </MenuSurface>
    </div>
  );
}
