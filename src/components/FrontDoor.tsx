// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Check, CornerDownLeft, Mic, Plus, X } from "lucide-react";
import { ProjectPicker, type ProjectOption } from "./ProjectPicker";
import { BlockedLaunch, ReadinessStrip } from "./ReadinessStrip";
import { WorkingIndicator } from "./WorkingIndicator";
import { useMenuOverlay } from "./menuOverlay";
import { useDictation } from "../lib/useDictation";
import {
  frontDoorSuggestions,
  otherDestination,
  projectNameFromPrompt,
  submitAction,
  type LaunchDestination,
} from "../lib/frontDoor";
import { attemptLaunch as gateLaunch, type ProjectChoice } from "../lib/launch";
import type { ReadinessItem } from "../lib/readiness";

// The front door. The document plate's resting state and where Redline opens:
// one line of type, one box, and ⏎ starts a real plan-mode session in a real
// project.
//
// The surface is built as ONE island — a single glass slab that changes shape
// rather than a stack of components that appear and disappear. It settles when
// idle, lifts on focus, grows with the text, and on ⏎ it becomes the Planning
// card in place. Everything secondary (suggestions, readiness, the explainer
// link) orbits that one object and fades rather than jumping.
//
// The gate matters as much as the look. Three routes silently break the
// promise (Paused interception captures nothing, a missing `claude` can't
// plan, an unapproved `/hooks` never delivers), so ⏎ is refused with the fix
// rendered inside the island itself. See lib/readiness.ts for the derivation.

function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1) || path;
}

export interface FrontDoorProps {
  /** Boot doors settled and sessions loaded — the door resolves after the
   *  choreography, never through it. */
  visible: boolean;
  text: string;
  onTextChange: (next: string | ((prev: string) => string)) => void;
  choice: ProjectChoice;
  onChoiceChange: (next: ProjectChoice) => void;
  projectOptions: ProjectOption[];
  /** Where ⏎ would launch right now — App runs `resolveLaunchProject`. */
  resolvedProject: string | null;
  attachments: string[];
  onAttachmentsChange: (next: string[]) => void;
  readiness: ReadinessItem[];
  /** Runs an item's fix; resolves true when the fault is cleared. */
  onFix: (item: ReadinessItem) => Promise<boolean>;
  /** The in-flight launch, or null. Ephemeral by design — a stale
   *  "Planning…" card must not survive a restart. */
  pending: { prompt: string; startedAt: number } | null;
  /** Launch, optionally overriding the resolved project (used right after a
   *  folder is created, when the chip's state hasn't landed yet). */
  onLaunch: (projectOverride?: string) => void;
  /** A ⏎ the LAUNCH path refused, after this component's own gate let it
   *  through (App re-checks readiness at call time). Rendered here rather than
   *  only as a toast: the fix button belongs where the user is already
   *  looking, which is what an in-component refusal already does. Nonce-keyed
   *  so the same blocker twice nudges twice. */
  refusal: { item: ReadinessItem | null; reason: string | null; nonce: number } | null;
  onDrafter: () => void;
  /** Where ⏎ sends. Sticky and persisted — `Plan ▾` sets it. */
  destination: LaunchDestination;
  onDestinationChange: (next: LaunchDestination) => void;
  onCancelPending: () => void;
  onHowItWorks: () => void;
  /** Create a project folder; resolves its absolute path, or null on
   *  failure (the error is surfaced by App as a toast). `kind: "extension"`
   *  additionally seeds the extension-pack scaffold and registers the type;
   *  `kind: "harness"` seeds a harness.json and link-installs it (A5a). */
  onCreateProject: (
    name: string,
    kind?: "extension" | "harness",
  ) => Promise<string | null>;
  /** Bumped by the type-to-start handoff: focus the composer and take the
   *  buffered keystrokes. */
  focusNonce: number;
  consumeSeed: () => string;
  /** False while the Voice panel owns the mic — one capture at a time. */
  dictationEnabled: boolean;
  /** Enterable harnesses — "your harnesses" beside "plan a build". The door
   *  is harness mode's entry point (a contextual entry on the resting
   *  state, never a header button). Empty hides the row. */
  harnesses?: { id: string; name: string }[];
  onEnterHarness?: (id: string) => void;
  /** Inside a harness the door wears ITS voice — the harness manifest's
   *  hero lines replace the stock ones, field by field. */
  hero?: { eyebrow?: string; title?: string; sub?: string } | null;
}

