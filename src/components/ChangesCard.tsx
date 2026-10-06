// SPDX-License-Identifier: Apache-2.0
import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./ChatWorkbench.css";
export interface ChatChanges { messageId: string; projectPath: string; head: string; files: { path: string; added: number; removed: number; wasDirty: boolean; newFile: boolean }[]; undone: boolean }
export function ChangesCard({ changes, companionId, onReview, onUndone }: { changes: ChatChanges; companionId: string; onReview?: (path: string) => void; onUndone: () => void }) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const undoable = changes.files.some(file => !file.wasDirty);
  async function undo() { setBusy(true); setError(null); try { await invoke("companion_undo", { companionId, messageId: changes.messageId }); setConfirm(false); onUndone(); } catch (error) { setError(String(error)); } finally { setBusy(false); } }
  return <div className="rl-changes-card" aria-label="Build changes">
    <strong>{changes.undone ? "Changes undone" : `+${changes.files.reduce((n, f) => n + f.added, 0)} −${changes.files.reduce((n, f) => n + f.removed, 0)} · ${changes.files.length} files`}</strong>
    {!changes.files.length && <p>No working tree changes.</p>}
    <ul>{changes.files.map(file => <li key={file.path}>{file.path}{file.wasDirty && <small> · already had changes</small>}</li>)}</ul>
    {onReview && <button type="button" onClick={() => onReview(changes.projectPath)}>Review in Redline →</button>}
    {undoable && !changes.undone && !confirm && <button type="button" onClick={() => setConfirm(true)}>Undo</button>}
    {confirm && <div role="alert"><p>Restore files that were clean before this build? Earlier changes stay in place.</p><button type="button" disabled={busy} onClick={() => void undo()}>Confirm undo</button><button type="button" disabled={busy} onClick={() => setConfirm(false)}>Cancel</button></div>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
