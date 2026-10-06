import { useEffect, useRef, useState } from "react";
import { ProjectPicker, type ProjectOption } from "./ProjectPicker";
import { guessProjectForPlan } from "../lib/guessProject";
import { useMenuOverlay } from "./menuOverlay";

export function MoveToRepoDialog({ markdown, currentProject, options, onConfirm, onCancel }: {
  markdown: string; currentProject: string; options: ProjectOption[]; onConfirm: (path: string) => Promise<void>; onCancel: () => void;
}) {
  const [project, setProject] = useState<string | null>(() => guessProjectForPlan(markdown, options) ?? currentProject ?? null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialog = useRef<HTMLDivElement>(null);
  useMenuOverlay(true);
  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.querySelector<HTMLElement>("button,select,input")?.focus();
    return () => { if (before?.isConnected) before.focus(); };
  }, []);
  useEffect(() => { const escape = (e: KeyboardEvent) => { if (e.key === "Escape" && !e.defaultPrevented && !pending) onCancel(); }; window.addEventListener("keydown", escape); return () => window.removeEventListener("keydown", escape); }, [onCancel, pending]);
  return <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background:"#0006" }} onClick={() => { if (!pending) onCancel(); }}>
    <div ref={dialog} onKeyDown={event => {
      if (event.key !== "Tab") return;
      const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),select:not(:disabled),input:not(:disabled),[tabindex="0"]'));
      const first = controls[0], last = controls[controls.length - 1];
      if (!first) { event.preventDefault(); return; }
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }} role="dialog" aria-modal="true" aria-label="Move plan to repo" className="flex w-96 flex-col gap-4 rounded-lg border p-5"
      style={{ background:"var(--color-paper)", borderColor:"var(--color-rule)" }} onClick={event => event.stopPropagation()}>
      <h2 className="font-semibold">Move to repo…</h2>
      <p className="text-xs" style={{ color:"var(--color-ink-muted)" }}>Choose the project this plan belongs to.</p>
      <fieldset disabled={pending}><ProjectPicker options={options} value={project} onChange={setProject}/></fieldset>
      {error && <p role="alert" className="text-xs">{error}</p>}
      <div className="flex justify-end gap-3 text-sm">
        <button type="button" disabled={pending} onClick={onCancel}>Cancel</button>
        <button type="button" disabled={!project || pending} onClick={() => {
          if (!project) return; setPending(true); setError(null);
          void onConfirm(project).then(onCancel).catch(error => setError(String(error))).finally(() => setPending(false));
        }}>{pending ? "Moving…" : "Move plan"}</button>
      </div>
    </div>
  </div>;
}
