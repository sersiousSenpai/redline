// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! One line that says what you can do right here — "Select text to mark it."
//! in the plan panel's footer (board 4c) — and nothing more. Quiet by design:
//! the muted ink at the chrome's size, one line, cut with an ellipsis rather
//! than wrapping, so it never pushes the controls beside it. A hint is a
//! note, not a control; it takes no focus and has nothing to press.
//!
//! `keys` hangs a shortcut after the words in the same quiet type, for the
//! hints that have one ("Send marks to Claude  ⌘↩").

import type { ReactNode } from "react";
import "./ContextHint.css";

export function ContextHint({ children, keys, className }: {
  children: ReactNode;
  keys?: string;
  className?: string;
}) {
  return (
    <p className={className ? `rl-context-hint ${className}` : "rl-context-hint"}>
      <span className="rl-context-hint-text">{children}</span>
      {keys && <kbd className="rl-context-hint-keys">{keys}</kbd>}
    </p>
  );
}

export default ContextHint;
