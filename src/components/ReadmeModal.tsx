// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import readmeRaw from "../../README.md?raw";
import { MarkdownView } from "./MarkdownView";

// The README is embedded at build time (?raw) so the viewer always matches
// the version the user actually built — no runtime path to a checkout that
// may have moved. Two adjustments before rendering:
// - MarkdownView escapes raw HTML (html: false), which would print the
//   README's `<!-- … -->` placeholders as literal text; strip them.
// - Relative image paths only resolve on GitHub; point them at the raw
//   GitHub URL so they load when online and degrade to alt text offline.
const README_BODY = readmeRaw
  .replace(/<!--[\s\S]*?-->/g, "")
  .replace(
    /(!\[[^\]]*\]\()(?!https?:\/\/)/g,
    "$1https://raw.githubusercontent.com/sersiousSenpai/redline/main/",
  );

interface ReadmeModalProps {
  onClose: () => void;
}

// Opened from the native app menu's "View README". Mirrors CloseConfirmModal's
// overlay/elevated-card styling, sized up for a full document.
export function ReadmeModal({ onClose }: ReadmeModalProps) {
  return (
    <div
      className="fixed inset-0 flex items-center justify-center z-50"
      style={{ background: "var(--color-overlay)" }}
      onClick={onClose}
    >
      <div
        className="rounded-md shadow-xl border flex flex-col"
        style={{
          width: "min(720px, calc(100vw - 48px))",
          maxHeight: "80vh",
          borderColor: "var(--color-rule)",
          background: "var(--color-bg-elevated)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="flex items-center justify-between border-b px-6 py-3"
          style={{ borderColor: "var(--color-rule)" }}
        >
          <h2
            className="font-serif font-semibold"
            style={{ fontSize: "20px", color: "var(--color-ink)" }}
          >
            README
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded px-3 py-1.5"
            style={{
              background: "var(--color-bg-elevated)",
              border: "1px solid var(--color-rule)",
              color: "var(--color-ink-muted)",
              fontSize: "12px",
            }}
          >
            Close
          </button>
        </div>
        <div className="overflow-y-auto px-6 py-4">
          <MarkdownView body={README_BODY} />
        </div>
      </div>
    </div>
  );
}
