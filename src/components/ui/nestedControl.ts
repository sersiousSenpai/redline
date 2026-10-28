// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! A small control inside another control's `<button>`: the classic session
//! row's project line and plan-state label sit inside the row's
//! own button. Interactive content can't nest in a button (React warns on
//! every render, and HTML says the inner one is invalid), so these are spans
//! that keep a button's keys (Enter, Space), its focus stop, and the look a
//! `<button>` had there.

import type { CSSProperties, KeyboardEvent, MouseEvent } from "react";

/** What the user agent gave a `<button>` that a span doesn't have: block
 *  sizing in the line, and no inherited text-transform or alignment. */
export const NESTED_CONTROL_STYLE: CSSProperties = {
  display: "inline-block",
  textTransform: "none",
  textAlign: "center",
  textIndent: 0,
};

/** Button behaviour for a span, without reaching the outer button: the
 *  click and the keys stop here. */
export function nestedControl(action: () => void) {
  return {
    role: "button" as const,
    tabIndex: 0,
    onClick: (event: MouseEvent) => {
      event.stopPropagation();
      action();
    },
    onKeyDown: (event: KeyboardEvent) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      event.stopPropagation();
      action();
    },
  };
}
