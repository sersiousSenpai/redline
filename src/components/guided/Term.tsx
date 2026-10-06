// SPDX-License-Identifier: Apache-2.0
import { useState } from "react";
import { gitWords, type GitTerm } from "../../lib/gitWords";
export function Term({ term }: { term: GitTerm }) {
  const [open, setOpen] = useState(false),
    entry = gitWords[term];
  return (
    <span
      className="guided-term"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        className="guided-term-word"
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        {entry.word}
      </button>
      {open && (
        <span role="tooltip" className="guided-term-tip">
          {entry.explain}
          <br />
          <strong>Git calls this: {entry.real}</strong>
        </span>
      )}
    </span>
  );
}
