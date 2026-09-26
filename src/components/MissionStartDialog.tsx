// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useEffect, useId, useRef, useState } from "react";
import { BrowserDialog } from "./BrowserSurfaces";

interface MissionStartDialogProps {
  onStart: (title: string, goal: string) => void;
  onCancel: () => void;
}

/** The goal starts the research thread; an omitted title uses its first line. */
export function MissionStartDialog({ onStart, onCancel }: MissionStartDialogProps) {
  const [title, setTitle] = useState("");
  const [goal, setGoal] = useState("");
  const goalRef = useRef<HTMLTextAreaElement>(null);
  const fieldId = useId();
  const canStart = goal.trim().length > 0;
  // The dialog first saves the invoking control for focus restoration, then
  // the goal receives typing focus without overwriting that return target.
  useEffect(() => { goalRef.current?.focus(); }, []);

  return (
    <BrowserDialog title="New research" subtitle="Set a goal for the pages and findings you collect." onClose={onCancel} closeLabel="Cancel"
      footer={<button type="button" className="rb-button rb-button-primary" disabled={!canStart} onClick={() => onStart(title, goal)}>Start research</button>}>
      <div className="flex min-w-0 flex-col gap-3">
        <label htmlFor={`${fieldId}-title`}>Title <span style={{ color: "var(--color-ink-muted)" }}>(optional)</span></label>
        <input id={`${fieldId}-title`} className="rb-field" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="e.g. Competitor research" />
        <label htmlFor={`${fieldId}-goal`}>Research goal</label>
        <textarea ref={goalRef} id={`${fieldId}-goal`} className="rb-field" value={goal} onChange={(event) => setGoal(event.target.value)}
          placeholder="What would you like to learn or put together?" rows={5}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && !event.nativeEvent.isComposing && canStart) {
              event.preventDefault();
              onStart(title, goal);
            }
          }}
          style={{ minHeight: 120, maxHeight: 220, resize: "vertical", overflowY: "auto", fontFamily: "inherit", lineHeight: 1.5 }} />
        <p className="rb-help" style={{ margin: 0 }}>⌘ Enter or Ctrl Enter to start.</p>
      </div>
    </BrowserDialog>
  );
}
