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
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Check, CornerDownLeft, Mic, Plus, X } from "lucide-react";
import { ProjectPicker, type ProjectOption } from "./ProjectPicker";
import { ReadinessBlock, ReadinessStrip } from "./ReadinessStrip";
import { WorkingIndicator } from "./WorkingIndicator";
import { useMenuOverlay } from "./menuOverlay";
import { useDictation } from "../lib/useDictation";
import {
  frontDoorSuggestions,
  otherDestination,
  projectNameFromPrompt,
  submitAction,
  type LaunchDestination,
  type ProjectChoice,
} from "../lib/frontDoor";
import { blockingItems, type ReadinessItem } from "../lib/readiness";

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
  onDrafter: () => void;
  /** Where ⏎ sends. Sticky and persisted — `Plan ▾` sets it. */
  destination: LaunchDestination;
  onDestinationChange: (next: LaunchDestination) => void;
  onCancelPending: () => void;
  onHowItWorks: () => void;
  /** Create a project folder; resolves its absolute path, or null on
   *  failure (the error is surfaced by App as a toast). */
  onCreateProject: (name: string) => Promise<string | null>;
  /** Bumped by the type-to-start handoff: focus the composer and take the
   *  buffered keystrokes. */
  focusNonce: number;
  consumeSeed: () => string;
  /** False while the Voice panel owns the mic — one capture at a time. */
  dictationEnabled: boolean;
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
    onDrafter,
    destination,
    onDestinationChange,
    onCancelPending,
    onHowItWorks,
    onCreateProject,
    focusNonce,
    consumeSeed,
    dictationEnabled,
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
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w) setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // Unmeasured reads as roomy: the first paint is the common case and a
  // compact flash before the observer fires would be worse than a late one.
  const compact = width !== null && width < 560;
  const tight = width !== null && width < 430;
  // The blocker ⏎ was refused on, surfaced inside the island.
  const [blocked, setBlocked] = useState<ReadinessItem | null>(null);
  // The "build this in a new folder" offer: `launchAfter` distinguishes the
  // ⏎ route (create, then launch) from the picker's `＋ New project…` row
  // (create, then just select it).
  const [offer, setOffer] = useState<{
    name: string;
    launchAfter: boolean;
  } | null>(null);
  const [creating, setCreating] = useState(false);

  const blocking = useMemo(() => blockingItems(readiness), [readiness]);
  // A blocker that got fixed elsewhere must not keep sitting in the island
  // telling the user about a fault that no longer exists.
  useEffect(() => {
    if (blocked && !blocking.some((b) => b.id === blocked.id)) setBlocked(null);
  }, [blocking, blocked]);

  // Auto-grow. The island is one continuous shape, so the box follows the
  // text instead of scrolling inside a fixed frame — up to a cap, after
  // which it scrolls.
  useLayoutEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 300)}px`;
  }, [text, pending]);

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

  const hasText = text.trim().length > 0;
  const canSubmit = hasText && !pending;

  const attemptLaunch = useCallback(() => {
    if (!canSubmit) return;
    // Gate, in order: a blocker refuses outright and renders its fix where
    // the user is already looking; a first-run user with nowhere to build is
    // offered a folder rather than dropped in $HOME.
    //
    // This gate is the PLAN route's alone. Opening the Drafter needs no
    // `claude`, no hook and no interception mode — refusing to open a
    // document because a plan couldn't be captured would be nonsense.
    if (blocking.length > 0) {
      setBlocked(blocking[0]);
      return;
    }
    if (projectOptions.length === 0 && !choice) {
      setOffer({ name: projectNameFromPrompt(text), launchAfter: true });
      return;
    }
    setBlocked(null);
    setOffer(null);
    onLaunch();
  }, [canSubmit, blocking, projectOptions.length, choice, text, onLaunch]);

  const send = useCallback(
    (to: LaunchDestination) => {
      if (!canSubmit) return;
      if (to === "drafter") onDrafter();
      else attemptLaunch();
    },
    [canSubmit, onDrafter, attemptLaunch],
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
    const path = await onCreateProject(offer.name).finally(() =>
      setCreating(false),
    );
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
        setOffer({ name: projectNameFromPrompt(text), launchAfter: false });
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
  ]
    .filter(Boolean)
    .join(" ");

  const rootClass = [
    "rl-frontdoor font-sans",
    entered ? "is-in" : "",
    compact ? "is-compact" : "",
    tight ? "is-tight" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div ref={rootRef} className={rootClass} data-tour="landing">
      <div className="rl-fd-paper" aria-hidden />

      {/* The stance, not another question — the composer's placeholder is
          already asking one. "Redline" is the verb, which is the whole point
          of the product and the shortest way to say it. */}
      <div className="rl-fd-eyebrow">Plan mode</div>
      <h1 className="rl-fd-title font-serif">
        Every build starts as a draft.
      </h1>
      <p className="rl-fd-sub">Describe it. Redline the plan. Then build.</p>

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

        {blocked && (
          <ReadinessBlock
            item={blocked}
            onFix={async (item) => {
              const ok = await onFix(item);
              if (!ok) return false;
              // Fixed in place — carry the user's ⏎ through rather than
              // making them press it again. If something else was also
              // blocking, show that instead of silently doing nothing.
              const next = blocking.find((b) => b.id !== item.id);
              setBlocked(next ?? null);
              if (!next) onLaunch();
              return true;
            }}
            onDismiss={() => setBlocked(null)}
          />
        )}

        {offer && (
          <NewProjectOffer
            name={offer.name}
            busy={creating}
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
 *  the first build would land in `$HOME`. */
function NewProjectOffer({
  name,
  busy,
  onName,
  onCreate,
  onCancel,
  onSkip,
}: {
  name: string;
  busy: boolean;
  onName: (name: string) => void;
  onCreate: () => void;
  onCancel: () => void;
  onSkip?: () => void;
}) {
  return (
    <div className="rl-fd-block">
      <div className="rl-fd-label">Build this in a new folder</div>
      <div className="rl-fd-row">
        <span className="rl-fd-detail font-mono">~/Projects/</span>
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
        A folder with a README and a fresh git repo. Redline won't write into a
        directory that already has something in it.
      </div>
    </div>
  );
}
