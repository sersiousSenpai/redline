// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian

// Pure vocabulary behind the chat room's Context chip and per-reply capture
// actions. Dependency-free and side-effect-free, so the room's rules are
// testable without a Tauri runtime.

/** Mirror of `workspace_brief::BriefInputs` (camelCase over the wire). */
export interface ChatBrief {
  plans: { sessionId: string; title: string; project: string; status: string; day: string }[];
  repos: { name: string; path: string; branch: string | null; dirty: number | null }[];
  /** `null` = the count could not be read: unknown, not zero. */
  readyCount: number | null;
  ready: string[];
  pages: { title: string; url: string }[];
  decisions: string[];
  mission: { title: string; goal: string } | null;
}

/** Mirror of `companion::CompanionContext`: what a turn injected. */
export interface ChatContext {
  companionId: string;
  delivery: "full" | "delta" | "unchanged";
  brief: ChatBrief;
  briefBytes: number;
  /** The prefetch's status line when the turn carried memory evidence. */
  memory: string | null;
  at: number;
}

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The chip's one-line summary, e.g. `["6 plans", "3 repos", "4 ready"]`. */
export function contextSummary(ctx: ChatContext): string[] {
  const b = ctx.brief;
  const parts: string[] = [];
  if (b.plans.length) parts.push(count(b.plans.length, "plan"));
  if (b.repos.length) parts.push(count(b.repos.length, "repo"));
  if (b.readyCount != null && b.readyCount > 0) parts.push(`${b.readyCount} ready`);
  if (b.pages.length) parts.push(count(b.pages.length, "page"));
  if (b.decisions.length) parts.push(count(b.decisions.length, "decision"));
  if (b.mission) parts.push("mission");
  if (ctx.memory) parts.push("memory");
  return parts;
}

/** How the last turn delivered the brief, said plainly. */
export function deliveryLabel(delivery: ChatContext["delivery"]): string {
  switch (delivery) {
    case "full":
      return "The whole brief went in with this conversation's first turn.";
    case "delta":
      return "The last turn carried only what changed since.";
    case "unchanged":
      return "Nothing changed since the last turn, so nothing was re-sent.";
  }
}

/** Git state for one repo line. */
export function repoState(repo: ChatBrief["repos"][number]): string {
  const dirty =
    repo.dirty == null ? "status unknown" : repo.dirty === 0 ? "clean" : count(repo.dirty, "changed file");
  return `${repo.branch ?? "no branch read"} · ${dirty}`;
}

const clip = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

/** The instruction for "→ Plan" on one reply. The graduation path carries
 *  the whole conversation; this names the reply the plan is built around. */
export function planFromReplyInstruction(reply: string): string {
  return `Build the plan around this idea from the conversation:\n\n${clip(reply.trim(), 4000)}`;
}

/** The note "Save idea" writes: the reply, tagged with the chat and the
 *  project so it is findable in the lake and filed by ClassMemory. */
export function ideaNote(
  reply: string,
  chat: { id: string; title: string },
  projectPath: string | null,
): string {
  const project = projectPath ? projectPath.replace(/\/+$/, "").split("/").pop() || projectPath : null;
  const tag = `💡 Idea from chat "${chat.title}"${project ? ` · project ${project}` : ""} [chat:${chat.id}]`;
  return `${tag}\n\n${clip(reply.trim(), 8000)}`;
}
