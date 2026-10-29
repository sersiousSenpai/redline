// SPDX-License-Identifier: Apache-2.0
import type { BackendChoice, ModelCatalogs } from "../lib/backendChoice";
import { ComposerMenu } from "./ComposerMenu";
import { BackendMenu } from "./FrontDoor";
import "./ChatWorkbench.css";
export type ChatMode = "chat" | "plan" | "build";
export type BuildAssignee = "chat" | "agent";
export const nextChatMode = (mode: ChatMode): ChatMode => mode === "chat" ? "plan" : mode === "plan" ? "build" : "chat";

/** The four ways a chat's ⏎ can go, as one menu's rows. */
const MODES = [
  { value: "chat", label: "Chat", detail: "Talk it through; nothing changes" },
  { value: "plan", label: "Plan", detail: "Hand it to a planning session" },
  { value: "build:chat", label: "Build · this chat", detail: "This chat makes the changes", group: "Build" },
  { value: "build:agent", label: "Build · new agent", detail: "A new agent builds it", group: "Build" },
] as const;

/** `Chat ▾`: the composer's mode chip, a composer menu like its siblings — a
 *  popover out of the card, a pick applies and closes. Plan and a new agent's
 *  build hand the work to a harness, so the harness chip (`BackendMenu`, the
 *  door's) comes into the row beside it for those two. */
export function ChatModePicker({ mode, onModeChange, assignee, onAssigneeChange, harness, onHarnessChange, catalogs = {}, onOpen, warning }: {
  mode: ChatMode; onModeChange: (mode: ChatMode) => void; assignee: BuildAssignee; onAssigneeChange: (assignee: BuildAssignee) => void;
  harness: BackendChoice; onHarnessChange: (choice: BackendChoice) => void; catalogs?: ModelCatalogs; onOpen?: () => void; warning?: string | null;
}) {
  const delegate = mode === "plan" || (mode === "build" && assignee === "agent");
  const value = mode === "build" ? `build:${assignee}` : mode;
  const label = MODES.find(row => row.value === value)!.label;
  return <>
    <ComposerMenu label="Mode" title="Switch mode (⇧Tab)" value={value} chip="mode" className={`rl-chat-mode-chip is-${mode}`}
      options={[...MODES]}
      onChange={next => {
        const [picked, who] = next.split(":") as [ChatMode, BuildAssignee | undefined];
        if (who) onAssigneeChange(who);
        onModeChange(picked);
      }}>{label}</ComposerMenu>
    {delegate && <BackendMenu choice={harness} onChange={onHarnessChange} modelCatalogs={catalogs}
      onOpen={() => onOpen?.()} compact={false} allowedBackends={["claude-code", "codex"]} />}
    {warning && <span className="rl-chat-build-warning" role="status">{warning}</span>}
  </>;
}
