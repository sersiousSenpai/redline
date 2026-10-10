// The renderer memory soak's page (scripts/memory-soak.mjs drives it). Real
// surfaces, hooks and collab transport; only the Tauri boundary is synthetic
// (./services.ts). Each scenario is a function on `window.__soak` so the driver
// can force a garbage collection and read the heap between steps.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import * as Y from "yjs";
import { useAgentTurn } from "../../src/hooks/useAgentTurn";
import { MarkdownView } from "../../src/components/MarkdownView";
import StreamingBubble from "../../src/components/StreamingBubble";
import { createCollabProvider } from "../../src/collab/provider";
import { useRepoIcons } from "../../src/hooks/useRepoIcons";
import { deliver, knobs, listenerCount } from "./services";
import "../../src/styles.css";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

async function until(ready: () => boolean, ms = 10_000) {
  const end = performance.now() + ms;
  while (!ready()) {
    if (performance.now() > end) throw new Error("soak: timed out waiting for the page");
    await sleep(10);
  }
}

/** Mount a tree in its own root, the way a surface comes and goes. */
function mount(node: React.ReactNode): () => void {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  flushSync(() => root.render(node));
  return () => {
    root.unmount();
    host.remove();
  };
}

// --- A chat surface: the shared turn hook, settled bubbles, a live bubble ---

function Chat({ id }: { id: string }) {
  const turn = useAgentTurn({
    surface: "companion",
    key: id,
    idField: "companionId",
    historyCmd: "soak_thread",
    historyArgs: { companionId: id },
    sendFailPrefix: "Couldn't reach the soak agent",
    buildSendArgs: (text) => ({ companionId: id, text }),
    makeMessage: (seed) => ({ ...seed, createdAt: Date.now() }),
  });
  return (
    <div className="soak-chat" data-loaded={turn.loaded}>
      {turn.messages.map((m) => (
        <div key={m.id} className="soak-row">
          <MarkdownView body={m.body} rich />
        </div>
      ))}
      {turn.status === "streaming" && <StreamingBubble text={turn.liveText} agent="Claude" />}
    </div>
  );
}

/** A reply with the shapes real ones have: prose, a list, highlighted code,
 *  and every fourth one a diagram the model got wrong. */
function replyBody(t: number): string {
  const diagram = t % 4 === 3 ? "\n\n```mermaid\nthis is not a diagram {\n```\n" : "";
  return [
    `### Step ${t}`,
    "The reply streams in small pieces, the way a model's tokens arrive. ".repeat(6),
    "- keep the newest\n- drop the oldest\n- say what the cap is",
    "```ts\nexport function keepNewest<T>(rows: T[], max: number): T[] {\n  return rows.length > max ? rows.slice(-max) : rows;\n}\n```",
  ].join("\n\n") + diagram;
}

async function chatCycle(id: string, opts: { history: number; turns: number; deltas: number }) {
  knobs.historyRows = opts.history;
  const unmount = mount(<Chat id={id} />);
  await until(() => !!document.querySelector('.soak-chat[data-loaded="true"]'));
  for (let t = 0; t < opts.turns; t++) {
    const body = replyBody(t);
    const step = Math.ceil(body.length / opts.deltas);
    let seq = 0;
    for (let i = 0; i < body.length; i += step) {
      deliver("companion-delta", { companionId: id, seq: ++seq, text: body.slice(i, i + step) });
      await frame();
    }
    deliver("companion-done", { companionId: id, messageId: `${id}-a${t}`, body });
    await frame();
  }
  // Let the diagrams' debounce and their (async) renders finish.
  await sleep(1200);
  const rows = document.querySelectorAll(".soak-row").length;
  unmount();
  return { rows };
}

let closeLong: (() => void) | null = null;
async function openLongThread(rows: number) {
  knobs.historyRows = rows;
  closeLong = mount(<Chat id="long" />);
  await until(() => !!document.querySelector('.soak-chat[data-loaded="true"]'));
  await sleep(200);
  return { rows: document.querySelectorAll(".soak-row").length };
}
function closeLongThread() {
  closeLong?.();
  closeLong = null;
}

// --- Collab: what PlanEditor does per live room -----------------------------

/** ~66 KB of plan text, distinct per room, so a retained document shows. */
const planText = (room: number) =>
  Array.from({ length: 1000 }, (_, i) => `Room ${room}, paragraph ${i}: a plan line long enough to see.`).join("\n");

async function collabCycles(n: number) {
  for (let i = 0; i < n; i++) {
    const ydoc = new Y.Doc();
    ydoc.getText("plan").insert(0, planText(i));
    const handle = createCollabProvider(ydoc, {
      sessionId: "soak",
      threadStart: 1,
      version: i,
      // Nothing listens here: the socket fails and retries, as an unreachable
      // relay does. What matters is what the provider leaves behind.
      signaling: ["ws://127.0.0.1:9/soak"],
      secret: "soak-secret",
      invite: "soak-invite",
    });
    handle.awareness.setLocalStateField("user", { name: "soak", color: "#2f6f4f" });
    // y-webrtc derives the room key (PBKDF2) before it opens the room.
    await sleep(150);
    // PlanEditor's teardown: the provider goes, the doc is simply dropped.
    handle.destroy();
  }
  await sleep(300);
}

// --- Repo marks: one terminal wandering through directories ------------------

let setCwds: (cwds: string[]) => void = () => {};
function Icons() {
  const [cwds, set] = useState<string[]>([]);
  setCwds = set;
  const icons = useRepoIcons(cwds);
  return <span className="soak-icons" data-size={icons.size} />;
}

async function repoIconWalk(dirs: number, roots: number) {
  const unmount = mount(<Icons />);
  for (let i = 0; i < dirs; i++) {
    const cwd = `/repos/r${i % roots}/dir${i}`;
    flushSync(() => setCwds([cwd]));
    await sleep(2);
  }
  await sleep(200);
  const size = Number(document.querySelector(".soak-icons")?.getAttribute("data-size") ?? 0);
  unmount();
  return { cachedDirectories: size };
}

Object.assign(window, {
  __soak: {
    chatCycle,
    openLongThread,
    closeLongThread,
    collabCycles,
    repoIconWalk,
    listenerCount,
    leftoverDiagramNodes: () => document.querySelectorAll('[id^="drl-mermaid-"], [id^="rl-mermaid-"]').length,
  },
  // Handed to the driver so it can count live documents with queryObjects.
  __soakYDoc: Y.Doc.prototype,
});
document.documentElement.dataset.soakReady = "true";
