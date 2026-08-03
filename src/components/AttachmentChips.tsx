// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Paperclip, X } from "lucide-react";

import type { BinaryFile, CommentAttachment } from "../types";
import { formatBytes } from "../lib/attachmentNote";

/** Row of attached-file chips. `onRemove` makes them editable (the composer);
 *  omitting it renders them read-only (a saved comment's card). */
export function AttachmentChips({
  attachments,
  onRemove,
}: {
  attachments: CommentAttachment[];
  onRemove?: (path: string) => void;
}) {
  if (attachments.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 mt-2">
      {attachments.map((a) => (
        <Chip key={a.path} attachment={a} onRemove={onRemove} />
      ))}
    </div>
  );
}

function Chip({
  attachment,
  onRemove,
}: {
  attachment: CommentAttachment;
  onRemove?: (path: string) => void;
}) {
  const isImage = attachment.mime.startsWith("image/");
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-sm border pl-1 pr-1.5 py-0.5"
      title={`${attachment.name} · ${formatBytes(attachment.bytes)}`}
      style={{
        borderColor: "var(--color-rule)",
        background: "var(--color-paper)",
        fontSize: "11px",
        color: "var(--color-ink-muted)",
        maxWidth: "100%",
      }}
    >
      {isImage ? (
        <Thumbnail path={attachment.path} mime={attachment.mime} />
      ) : (
        <Paperclip size={12} aria-hidden />
      )}
      <span className="truncate" style={{ maxWidth: "140px" }}>
        {attachment.name}
      </span>
      {onRemove && (
        <button
          type="button"
          onClick={() => onRemove(attachment.path)}
          title={`Remove ${attachment.name}`}
          aria-label={`Remove ${attachment.name}`}
          className="flex items-center justify-center shrink-0"
          style={{ color: "var(--color-ink-muted)", cursor: "pointer" }}
        >
          <X size={11} aria-hidden />
        </button>
      )}
    </span>
  );
}

/** A tiny preview for an image attachment, loaded as a base64 data URL — the
 *  same route `FileViewer` uses, which works without the Tauri asset protocol.
 *  Falls back to the paperclip if the read fails, so a chip always renders. */
function Thumbnail({ path, mime }: { path: string; mime: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void invoke<BinaryFile>("read_file_base64", { path })
      .then((f) => {
        if (cancelled) return;
        if (f.data) setSrc(`data:${mime};base64,${f.data}`);
        else setFailed(true);
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [path, mime]);

  if (failed || !src) return <Paperclip size={12} aria-hidden />;
  return (
    <img
      src={src}
      alt=""
      className="rounded-sm shrink-0"
      style={{ width: "18px", height: "18px", objectFit: "cover" }}
    />
  );
}
