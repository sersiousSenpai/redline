// SPDX-License-Identifier: Apache-2.0
import { useState } from "react";
import "./ChatWorkbench.css";
export interface QueueItem { id: string; text: string; mode: "chat" | "plan" | "build"; assignee?: "chat" | "agent" }
export function QueueTray({ rows, onSteer, onDelete, onEdit, onPromote }: { rows: QueueItem[]; onSteer: (id: string) => void; onDelete: (id: string) => void; onEdit: (id: string) => void; onPromote: (id: string) => void }) {
  const [menu, setMenu] = useState<string | null>(null);
  if (!rows.length) return null;
  return <div className="rl-queue-tray" aria-label="Queued messages">{rows.map(row => {
    const steerable = row.mode !== "plan" && row.assignee !== "agent";
    return <div className="rl-queue-tray-row" key={row.id}>
      <span title={row.mode} aria-label={row.mode}>{row.mode === "plan" ? "◇" : row.mode === "build" ? "⚒" : "◌"}</span>
      <span className="rl-queue-text" tabIndex={0}>{row.text}</span>
      <button type="button" disabled={!steerable || row.id.includes("-tmp-")} title={steerable ? "Deliver this instruction now; unavailable transports interrupt and send next" : "Plans and new agents wait for a quiet chat"} onClick={() => onSteer(row.id)}>↪ Steer</button>
      <button type="button" aria-label={`Delete ${row.text}`} onClick={() => onDelete(row.id)}>×</button>
      <div className="rl-queue-more"><button type="button" aria-label={`More actions for ${row.text}`} aria-expanded={menu === row.id} onClick={() => setMenu(menu === row.id ? null : row.id)}>⋯</button>
      {menu === row.id && <div role="menu"><button type="button" role="menuitem" onClick={() => { setMenu(null); onEdit(row.id); }}>Edit</button><button type="button" role="menuitem" onClick={() => { setMenu(null); onPromote(row.id); }}>Send next</button></div>}</div>
    </div>;
  })}</div>;
}
