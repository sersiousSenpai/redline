// SPDX-License-Identifier: Apache-2.0
export type ConversationKind = "browse" | "companion" | "drafter";
export type ContinueDestination = "drafter" | "plan" | "auto";
export interface ContinuationMessage { id: string; role: string; body: string; status: string }
export interface ConversationSource { conversationKind: ConversationKind; conversationId: string; messages: ContinuationMessage[] }
export interface ContinueRequest { source: Omit<ConversationSource, "messages"> & { messageIds: string[]; idempotencyKey: string }; markdown: string; destination?: ContinueDestination }
export const CONTINUE_EVENT = "redline-continue-conversation";

const encoder = new TextEncoder();
export function continuationBriefError(markdown: string): string | null {
  if (!markdown.trim()) return "Write a brief before continuing.";
  return encoder.encode(markdown).length > 256_000 ? "The brief exceeds 256 KB. Shorten it before continuing; the original conversation stays saved." : null;
}
function excerpt(text: string, bytes: number): string {
  if (encoder.encode(text).length <= bytes) return text;
  let lo = 0, hi = Math.min(text.length, bytes);
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (encoder.encode(text.slice(0, mid)).length <= bytes) lo = mid;
    else hi = mid - 1;
  }
  if (lo > 0 && /[\uD800-\uDBFF]/.test(text[lo - 1])) lo--;
  return text.slice(0, lo);
}
export function hasContinuationMessages(source: ConversationSource, through?: string): boolean {
  const end = through ? source.messages.findIndex(message => message.id === through) + 1 : source.messages.length;
  return source.messages.slice(0, end).some(message => message.status === "complete" && (message.role === "user" || message.role === "assistant") && !!message.body.trim());
}

/** Role boundaries remain explicit: suggestions never become agreed decisions. */
export function prepareConversationPreview(source: ConversationSource, through?: string, options?: { instruction?: string }): ContinueRequest {
  const end = through ? source.messages.findIndex(m => m.id === through) + 1 : source.messages.length;
  const completed = source.messages.slice(0, end).filter(m => m.status === "complete" && (m.role === "user" || m.role === "assistant"));
  const selected: ContinuationMessage[] = [];
  let size = 0;
  for (const message of completed.slice(-100).reverse()) {
    const bytes = encoder.encode(message.body).length;
    if (size + bytes > 180_000) {
      if (!selected.length) selected.unshift({ ...message, body: excerpt(message.body, 179_800) + "\n[Preview excerpt; the full source message is linked to the saved brief.]" });
      break;
    }
    selected.unshift(message); size += bytes;
  }
  const direction = options?.instruction?.trim() || selected.find(m => m.role === "user")?.body;
  const objective = direction ? excerpt(direction, 4_000) + (encoder.encode(direction).length > 4_000 ? "\n[User direction continues in the source conversation below.]" : "") : "Review the source conversation and define the objective.";
  return {
    source: { conversationKind: source.conversationKind, conversationId: source.conversationId, messageIds: selected.map(m => m.id), idempotencyKey: crypto.randomUUID() },
    markdown: `# Conversation brief\n\n## Objective\n${objective}${options?.instruction?.trim() ? `\n\n## Final instruction\n${options.instruction.trim()}` : ""}\n\n## Decisions and requirements\nUse the user's statements below as the source of decisions and constraints. Assistant proposals remain suggestions unless the user accepted them.\n\n## Open questions and acceptance criteria\nResolve any outstanding questions in the conversation before treating a suggestion as an agreed requirement. Refine this section before continuing.\n\n## Source conversation\n${source.conversationKind}: ${source.conversationId}\n\n${selected.map(m => `### ${m.role === "user" ? "User direction" : "Assistant suggestion or response"} · ${m.id}\n${m.body}`).join("\n\n")}\n`,
  };
}

/** Identical prepared context cannot launch twice after a restart or UI retry. */
export async function continuationKey(source: ContinueRequest["source"], markdown: string, destination: ContinueDestination): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify([source.conversationKind, source.conversationId, source.messageIds, markdown, destination]));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

export function continuationOrigin(kind: ConversationKind): "chat" | "drafter" | "browser" {
  return kind === "companion" ? "chat" : kind === "drafter" ? "drafter" : "browser";
}
export function handoffGate(status: string, queued: number): boolean { return status === "idle" && queued === 0; }
