// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import type { ReactNode } from "react";

// The document plate's quiet zero-state: a serif title over muted prose.
// Extracted from App.tsx so the landing surface can build on it without
// reaching into the 5,000-line component.
export function EmptyState({ title, body }: { title: string; body: ReactNode }) {
  return (
    <div className="font-sans" style={{ color: "var(--color-ink-muted)" }}>
      <div
        className="font-serif font-semibold mb-2"
        style={{ color: "var(--color-ink)", fontSize: "22px" }}
      >
        {title}
      </div>
      <p style={{ fontSize: "14px", lineHeight: 1.6, maxWidth: "60ch" }}>
        {body}
      </p>
    </div>
  );
}