export function FrontDoor(props: FrontDoorProps) {
  const {
    visible,
    text,
    onTextChange,
    choice,
    onChoiceChange,
    projectOptions,
    resolvedProject,
    attachments,
    onAttachmentsChange,
    readiness,
    onFix,
    pending,
    onLaunch,
    refusal,
    onDrafter,
    destination,
    onDestinationChange,
    onCancelPending,
    onHowItWorks,
    onCreateProject,
    focusNonce,
    consumeSeed,
    dictationEnabled,
    harnesses = [],
    onEnterHarness,
    hero = null,
  } = props;

  const [entered, setEntered] = useState(false);
  useEffect(() => {
    if (!visible) return;
    const raf = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(raf);
  }, [visible]);

  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [focused, setFocused] = useState(false);

  // The door has to survive being squeezed. The document column floors at
  // `docMinFor` (300px, or 20% of the window) and the side panes curtain over
  // it below that — so anything from 300px up is a width this surface can
  // actually be handed, and the hero has to degrade instead of breaking.
  //
  // Measured, not a media query: the pane is not the viewport, and container
  // queries need Safari 16 while the README still claims macOS 11.
  //
  // HEIGHT is measured for the same reason and it is the axis that actually
  // bites: the pane is `100vh − header − terminal dock − footer`, and the dock
  // is user-draggable to nearly the whole window. The door's job is to fit
  // whatever it is handed, because the frame around it does not scroll.
  const [width, setWidth] = useState<number | null>(null);
  const [height, setHeight] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (!box) return;
      if (box.width) setWidth(box.width);
      if (box.height) setHeight(box.height);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // Unmeasured reads as roomy: the first paint is the common case and a
  // compact flash before the observer fires would be worse than a late one.
  const compact = width !== null && width < 560;
  const tight = width !== null && width < 430;
  const short = height !== null && height < 620;
  const squat = height !== null && height < 460;
  // The blocker ⏎ was refused on, surfaced inside the island.
  const [blocked, setBlocked] = useState<ReadinessItem | null>(null);
  // The "build this in a new folder" offer: `launchAfter` distinguishes the
  // ⏎ route (create, then launch) from the picker's `＋ New project…` row
  // (create, then just select it). `kind` is the project type — a plain
  // build, or an extension pack scaffolded to extend Redline itself.
  const [offer, setOffer] = useState<{
    name: string;
    launchAfter: boolean;
    kind: "app" | "extension" | "harness";
  } | null>(null);
  const [creating, setCreating] = useState(false);
  // A refused ⏎ has to LOOK refused. Every refusal below is a real condition
  // correctly enforced, but three of the four leave the composer looking
  // untouched and one is silent outright — so from the user's chair the key
  // did nothing and the sentence "just sits there". This is the one-shot
  // nudge: a nonce bumped on every refusal, driving a short shake on the
  // island. A keystroke that changes nothing on screen is the whole
  // complaint.
  // The nonce ALTERNATES the class rather than toggling one on and off. A CSS
  // animation restarts only when the animation-name changes, so re-adding the
  // same class in the same frame plays nothing — and the second ⏎ against the
  // same blocker is precisely the press that must not look ignored. Two names,
  // one keyframe set.
  const [refusedNonce, setRefusedNonce] = useState(0);
  // Why, when the reason isn't already rendered as a panel inside the island.
  const [refusedWhy, setRefusedWhy] = useState<string | null>(null);
  const refuse = useCallback((why?: string) => {
    setRefusedNonce((n) => n + 1);
    setRefusedWhy(why ?? null);
  }, []);
  // A refusal is a reaction to one keystroke, not furniture — same 6s as the
  // toast it replaces. Keyed on the nonce so a second refusal restarts the
  // clock instead of inheriting the first one's remainder.
  useEffect(() => {
    if (!refusedWhy) return;
    const t = window.setTimeout(() => setRefusedWhy(null), 6000);
    return () => window.clearTimeout(t);
  }, [refusedWhy, refusedNonce]);
  // A refusal from App's backstop gate. `blocked` gets the item so the fix
  // button lands in the island exactly as an in-component block does.
  const lastRefusal = useRef(refusal?.nonce ?? 0);
  useEffect(() => {
    if (!refusal || refusal.nonce === lastRefusal.current) return;
    lastRefusal.current = refusal.nonce;
    if (refusal.item) setBlocked(refusal.item);
    refuse(refusal.reason ?? undefined);
  }, [refusal, refuse]);

  // The composer's growth cap, as ONE number. It was a hard 300 in the effect
  // below AND a hard 300px in `.rl-fd-input`, which agreed only by accident and
  // was wrong in the same way on a short pane: 300px of textarea inside a 420px
  // pane leaves nothing for the island's own chrome, so the island grew past
  // the frame. Follow the pane instead — 38% of it, floored at ~3 lines — and
  // publish it so the stylesheet reads the same value rather than a copy.
  const inputCap = height ? Math.max(88, Math.round(height * 0.38)) : 300;

  // Auto-grow. The island is one continuous shape, so the box follows the
  // text instead of scrolling inside a fixed frame — up to the cap, after
  // which it scrolls. That inner scroller is the one on this surface that is
  // intentional and it stays.
  useLayoutEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, inputCap)}px`;
  }, [text, pending, inputCap]);

  // Type-to-start handoff. A LAYOUT effect, not a passive one: it must focus
  // and drain the seed buffer before the browser can dispatch the next
  // keydown, or a character would land out of order.
  const lastNonce = useRef(focusNonce);
  useLayoutEffect(() => {
    if (focusNonce === lastNonce.current) return;
    lastNonce.current = focusNonce;
    taRef.current?.focus();
    const seed = consumeSeed();
    if (seed) onTextChange((prev) => prev + seed);
  }, [focusNonce, consumeSeed, onTextChange]);

  // Autofocus when the door is the resting state — the whole point is that
  // you can start typing without aiming at anything.
  useEffect(() => {
    if (!visible || pending) return;
    taRef.current?.focus();
  }, [visible, pending]);

  const dictation = useDictation({
    enabled: dictationEnabled,
    onFinal: (spoken) =>
      onTextChange((prev) => (prev.trim() ? `${prev.trim()} ${spoken}` : spoken)),
  });

  // The island's growth into the document editor. Declared here, above the
  // send path, because `send` captures the FLIP's starting box on the gesture.
  const hasText = text.trim().length > 0;
  const canSubmit = hasText && !pending;

  const attemptLaunch = useCallback(() => {
    if (!canSubmit) return;
    // Gate, in order: a blocker refuses outright and renders its fix where
    // the user is already looking; a first-run user with nowhere to build is
    // offered a folder rather than dropped in $HOME. Both paths nudge, because
    // a panel appearing BELOW the composer is easy to miss when your eyes are
    // on the sentence you just pressed ⏎ on.
    //
    // This gate is the PLAN route's alone. Opening the Drafter needs no
    // `claude`, no hook and no interception mode — refusing to open a
    // document because a plan couldn't be captured would be nonsense.
    const gate = gateLaunch(readiness);
    if (gate.kind === "blocked") {
      setBlocked(gate.item);
      refuse();
      return;
    }
    if (projectOptions.length === 0 && !choice) {
      setOffer({ name: projectNameFromPrompt(text), launchAfter: true, kind: "app" });
      refuse();
      return;
    }
    setBlocked(null);
    setOffer(null);
    setRefusedWhy(null);
    onLaunch();
  }, [canSubmit, readiness, projectOptions.length, choice, text, onLaunch, refuse]);

  const send = useCallback(
    (to: LaunchDestination) => {
      // The one genuinely SILENT branch. `canSubmit` is false for two very
      // different reasons and only one of them is self-evident: an empty box
      // explains itself, a launch already in flight does not — and that is the
      // case where the sentence really is sitting in the composer with ⏎ doing
      // nothing. (It can't be: the Planning card replaces the composer. But it
      // is exactly the shape of the report, so it says so rather than
      // swallowing the key.)
      if (!canSubmit) {
        if (pending) refuse("A plan is already launching.");
        else if (!hasText) refuse();
        return;
      }
      if (to === "drafter") onDrafter();
      else attemptLaunch();
    },
    [canSubmit, pending, hasText, refuse, onDrafter, attemptLaunch],
  );

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const action = submitAction(
      {
        key: e.key,
        shiftKey: e.shiftKey,
        metaKey: e.metaKey,
        ctrlKey: e.ctrlKey,
        isComposing: e.nativeEvent.isComposing,
      },
      destination,
    );
    if (action === "ignore" || action === "newline") return;
    e.preventDefault();
    send(action);
  };

  const attach = async () => {
    try {
      const picked = await openDialog({ multiple: true });
      const paths = Array.isArray(picked)
        ? picked
        : typeof picked === "string"
          ? [picked]
          : [];
      if (paths.length > 0) {
        onAttachmentsChange([...new Set([...attachments, ...paths])]);
      }
    } catch {
      /* cancelled or dialog unavailable */
    } finally {
      taRef.current?.focus();
    }
  };

  const createFromOffer = async () => {
    if (!offer || creating) return;
    setCreating(true);
    const launchAfter = offer.launchAfter;
    const path = await onCreateProject(
      offer.name,
      offer.kind === "app" ? undefined : offer.kind,
    ).finally(() => setCreating(false));
    if (!path) return;
    onChoiceChange({ path });
    setOffer(null);
    // Launch into the fresh folder directly: the chip's state change hasn't
    // reached App's `resolvedProject` yet, and this launch is that folder's
    // whole reason to exist.
    if (launchAfter) onLaunch(path);
  };

  // `new-project` is the one fix App can't answer on its own — it needs a
  // name, and asking for one is this surface's job.
  const handleFix = useCallback(
    async (item: ReadinessItem) => {
      if (item.fix?.kind === "new-project") {
        setOffer({ name: projectNameFromPrompt(text), launchAfter: false, kind: "app" });
        return true;
      }
      return onFix(item);
    },
    [onFix, text],
  );

  const suggestions = useMemo(
    () => frontDoorSuggestions(resolvedProject ? basename(resolvedProject) : null),
    [resolvedProject],
  );
  // Squeezed, the chips are the first thing to go: they are a way in, and a
  // door narrow enough to wrap them into three rows has no room to spare for
  // one.
  const suggestionsHidden = hasText || !!pending || !!offer || tight;

  // The island's shape state. `lifted` is focus-or-content: the slab settles
  // when you aren't using it and rises when you are.
  const lifted = focused || hasText || !!pending;
  const islandClass = [
    "rl-fd-island",
    lifted ? "is-lifted" : "",
    pending ? "is-planning" : "",
    refusedNonce === 0 ? "" : refusedNonce % 2 ? "is-refused" : "is-refused-alt",
  ]
    .filter(Boolean)
    .join(" ");

  const rootClass = [
    "rl-frontdoor font-sans",
    entered ? "is-in" : "",
    compact ? "is-compact" : "",
    tight ? "is-tight" : "",
    short ? "is-short" : "",
    squat ? "is-squat" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      ref={rootRef}
      className={rootClass}
      data-tour="landing"
      // Published so `.rl-fd-input`'s max-height is the SAME number the
      // auto-grow effect clamps to, rather than a copy that drifts.
      style={{ "--rl-fd-input-max": `${inputCap}px` } as React.CSSProperties}
    >
      <div className="rl-fd-paper" aria-hidden />

      {/* The stance, not another question — the composer's placeholder is
          already asking one. "Redline" is the verb, which is the whole point
          of the product and the shortest way to say it. Inside a harness the
          manifest's hero speaks instead, field by field — the door is the
          one place the resting state carries a brand voice. */}
      <div className="rl-fd-eyebrow">{hero?.eyebrow || "Plan mode"}</div>
      <h1 className="rl-fd-title font-serif">
        {hero?.title || "Every build starts as a draft."}
      </h1>
      <p className="rl-fd-sub">
        {hero?.sub || "Describe it. Redline the plan. Then build."}
      </p>

      <div className={islandClass}>
        {pending ? (
          <PlanningCard
            pending={pending}
            onCancel={onCancelPending}
            readiness={readiness}
            onFix={handleFix}
          />
        ) : (
          <div className="rl-fd-morph">
            {attachments.length > 0 && (
              <div className="rl-fd-attach">
                {attachments.map((p) => (
                  <span key={p} className="rl-fd-chip" title={p}>
                    {basename(p)}
                    <button
                      type="button"
                      onClick={() =>
                        onAttachmentsChange(attachments.filter((a) => a !== p))
                      }
                      title="Remove"
                      className="rl-fd-x"
                    >
                      <X size={11} />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <textarea
              ref={taRef}
              className="rl-fd-input rl-thin-scroll-y"
              placeholder="What do you want to build?"
              value={text}
              rows={1}
              spellCheck
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              onChange={(e) => onTextChange(e.target.value)}
              onKeyDown={onKeyDown}
            />
            {dictation.listening && (
              <div className="rl-fd-partial">
                {dictation.partial || "Listening…"}
              </div>
            )}
            <div className="rl-fd-tools">
              <button
                type="button"
                onClick={attach}
                title="Attach files as context"
                className="rl-fd-tool"
              >
                <Plus size={14} />
              </button>
              <ProjectPicker
                options={projectOptions}
                value={choice ? choice.path : resolvedProject}
                onChange={(path) => onChoiceChange({ path })}
                onNewProject={() =>
                  setOffer({
                    name: projectNameFromPrompt(text),
                    launchAfter: false,
                    kind: "app",
                  })
                }
                onAfterPick={() => taRef.current?.focus()}
                chromeless
              />
              <PlanMenu
                destination={destination}
                onDestinationChange={onDestinationChange}
              />
              <div style={{ flex: 1 }} />
              {dictation.error && (
                <span className="rl-fd-err" title={dictation.error}>
                  mic error
                </span>
              )}
              <button
                type="button"
                onClick={dictation.toggle}
                disabled={!dictationEnabled}
                title={
                  dictationEnabled
                    ? dictation.listening
                      ? "Stop dictating"
                      : "Dictate"
                    : "The voice panel is using the microphone"
                }
                className={`rl-fd-tool${dictation.listening ? " is-hot" : ""}`}
              >
                <Mic size={14} />
              </button>
              <button
                type="button"
                onClick={() => send(destination)}
                disabled={!canSubmit}
                title={
                  destination === "drafter"
                    ? "Open this in the drafter (⏎)"
                    : "Plan this (⏎)"
                }
                className={`rl-fd-go${canSubmit ? " is-armed" : ""}`}
              >
                <CornerDownLeft size={15} />
              </button>
            </div>
          </div>
        )}

        {/* A refusal with no panel of its own — the only one that would
            otherwise be completely silent. `role="status"` so a screen reader
            hears the same thing the shake says. */}
        {refusedWhy && !blocked && !offer && (
          <div className="rl-fd-refused" role="status">
            {refusedWhy}
          </div>
        )}

        <BlockedLaunch
          blocked={blocked}
          readiness={readiness}
          onFix={onFix}
          onShow={setBlocked}
          onProceed={() => onLaunch()}
        />

        {offer && (
          <NewProjectOffer
            name={offer.name}
            busy={creating}
            kind={offer.kind}
            onKind={(kind) => setOffer({ ...offer, kind })}
            onName={(name) => setOffer({ ...offer, name })}
            onCreate={createFromOffer}
            onCancel={() => setOffer(null)}
            onSkip={
              offer.launchAfter
                ? () => {
                    setOffer(null);
                    onLaunch();
                  }
                : undefined
            }
          />
        )}
      </div>

      {/* Orbit: everything secondary fades against the island rather than
          shifting it. The chips retire the moment there is a sentence to
          finish — they are a way in, not furniture.
          The collapse is a `grid-template-rows: 1fr → 0fr` on the WRAPPER,
          not a max-height on the row: a fixed max-height is a lie the moment
          the chips wrap to a second line, and the overflow lands on top of
          whatever sits below. This version collapses any height correctly. */}
      <div
        className={`rl-fd-suggest-wrap${suggestionsHidden ? " is-hidden" : ""}`}
        aria-hidden={suggestionsHidden}
      >
        <div className="rl-fd-suggestions">
          {suggestions.map((s) => (
            <button
              key={s.label}
              type="button"
              className="rl-fd-suggestion"
              tabIndex={suggestionsHidden ? -1 : 0}
              onClick={() => {
                onTextChange(s.text);
                taRef.current?.focus();
              }}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {/* "Your harnesses" — the other doors this build can open. Same orbit
          discipline as the suggestions: a way in, not furniture — the row
          retires the moment there is a sentence to finish. */}
      {harnesses.length > 0 && onEnterHarness && (
        <div
          className={`rl-fd-suggest-wrap${suggestionsHidden ? " is-hidden" : ""}`}
          aria-hidden={suggestionsHidden}
        >
          <div className="rl-fd-suggestions">
            <span
              className="font-sans"
              style={{
                fontSize: "var(--rl-text-xs)",
                color: "var(--color-ink-muted)",
                alignSelf: "center",
              }}
            >
              Your harnesses
            </span>
            {harnesses.map((h) => (
              <button
                key={h.id}
                type="button"
                className="rl-fd-suggestion"
                tabIndex={suggestionsHidden ? -1 : 0}
                title={`Enter ${h.name} — a harness running on Redline`}
                onClick={() => onEnterHarness(h.id)}
              >
                {h.name}
              </button>
            ))}
          </div>
        </div>
      )}

      <ReadinessStrip items={readiness} onFix={handleFix} />

      <button type="button" className="rl-fd-how" onClick={onHowItWorks}>
        How Redline works
      </button>
    </div>
  );
}

/** After ⏎ the island doesn't disappear — it becomes this. The prompt as
 *  submitted, a live indicator, and where to watch it, so the hero never sits
 *  there looking unchanged while a terminal quietly scrolls. This is also
 *  where the 90s `/hooks` nudge lands — the one failure with no other signal
 *  at all. */
function PlanningCard({
  pending,
  onCancel,
  readiness,
  onFix,
}: {
  pending: { prompt: string; startedAt: number };
  onCancel: () => void;
  readiness: ReadinessItem[];
  onFix: (item: ReadinessItem) => Promise<boolean>;
}) {
  const nudge = readiness.find((i) => i.id === "hook-unapproved");
  return (
    <div className="rl-fd-morph">
      <div className="rl-fd-planning-prompt">{pending.prompt}</div>
      <div className="rl-fd-tools">
        <WorkingIndicator label="Planning" startedAt={pending.startedAt} />
        <span className="rl-fd-detail">watch it in the terminal below ↓</span>
        <div style={{ flex: 1 }} />
        <button type="button" className="rl-fd-quiet" onClick={onCancel}>
          start something else
        </button>
      </div>
      {nudge && (
        <div className="rl-fd-block">
          <ReadinessStrip items={[nudge]} onFix={onFix} />
        </div>
      )}
    </div>
  );
}

const DESTINATIONS: { id: LaunchDestination; label: string; chip: string }[] = [
  { id: "plan", label: "Plan a build", chip: "Plan" },
  { id: "drafter", label: "Draft a document first", chip: "Draft" },
];

/** `Plan ▾` — a DESTINATION picker, not a model picker, and a STICKY one.
 *  Choosing a row sets where ⏎ goes and leaves it set: a session spent
 *  shaping long briefs shouldn't mean reaching for a modifier every time.
 *  Picking never sends — you choose the destination, then write.
 *
 *  The modifier always holds the OTHER destination, so both stay one
 *  keystroke away in either mode, and the rows show the live key so the
 *  binding is never something you have to remember. */
function PlanMenu({
  destination,
  onDestinationChange,
}: {
  destination: LaunchDestination;
  onDestinationChange: (next: LaunchDestination) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  useMenuOverlay(open);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);
  const current = DESTINATIONS.find((d) => d.id === destination) ?? DESTINATIONS[0];
  const alternate = otherDestination(destination);
  return (
    <div ref={rootRef} data-no-drag="true" style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Where ⏎ sends this"
        className="rl-fd-tool is-wide"
      >
        {current.chip} <span className="rl-fd-caret">▾</span>
      </button>
      {open && (
        <div className="rl-fd-menu">
          {DESTINATIONS.map((d) => (
            <button
              key={d.id}
              type="button"
              className={`rl-fd-menu-row${d.id === destination ? " is-on" : ""}`}
              onClick={() => {
                setOpen(false);
                onDestinationChange(d.id);
              }}
            >
              <span className="rl-fd-menu-name">
                <Check
                  size={12}
                  className="rl-fd-menu-tick"
                  style={{ opacity: d.id === destination ? 1 : 0 }}
                />
                {d.label}
              </span>
              <span className="rl-fd-kbd">
                {d.id === destination ? "⏎" : d.id === alternate ? "⌘⏎" : ""}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** The first-run hole this closes: `projectOptions` is derived entirely from
 *  existing sessions and open folders, so a genuine first run has none and
 *  the first build would land in `$HOME`.
 *
 *  The type row is A1's entry point: an *extension pack* is a project that
 *  extends Redline itself — the folder is seeded as a buildable extension
 *  crate, and its plan sessions get the staged ABI/SDK/template dirs granted.
 *  A quiet second row here, not a header button: creation is the only moment
 *  the type question exists. */
function NewProjectOffer({
  name,
  busy,
  kind,
  onKind,
  onName,
  onCreate,
  onCancel,
  onSkip,
}: {
  name: string;
  busy: boolean;
  kind: "app" | "extension" | "harness";
  onKind: (kind: "app" | "extension" | "harness") => void;
  onName: (name: string) => void;
  onCreate: () => void;
  onCancel: () => void;
  onSkip?: () => void;
}) {
  // The destination prefix comes from the same policy as the write
  // (`project.rs::default_parent`): `~/Projects/` only on machines that
  // keep one, else `~/`. A hardcoded label here once promised `~/Projects/`
  // and the folder landed in `$HOME`.
  const [parentLabel, setParentLabel] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    invoke<string>("projects_parent")
      .then((p) => {
        if (alive) setParentLabel(p);
      })
      .catch(() => {
        if (alive) setParentLabel("~/");
      });
    return () => {
      alive = false;
    };
  }, []);
  return (
    <div className="rl-fd-block">
      <div className="rl-fd-label">Build this in a new folder</div>
      <div className="rl-fd-row" role="radiogroup" aria-label="Project type">
        {(
          [
            ["app", "A build"],
            ["extension", "An extension pack"],
            ["harness", "A harness"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={kind === id}
            className={`rl-fd-suggestion${kind === id ? " is-on" : ""}`}
            onClick={() => onKind(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="rl-fd-row">
        <span className="rl-fd-detail font-mono">{parentLabel ?? ""}</span>
        <input
          className="rl-fd-name"
          value={name}
          onChange={(e) => onName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onCreate();
            }
          }}
          spellCheck={false}
        />
        <button
          type="button"
          onClick={onCreate}
          disabled={busy || !name.trim()}
          className="rl-fd-fix is-primary"
        >
          {busy ? "Creating…" : onSkip ? "Create & plan" : "Create"}
        </button>
        {onSkip && (
          <button type="button" className="rl-fd-quiet" onClick={onSkip}>
            just use Home
          </button>
        )}
        <button type="button" className="rl-fd-quiet" onClick={onCancel}>
          cancel
        </button>
      </div>
      <div className="rl-fd-detail">
        {kind === "extension"
          ? "A buildable Redline extension crate — manifest, SDK dependency, " +
            "build.sh — plus a README and a fresh git repo. Plan sessions in " +
            "it can read Redline's extension ABI and the worked template."
          : kind === "harness"
            ? "A data-only harness pack — surfaces, labels, landing, hero in " +
              "one harness.json — linked live into this Redline: it appears " +
              "under Your harnesses now, and edits land on refocus."
            : "A folder with a README and a fresh git repo. Redline won't " +
              "write into a directory that already has something in it."}
      </div>
    </div>
  );
}
