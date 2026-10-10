// Synthetic service boundary only. Production UI components are imported intact.
const noop = () => {};
const messages = Array.from({ length: 40 }, (_, i) => ({
  id: `qa-message-${i}`, companionId: "qa-carried", browseId: "qa-browse",
  role: i % 3 === 0 ? "user" : "assistant", status: "complete", createdAt: 1_789_286_000_000 + i * 1000,
  body: i % 3 === 0 ? `Compare source ${i + 1} and keep the important differences in view.` : `### Source ${i + 1}: evidence and next steps\n\nThis synthetic conversation exercises the real scrolling and composer layout. The page provides a readable explanation, with enough context to review while keeping the draft in reach.\n\n- Check the source and its publication date.\n- Compare the assumptions and note any missing evidence.\n- Keep the next action concise and useful.\n\n${"A long reply should scroll inside the conversation without moving its composer beyond the window. ".repeat(4)}`,
  surfaceKind: "chat", surfaceId: "qa-carried", surfaceLabel: null,
}));
// The page chat's thread: context chips in the user's cards, work rows under
// the replies (folded reads, an action, an interrupted action), a live turn
// whose page action is running, and one message queued behind it.
const step = (at: number, label: string) => ({ at, kind: "tool", label });
const browse = (id: string, role: string, body: string, i: number) => ({ id, browseId: "qa-shared", role, body, status: "complete", createdAt: 1_789_286_000_000 + i * 1000, backend: "claude-code" });
const browseMessages = [
  browse("b-q1", "user", "> Pricing starts at $12 per seat per month, billed annually, with a free tier for up to three seats.\n\nIs that per month or per year?", 1),
  browse("b-a1", "assistant", "It is **per seat, per month**, billed once a year — so a team of five pays $720 up front. The free tier stops at three seats.", 2),
  browse("b-q2", "user", 'Inspect this element:\n\n```json\n{"tag":"button","accessibleName":"Start free trial","selectors":["#trial"]}\n```\n\nWhat happens if I press this?', 3),
  browse("b-a2", "assistant", "It opens the sign-up form on the same page; nothing is charged until the trial ends after 14 days.", 4),
  browse("b-q3", "user", "[Screenshot · tab 1 — Research overview: /tmp/qa-shot.png, 1200×800 — read the file to see it]\n\nFill in my work email and continue.", 5),
  browse("b-a3", "assistant", "I stopped there: you clicked into the page while I was typing, so I left the form as you have it.", 6),
  ...Array.from({ length: 6 }, (_, i) => [
    browse(`b-q${i + 4}`, "user", `Compare source ${i + 1} with this page.`, 7 + i * 2),
    browse(`b-a${i + 4}`, "assistant", `### Source ${i + 1}\n\n${"The page and the source agree on the price; they differ on the trial length and on what counts as a seat. ".repeat(3)}`, 8 + i * 2),
  ]).flat(),
];
const meter = (toolCalls: number, steps: ReturnType<typeof step>[]) => ({ model: "claude-sonnet-4-6", effort: null, serviceTier: null, speed: null, inputTokens: 6, outputTokens: 420, cacheReadTokens: 18000, cacheCreationTokens: 900, contextTokens: 18906, contextWindow: 200000, toolCalls, lastTool: null, lastToolLabel: null, thinkingTokens: null, stopReason: "end_turn", rateLimited: null, numTurns: 2, durationMs: 8200, costUsd: null, rev: 1, steps });
const browseMeters: Record<string, unknown> = {
  "b-a1": meter(3, [step(1, "reading the page…"), step(2, "searching the web…"), step(3, "fetching a page…")]),
  "b-a2": meter(2, [step(1, "clicking…"), step(2, "Clicked “Start free trial” · tab 1"), step(3, "reading the page…")]),
  "b-a3": meter(1, [step(1, "typing into the page…"), step(2, "Stopped — you took over the page · tab 1")]),
  ...Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`b-a${i + 4}`, meter(2, [step(1, `reading tab ${i + 2}…`), step(2, "reading the page…")])])),
};
export function useAgentTurn(config: { surface: string; key: string }) {
  if (config.surface === "browse" && config.key === "qa-empty") return { messages: [], queue: [], liveText: "", status: "idle", startedAt: null, loaded: true, send: noop, cancel: noop, unqueue: noop, clear: noop, meter: null, activity: [], meters: {} };
  if (config.surface === "browse") return {
    messages: browseMessages, queue: [browse("b-queued", "user", "> Trial length: 14 days\n\nand the annual discount?", 40)],
    liveText: "The cart now shows the team plan. " + "Checking the total against the pricing table before I answer. ".repeat(4),
    status: "streaming", startedAt: Date.now() - 6000, loaded: true, send: noop, cancel: noop, unqueue: async () => null, clear: noop,
    // The page action is the turn's newest event: no text has come after it.
    meter: { toolCalls: 3 }, activity: [step(Date.now() - 5000, "reading the page…"), step(Date.now() - 4000, "searching the web…"), step(Date.now() + 600_000, "acting on the page…")], meters: browseMeters,
  };
  return { messages, queue: [], liveText: "Reviewing the final source. " + "The conversation remains readable while this reply grows. ".repeat(35), status: "streaming", startedAt: Date.now() - 3000, loaded: true, send: noop, cancel: noop, unqueue: noop, clear: noop, meter: null, activity: [], meters: {} };
}
export function useReadAloud() { return { speaking: false, stop: noop, speak: noop }; }
export function useDictation() { return { listening: false, partial: "", toggle: noop }; }
export async function invoke(command: string) {
  if (command === "browser_home_feed") return { recent:[{url:"https://docs.example.test/start",title:"Getting started"},{url:"https://design.example.test/library",title:"Design library"}],frequent:[{url:"https://example.test",title:"Project dashboard"}],tasks:[{url:"https://docs.example.test/start",title:"Review the launch checklist",count:3}],missions:[{missionId:"qa-mission",title:"Research browser responsiveness"}] };
  if (command === "companion_list") return [{ companionId: "qa-carried", title: "Research carried into the browser", createdAt: 1_789_286_000_000 }];
  if (command === "browse_feedback_list") return {};
  if (command === "browse_list_get") return { list: {}, items: [
    { id: "i1", body: "Check the seat count on the team plan", done: false, pageTitle: "Research overview" },
    { id: "i2", body: "Compare the annual discount with source 2", done: false, pageTitle: "Evidence and source comparison" },
    { id: "i3", body: "Already done", done: true, pageTitle: "Research overview" },
  ] };
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
