// Synthetic service boundary only. Production UI components are imported intact.
const noop = () => {};
const messages = Array.from({ length: 40 }, (_, i) => ({
  id: `qa-message-${i}`, companionId: "qa-carried", browseId: "qa-browse",
  role: i % 3 === 0 ? "user" : "assistant", status: "complete", createdAt: 1_789_286_000_000 + i * 1000,
  body: i % 3 === 0 ? `Compare source ${i + 1} and keep the important differences in view.` : `### Source ${i + 1}: evidence and next steps\n\nThis synthetic conversation exercises the real scrolling and composer layout. The page provides a readable explanation, with enough context to review while keeping the draft in reach.\n\n- Check the source and its publication date.\n- Compare the assumptions and note any missing evidence.\n- Keep the next action concise and useful.\n\n${"A long reply should scroll inside the conversation without moving its composer beyond the window. ".repeat(4)}`,
  surfaceKind: "chat", surfaceId: "qa-carried", surfaceLabel: null,
}));
export function useAgentTurn() { return { messages, liveText: "Reviewing the final source. " + "The conversation remains readable while this reply grows. ".repeat(35), status: "streaming", startedAt: Date.now() - 3000, loaded: true, send: noop, cancel: noop, unqueue: noop, clear: noop, meter: null, activity: [], meters: {} }; }
export function useReadAloud() { return { speaking: false, stop: noop, speak: noop }; }
export function useDictation() { return { listening: false, partial: "", toggle: noop }; }
export async function invoke(command: string) {
  if (command === "browser_home_feed") return { recent:[{url:"https://docs.example.test/start",title:"Getting started"},{url:"https://design.example.test/library",title:"Design library"}],frequent:[{url:"https://example.test",title:"Project dashboard"}],tasks:[{url:"https://docs.example.test/start",title:"Review the launch checklist",count:3}],missions:[{missionId:"qa-mission",title:"Research browser responsiveness"}] };
  if (command === "companion_list") return [{ companionId: "qa-carried", title: "Research carried into the browser", createdAt: 1_789_286_000_000 }];
  if (command === "browse_feedback_list") return {};
  if (/prefs|settings/.test(command)) return null;
  return [];
}
export async function listen() { return noop; }
export async function emit() {}
export async function emitTo() {}
export async function once() { return noop; }
export async function open() { return null; }
export async function openUrl() {}
export function convertFileSrc(path: string) { return path; }
export function isTauri() { return false; }
export class Channel { onmessage = noop; }

export function getCurrentWebview() { return { onDragDropEvent: async () => noop }; }
