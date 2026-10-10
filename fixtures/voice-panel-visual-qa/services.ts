// Synthetic service boundary only: a scripted voice backend. The panel, the
// pill and their audio modules are imported intact.
type Handler = (event: { payload: unknown }) => void;
const noop = () => {};
const handlers = new Map<string, Set<Handler>>();
const qa = window as unknown as {
  __qaCalls: Array<[string, unknown]>;
  __qaEmit: (event: string, payload: unknown) => void;
  __qaDictated: string;
  __qaTurn: number;
  __qaInFlight: boolean;
};
qa.__qaCalls = [];
qa.__qaDictated = "";
qa.__qaTurn = 0;
qa.__qaInFlight = false;
qa.__qaEmit = (event, payload) => {
  for (const fn of handlers.get(event) ?? []) fn({ payload });
};
const THREAD = [
  { id: "h1", sessionKey: "qa-plan", role: "you", text: "What's the riskiest part?", createdAt: 1 },
  {
    id: "h2",
    sessionKey: "qa-plan",
    role: "agent",
    text: "Replay on remount. ⟦§A.2⟧ It can apply the same turn twice.\n⟦screen⟧\n- The panel re-reads the thread on mount\n- A turn still streaming lands again",
    createdAt: 2,
  },
];
export async function invoke(command: string, args?: unknown) {
  qa.__qaCalls.push([command, args]);
  switch (command) {
    case "voice_session_start":
      return 1;
    case "voice_session_status":
      return { up: true, inFlight: qa.__qaInFlight, generation: 1, turn: qa.__qaTurn };
    case "voice_send":
      qa.__qaTurn += 1;
      return { generation: 1, turn: qa.__qaTurn };
    case "voice_interrupt":
      return { interrupting: true, generation: 1, turn: qa.__qaTurn };
    case "voice_thread":
      return THREAD;
    case "comment_offers_pending":
      return [];
    case "tts_get_settings":
      return { engine: "system" };
    // The studio voice: installed, its model still loading, Kokoro not set
    // up — so its stand-in is the (fake) system voice.
    case "tts_studio": {
      const op = (args as { op?: string } | undefined)?.op;
      if (op === "status")
        return {
          supported: true, model: "1.7B-CustomVoice-8bit", installed: true, runtimeCurrent: true,
          models: { "1.7B-CustomVoice-8bit": { speedRatio: 0.27 } }, state: "loading", reason: null,
          installing: false, speedRatio: 0.27, slow: false, pressure: 1,
        };
      if (op === "preflight")
        return { blockers: [], ramBytes: 48e9, freeMemoryBytes: 20e9, freeDiskBytes: 200e9, needDiskBytes: 4.5e9, needMemoryBytes: 4.2e9 };
      return null;
    }
    case "tts_kokoro_status":
      return { modelPresent: false, pythonReady: false };
    case "dictation_stop":
      return qa.__qaDictated;
    case "delete_comment":
      return true;
    default:
      return null;
  }
}
export async function listen(event: string, fn: Handler) {
  const set = handlers.get(event) ?? new Set<Handler>();
  set.add(fn);
  handlers.set(event, set);
  return () => set.delete(fn);
}
export class Channel {
  onmessage: (data: ArrayBuffer) => void = noop;
}
export async function emit() {}
export async function once() { return noop; }
export function isTauri() { return false; }
export function convertFileSrc(path: string) { return path; }
