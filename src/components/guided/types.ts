import type { GitStatus } from "../../types";
export interface ChangeGroup {
  title: string;
  plain: string;
  files: string[];
  kind: "feature" | "fix" | "content" | "config" | "cleanup";
}
export interface ChangeStory {
  summary: string;
  groups: ChangeGroup[];
  risks: string[];
  fallback: boolean;
}
export interface ActionCommand {
  command: string;
  meaning: string;
  ok: boolean;
}
export interface ConflictReport {
  files: string[];
  oursSummary: string;
  theirsSummary: string;
}
export interface ActionResult {
  repo?: string;
  undoId?: string;
  commands: ActionCommand[];
  conflict: ConflictReport | null;
  message: string;
}
export interface Workspace {
  id: string;
  repo: string;
  path: string;
  branch: string;
  title: string;
  baseSha: string;
  createdAt: number;
  state: string;
}
export interface WorkspaceCreated {
  workspace: Workspace;
  action: ActionResult;
}
export interface IncomingVersion {
  sha: string;
  subject: string;
  author: string;
  when: number;
  files: string[];
}
export interface SyncCheck {
  incoming: IncomingVersion[];
  incomingCount: number;
  outgoing: number;
  overlaps: string[];
  action: ActionResult;
}
export interface HistoryVersion {
  sha: string;
  subject: string;
  author: string;
  committedAt: number;
  parents: string[];
  refs: string[];
  filesChanged: number;
  shared: boolean;
  fromTeam: boolean;
}
export interface WorkspaceStatus {
  workspace: Workspace;
  status: GitStatus | null;
}
