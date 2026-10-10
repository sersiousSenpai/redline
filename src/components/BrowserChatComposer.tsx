// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The page chat's composer: one rounded capsule. The context it carries sits
//! on top as chips, the field grows with the text up to about 40% of the
//! panel, and the footer holds the + menu, the model as quiet text and the
//! one round button (`composerModel`: mic, send, queue or stop). The field is
//! never disabled and nothing here takes the caret on its own (BC-27, BC-33).

import { useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import { Camera, Image as ImageIcon, MousePointerClick, Plus } from "lucide-react";
import type { ComposerModel } from "../lib/browserChat/turn";
import type { TurnChip } from "../lib/browserChat/transcript";
import type { Dictation } from "../lib/useDictation";
import { Panel, useClickPopover } from "./popover";
import { SendStopButton } from "./SendStopButton";
import { TurnContext } from "./BrowserChatParts";
import "./ComposerMenu.css";

/** The field's ceiling as a share of the panel's height. */
const GROW_SHARE = 0.4;
/** …and its floor, for a panel too short to measure. */
const GROW_MIN = 96;

export interface AttachActions {
  /** A screenshot of the tab the turn is about. */
  onScreenshot: () => void;
  /** A picture file from disk. */
  onImage: () => void;
  /** Pick an element on the page; absent where picking can't run. */
  onPickElement?: () => void;
}

export function BrowserChatComposer({
  taRef,
  frameRef,
  draft,
  setDraft,
  chips,
  onRemoveChip,
  model,
  dictation,
  picker,
  attach,
  error,
  onSend,
  onStop,
}: {
  /** Owned by the chat so a seed can place the caret. */
  taRef: RefObject<HTMLTextAreaElement | null>;
  /** The panel, whose height bounds the field's growth. */
  frameRef: RefObject<HTMLElement | null>;
  draft: string;
  setDraft: (next: string) => void;
  chips: readonly TurnChip[];
  onRemoveChip: (chip: TurnChip) => void;
  model: ComposerModel;
  dictation: Dictation;
  /** The model picker, drawn as quiet text in the footer. */
  picker: ReactNode;
  attach: AttachActions;
  /** Why the last attach didn't land, until the next one. */
  error: string | null;
  onSend: () => void;
  onStop: () => void;
}) {
  const autosize = () => {
    const el = taRef.current;
    if (!el) return;
    const cap = Math.max(GROW_MIN, Math.round((frameRef.current?.clientHeight ?? 0) * GROW_SHARE));
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, cap)}px`;
    el.style.overflowY = el.scrollHeight > cap ? "auto" : "hidden";
  };
  // Before paint: a restored draft opens at its height, never one row first.
  useLayoutEffect(autosize, [draft]);
  return (
    <div className="rb-capsule" data-listening={dictation.listening || undefined}>
      <TurnContext chips={chips} onRemove={onRemoveChip} />
      {error && (
        <div className="rb-capsule-note" aria-live="polite" data-error>
          {error}
        </div>
      )}
      <textarea
        ref={taRef}
        value={draft}
        aria-label="Message the page agent"
        onChange={(e) => {
          setDraft(e.target.value);
          autosize();
        }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            // Mid-reply this queues the message behind it.
            onSend();
          }
        }}
        placeholder={model.placeholder}
        rows={1}
        className="rb-capsule-field"
      />
      <div className="rb-capsule-foot">
        <AttachMenu {...attach} />
        <span className="rb-capsule-model">{picker}</span>
        <SendStopButton
          state={model.button}
          onSend={onSend}
          onStop={onStop}
          onMic={dictation.toggle}
          listening={dictation.listening}
          disabled={!model.primaryEnabled}
        />
      </div>
    </div>
  );
}

/** "+": what can ride the next message besides its text. */
function AttachMenu({ onScreenshot, onImage, onPickElement }: AttachActions) {
  const trigger = useRef<HTMLButtonElement>(null);
  const pop = useClickPopover(trigger, "left", "above", 240);
  const item = (icon: ReactNode, title: string, detail: string, run: () => void) => (
    <button
      type="button"
      role="menuitem"
      className="rl-composer-option"
      onClick={() => {
        pop.close();
        run();
      }}
    >
      {icon}
      <span>
        <strong>{title}</strong>
        <small>{detail}</small>
      </span>
    </button>
  );
  return (
    <>
      <button ref={trigger} type="button" className="rb-capsule-plus" aria-label="Attach" title="Attach to the next message" aria-haspopup="menu" aria-expanded={pop.open} onClick={pop.toggle}>
        <Plus size={15} aria-hidden />
      </button>
      {pop.open && (
        <Panel label="Attach" {...pop.panelProps} className="rl-composer-menu">
          <div className="rl-composer-menu-scroll">
            {item(<Camera size={14} aria-hidden />, "Screenshot of this tab", "What the page shows right now", onScreenshot)}
            {item(<ImageIcon size={14} aria-hidden />, "Image…", "A picture from your Mac", onImage)}
            {onPickElement && item(<MousePointerClick size={14} aria-hidden />, "Pick an element", "Click the part of the page you mean", onPickElement)}
          </div>
        </Panel>
      )}
    </>
  );
}
