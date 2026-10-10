// SPDX-License-Identifier: Apache-2.0
import { createContext, useContext } from "react";
import { CONTINUE_EVENT, hasContinuationMessages, prepareConversationPreview, type ConversationSource } from "../lib/conversationContinuation";
export const ConversationSourceContext = createContext<ConversationSource | null>(null);
export function ContinueAs({ through, disabled = false }: { through?: string; disabled?: boolean }) {
  const source = useContext(ConversationSourceContext);
  if (!source) return null;
  // One of a reply's actions, in its tail row (ReplyBlock.css).
  return <button type="button" disabled={disabled || !hasContinuationMessages(source, through)} title="Prepare an editable brief with this conversation’s sources" className="rl-reply-action" data-tone="info" onClick={() => window.dispatchEvent(new CustomEvent(CONTINUE_EVENT, { detail: prepareConversationPreview(source, through) }))}>Continue as…</button>;
}
