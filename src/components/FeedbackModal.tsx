// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";

const NEW_ISSUE_URL = "https://github.com/sersiousSenpai/redline/issues/new";

interface FeedbackModalProps {
  onClose: () => void;
}

// Opened from the native app menu's "Send Feedback…". Feedback lands as a
// GitHub issue: the modal collects the message, then deep-links to the
// prefilled new-issue page so the user submits from their own account —
// no backend, no tokens in the binary, and reports stay publicly trackable.
export function FeedbackModal({ onClose }: FeedbackModalProps) {
  const [summary, setSummary] = useState("");
  const [message, setMessage] = useState("");

  const openIssue = async () => {
    const version = await getVersion().catch(() => "unknown");
    const body = `${message.trim()}\n\n---\nRedline v${version} · macOS`;
    const params = new URLSearchParams({
      title: summary.trim(),
      body,
      labels: "feedback",
    });
    void openUrl(`${NEW_ISSUE_URL}?${params.toString()}`).catch(() => {});
    onClose();
  };

  return (
    <div
      className="fixed inset-0 flex items-center justify-center z-50"
      style={{ background: "var(--color-overlay)" }}
      onClick={onClose}
    >
      <div
        className="rounded-md shadow-xl border p-6"
        style={{
          width: "min(560px, calc(100vw - 48px))",
          borderColor: "var(--color-rule)",
          background: "var(--color-bg-elevated)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2
          className="font-serif font-semibold mb-3"
          style={{ fontSize: "20px", color: "var(--color-ink)" }}
        >
          Send Feedback
        </h2>
        <p
          style={{
            fontSize: "13px",
            lineHeight: 1.55,
            color: "var(--color-ink-muted)",
            marginBottom: 14,
          }}
        >
          Feedback is filed as a GitHub issue. Continue opens GitHub with your
          message prefilled — review it there and press Submit to send.
        </p>
        <input
          type="text"
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          placeholder="One-line summary"
          autoFocus
          className="w-full rounded px-3 py-2 mb-3"
          style={{
            background: "var(--color-bg)",
            border: "1px solid var(--color-rule)",
            color: "var(--color-ink)",
            fontSize: "13px",
          }}
        />
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="What's working, what's broken, what's missing…"
          rows={6}
          className="w-full rounded px-3 py-2 resize-none"
          style={{
            background: "var(--color-bg)",
            border: "1px solid var(--color-rule)",
            color: "var(--color-ink)",
            fontSize: "13px",
            lineHeight: 1.5,
          }}
        />
        <div className="flex items-center justify-end gap-2 mt-4">
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
            Cancel
          </button>
          <button
            type="button"
            onClick={openIssue}
            disabled={summary.trim() === ""}
            className="rounded px-3 py-1.5 font-medium disabled:opacity-50"
            style={{
              background: "var(--color-info)",
              color: "var(--color-on-accent)",
              fontSize: "12px",
            }}
          >
            Continue on GitHub
          </button>
        </div>
      </div>
    </div>
  );
}
