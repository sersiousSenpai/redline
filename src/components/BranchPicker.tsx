// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useState } from "react";

import type { ReviewBranches } from "../types";

// The Local/Remote <optgroup> branch selector with a "Custom ref…" text
// fallback — lifted out of ReviewPanel's vsBase picker so the push dialog's
// target/base pickers share it instead of growing a fresh one.

// The custom-entry sentinel: NUL can never appear in a real branch name, so
// it can't collide with one (the lifted picker used a literal NUL byte; the
// escape form survives editors better).
const CUSTOM = "\u0000custom";

interface BranchPickerProps {
  branches: ReviewBranches | null;
  value: string | null;
  onChange: (v: string | null) => void;
  ariaLabel: string;
  placeholder?: string;
  /** Include remote branches as options (vsBase wants them; a push target is
   *  a local-style name, so the dialog turns them off). */
  includeRemote?: boolean;
  maxWidth?: number;
}

export default function BranchPicker({
  branches,
  value,
  onChange,
  ariaLabel,
  placeholder = "Pick a branch…",
  includeRemote = true,
  maxWidth = 200,
}: BranchPickerProps) {
  const [custom, setCustom] = useState(false);

  if (!branches || custom) {
    return (
      <input
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value || null)}
        placeholder="ref (e.g. main)"
        className="rl-review-select"
        style={{ width: 140 }}
        aria-label={ariaLabel}
        spellCheck={false}
        autoFocus={custom}
        onBlur={() => {
          // An emptied custom field falls back to the picker.
          if (custom && !value) setCustom(false);
        }}
      />
    );
  }

  return (
    <select
      value={value ?? ""}
      onChange={(e) => {
        if (e.target.value === CUSTOM) {
          setCustom(true);
          return;
        }
        onChange(e.target.value || null);
      }}
      className="rl-review-select"
      aria-label={ariaLabel}
      style={{ maxWidth }}
    >
      <option value="" disabled>
        {placeholder}
      </option>
      {branches.local.length > 0 && (
        <optgroup label="Local">
          {branches.local.map((b) => (
            <option key={`l:${b}`} value={b}>
              {b}
              {branches.head === b ? " (current)" : ""}
            </option>
          ))}
        </optgroup>
      )}
      {includeRemote && branches.remote.length > 0 && (
        <optgroup label="Remote">
          {branches.remote.map((b) => (
            <option key={`r:${b}`} value={b}>
              {b}
            </option>
          ))}
        </optgroup>
      )}
      <option value={CUSTOM}>Custom ref…</option>
    </select>
  );
}
