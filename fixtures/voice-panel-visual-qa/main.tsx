import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { VoicePanel } from "../../src/components/VoicePanel";
import { DiscussPill } from "../../src/components/DiscussPill";
import { setVoiceAway } from "../../src/audio/voiceAway";
import { voiceCaption } from "../../src/audio/voiceCaption";
import { awayReply } from "../../src/audio/awayReply";
import { installDictation } from "../../src/audio/dictationHost";
import { applyTheme } from "../../src/theme/applyTheme";
import type { Section } from "../../src/types";
import "../../src/styles.css";

// Speech that "plays" each clip for a fixed time, so playback-driven behaviour
// (section pointing, hands-free, captures after a read-back) runs headless.
type Utterance = { text: string; onend?: () => void };
const playing: Utterance[] = [];
let clipMs = 700;
const tick = () => {
  const u = playing[0];
  if (!u) return;
  setTimeout(() => {
    if (playing[0] !== u) return;
    playing.shift();
    u.onend?.();
    tick();
  }, clipMs);
};
Object.defineProperty(window, "speechSynthesis", { configurable: true, value: {
  speak: (u: Utterance) => {
    playing.push(u);
    (window as unknown as { __qaSpoken: string[] }).__qaSpoken.push(u.text);
    if (playing.length === 1) tick();
  },
  cancel: () => { playing.length = 0; },
  pause: () => {},
  resume: () => {},
  getVoices: () => [],
  addEventListener() {},
  removeEventListener() {},
} });
(window as unknown as { __qaSpoken: string[] }).__qaSpoken = [];
(globalThis as unknown as { SpeechSynthesisUtterance: unknown }).SpeechSynthesisUtterance = class {
  onend?: () => void;
  constructor(public text: string) {}
};

const section = (anchorId: string, title: string, bodyMarkdown: string, children: Section[] = []): Section => ({
  anchorId, blockId: `b-${anchorId}`, level: anchorId.split(".").length, title, bodyMarkdown, children, paragraphs: [],
});
const SECTIONS = [section("A", "Session replay", "", [
  section("A.1", "Rollout", "Ship behind a flag, then widen."),
  section("A.2", "Risks", "Replay on remount can double-apply a turn."),
  section("A.3", "Testing", "Fixture tests over the reader."),
])];
const LOREM = "The reader is pure over its input and a sink, so the fixtures drive it with canned stream lines. ".repeat(6);

function Fixture() {
  const [width, setWidth] = useState(360);
  const [pressed, setPressed] = useState(0);
  const [opened, setOpened] = useState(0);
  const docRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    (window as unknown as { __qa: unknown }).__qa = {
      setTheme: applyTheme,
      setWidth,
      setAway: setVoiceAway,
      setCaption: voiceCaption.set,
      caption: voiceCaption.get,
      away: awayReply(),
      opened: () => opened,
      setClipMs: (ms: number) => { clipMs = ms; },
      /** Clips the fake speech still has to play. */
      playing: () => playing.length,
      pressed: () => pressed,
    };
    document.documentElement.dataset.qaReady = "true";
  }, [pressed, opened]);
  return (
    <main style={{ display: "flex", height: "100vh", overflow: "hidden", background: "var(--color-paper)", color: "var(--color-ink)" }}>
      <div className="relative flex-1 min-w-0 min-h-0" style={{ display: "flex", flexDirection: "column" }}>
        <div ref={docRef} data-qa="doc-scroll" style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
          <article className="doc-article mx-auto pl-16 py-10" style={{ maxWidth: 640, paddingBottom: "80vh" }}>
            <h1 data-anchor-id="A" style={{ fontSize: 26, fontWeight: 700 }}>Session replay</h1>
            <button type="button" data-qa="doc-button" onClick={() => setPressed((n) => n + 1)}>A button in the plan</button>
            <h2 data-anchor-id="A.1" style={{ fontSize: 20, fontWeight: 600, marginTop: 28 }}>Rollout</h2>
            <p data-anchor-id="A.1.p1">Ship behind a flag, then widen. {LOREM}</p>
            <h2 data-anchor-id="A.2" style={{ fontSize: 20, fontWeight: 600, marginTop: 28 }}>Risks</h2>
            <p data-anchor-id="A.2.p1">Replay on remount can <span data-comment-id="c1">double-apply a turn</span>. {LOREM}</p>
            <h2 data-anchor-id="A.3" style={{ fontSize: 20, fontWeight: 600, marginTop: 28 }}>Testing</h2>
            <p data-anchor-id="A.3.p1">{LOREM}{LOREM}</p>
          </article>
        </div>
        <DiscussPill onClick={() => setOpened((n) => n + 1)} />
      </div>
      <div data-qa="dock" style={{ width, display: "flex", flexShrink: 0, minHeight: 0 }}>
        <VoicePanel sessionId="qa-plan" markdown={"# Session replay\n\n## Rollout\n\nShip it."} sections={SECTIONS} onClose={() => {}} />
      </div>
    </main>
  );
}

// The hold-to-dictate key, on this window as in the app.
installDictation(() => null);
createRoot(document.getElementById("root")!).render(<Fixture />);
