// Synthetic Tauri boundary for the renderer memory soak (scripts/memory-soak.mjs).
// An in-page event bus stands in for the backend's events, and `invoke` answers
// the few commands the mounted surfaces call. No database, agent or network.

type Handler = (event: { payload: unknown }) => void;
const handlers = new Map<string, Set<Handler>>();

export async function listen(event: string, handler: Handler) {
  let set = handlers.get(event);
  if (!set) handlers.set(event, (set = new Set()));
  set.add(handler);
  return () => {
    set.delete(handler);
  };
}

/** Deliver one backend event to every live listener, as `app.emit` would. */
export function deliver(event: string, payload: unknown) {
  for (const handler of handlers.get(event) ?? []) handler({ payload });
}

/** Live listeners across every event — a surface that unmounts cleanly
 *  returns this to where it was before it mounted. */
export function listenerCount(): number {
  let n = 0;
  for (const set of handlers.values()) n += set.size;
  return n;
}

export async function emit() {}
export async function emitTo() {}
export async function once() {
  return () => {};
}
export function convertFileSrc(path: string) {
  return path;
}
export function isTauri() {
  return false;
}
export class Channel {
  onmessage = () => {};
}

/** What the next history load and repo-icon lookup return. */
export const knobs = { historyRows: 0, iconBytes: 256 * 1024 };

function historyRow(id: string, i: number) {
  const role = i % 2 ? "assistant" : "user";
  const body =
    role === "user"
      ? `Question ${i}: how does the cache stay bounded over a week of uptime?`
      : `Answer ${i}. The cache keeps **the newest entries** and drops the oldest.\n\n- one\n- two\n\n\`\`\`ts\nconst keep = ${i};\n\`\`\``;
  return { id: `${id}-h${i}`, companionId: id, role, body, status: "complete", createdAt: i };
}

export async function invoke(cmd: string, args: Record<string, unknown> = {}) {
  switch (cmd) {
    case "soak_thread": {
      const id = String(args.companionId);
      return Array.from({ length: knobs.historyRows }, (_, i) => historyRow(id, i));
    }
    case "companion_turn_status":
      return { streaming: false, startedAt: null, partial: null, seq: 0, queued: [] };
    case "repo_icon": {
      // The repo's logo: the same bytes for every directory of a repo, but a
      // fresh, flat string each time, as a JSON-decoded IPC response is
      // (`"A".repeat(n)` would be a rope sharing one leaf, and cost nothing).
      const cwd = String(args.cwd);
      const root = cwd.split("/").slice(0, 3).join("/");
      const chunks = Array.from({ length: knobs.iconBytes / 64 }, (_, i) => `${root}:${i}`.padEnd(64, "A"));
      return { root, name: root.split("/").pop(), dataUrl: `data:image/png;base64,${chunks.join("")}` };
    }
    default:
      return null;
  }
}
