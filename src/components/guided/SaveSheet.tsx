import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { UsePush } from "../../hooks/usePush";
import { useMenuOverlay } from "../menuOverlay";
import type { ActionResult } from "./types";
export function SaveSheet({
  reviewId,
  fingerprint,
  push,
  onDone,
  onClose,
}: {
  reviewId: string;
  fingerprint: string | null;
  push: UsePush;
  onDone: (action: ActionResult) => void;
  onClose: () => void;
}) {
  const [message, setMessage] = useState(""),
    [notice, setNotice] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  useMenuOverlay(true);
  useEffect(() => {
    let alive = true;
    void push.draft().then((draft) => {
      if (alive && draft) {
        setMessage((current) => current || draft.subject);
        setNotice(draft.notice ?? null);
      }
    });
    return () => {
      alive = false;
    };
  }, [push.draft]);
  return (
    <div className="guided-backdrop">
      <form
        role="dialog"
        aria-modal="true"
        aria-label="Save a version"
        className="guided-sheet"
        onSubmit={(e) => {
          e.preventDefault();
          if (!fingerprint) return;
          setBusy(true);
          setError(null);
          void invoke<ActionResult>("guided_save", {
            reviewId,
            message,
            fingerprint,
          })
            .then(onDone)
            .catch((e) => setError(String(e)))
            .finally(() => setBusy(false));
        }}
      >
        <h2>Save a version</h2>
        <p>This saves the files you just reviewed on this computer.</p>
        <label>
          Describe this version
          <input
            autoFocus
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            className="rl-review-card-input"
            placeholder={
              push.drafting ? "Drafting a description…" : "What changed?"
            }
          />
        </label>
        {notice && <p className="guided-help">{notice}</p>}
        {error && <p role="alert">{error}</p>}
        <div className="guided-actions">
          <button
            type="submit"
            className="rl-review-btn rl-review-btn-primary"
            disabled={busy || !message.trim() || !fingerprint}
          >
            {busy ? "Saving…" : "Save a version"}
          </button>
          <button
            type="button"
            className="rl-review-btn"
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
