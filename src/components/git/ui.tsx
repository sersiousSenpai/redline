// SPDX-License-Identifier: Apache-2.0
// Small UI primitives for the git client: a keyboard-navigable context menu and
// a promise-based dialog (confirmations and short forms).
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

// ---------------------------------------------------------------------------
// Context menu

export type MenuItem =
  | { label: string; onSelect: () => void; danger?: boolean; disabled?: boolean; hint?: string }
  | { separator: true }
  | { heading: string };

interface MenuState {
  x: number;
  y: number;
  items: MenuItem[];
  restore: HTMLElement | null;
}

export function useContextMenu() {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const open = useCallback((event: { clientX: number; clientY: number; preventDefault?: () => void; currentTarget?: EventTarget | null }, items: MenuItem[]) => {
    event.preventDefault?.();
    const restore = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setMenu({ x: event.clientX, y: event.clientY, items, restore });
  }, []);
  /** Open from the keyboard (Shift+F10 / ContextMenu key) at an element. */
  const openAt = useCallback((element: HTMLElement, items: MenuItem[]) => {
    const rect = element.getBoundingClientRect();
    setMenu({ x: rect.left + 24, y: rect.bottom, items, restore: element });
  }, []);
  const current = useRef<MenuState | null>(null);
  current.current = menu;
  const close = useCallback(() => {
    const restore = current.current?.restore;
    setMenu(null);
    restore?.focus?.();
  }, []);
  const node = menu ? <ContextMenu {...menu} onClose={close} /> : null;
  return { open, openAt, close, node };
}

function ContextMenu({ x, y, items, onClose }: MenuState & { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPos({
      left: Math.max(4, Math.min(x, window.innerWidth - rect.width - 4)),
      top: Math.max(4, Math.min(y, window.innerHeight - rect.height - 4)),
    });
    el.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [x, y]);
  useEffect(() => {
    const down = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    const away = () => onClose();
    window.addEventListener("mousedown", down, true);
    window.addEventListener("blur", away);
    window.addEventListener("resize", away);
    return () => {
      window.removeEventListener("mousedown", down, true);
      window.removeEventListener("blur", away);
      window.removeEventListener("resize", away);
    };
  }, [onClose]);
  const onKeyDown = (event: React.KeyboardEvent) => {
    const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Escape" || event.key === "Tab") {
      event.preventDefault();
      onClose();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      buttons[(at + step + buttons.length) % buttons.length]?.focus();
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      buttons[event.key === "Home" ? 0 : buttons.length - 1]?.focus();
    }
    event.stopPropagation();
  };
  return (
    <div ref={ref} role="menu" className="rl-git-menu" style={pos} onKeyDown={onKeyDown} onContextMenu={(e) => e.preventDefault()}>
      {items.map((item, index) =>
        "separator" in item ? (
          <div key={index} role="separator" className="rl-git-menu-rule" />
        ) : "heading" in item ? (
          <div key={index} className="rl-git-menu-heading">{item.heading}</div>
        ) : (
          <button
            key={index}
            type="button"
            role="menuitem"
            disabled={item.disabled}
            data-danger={item.danger ? "" : undefined}
            onClick={() => {
              onClose();
              item.onSelect();
            }}
          >
            <span>{item.label}</span>
            {item.hint && <kbd>{item.hint}</kbd>}
          </button>
        ),
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dialogs

export type Field =
  | { kind: "text"; name: string; label: string; initial?: string; placeholder?: string; required?: boolean; mono?: boolean }
  | { kind: "textarea"; name: string; label: string; initial?: string; placeholder?: string }
  | { kind: "checkbox"; name: string; label: string; initial?: boolean; hint?: string }
  | { kind: "select"; name: string; label: string; options: Array<{ value: string; label: string }>; initial?: string };

export type FieldValues = Record<string, string | boolean>;

interface DialogSpec {
  title: string;
  body?: ReactNode;
  fields?: Field[];
  confirmLabel: string;
  danger?: boolean;
  /** Return an error string to keep the dialog open. */
  validate?: (values: FieldValues) => string | null;
}

interface OpenDialog extends DialogSpec {
  resolve: (values: FieldValues | null) => void;
}

export function useDialogs() {
  const [dialog, setDialog] = useState<OpenDialog | null>(null);
  const ask = useCallback(
    (spec: DialogSpec) => new Promise<FieldValues | null>((resolve) => setDialog({ ...spec, resolve })),
    [],
  );
  const confirm = useCallback(
    async (spec: Omit<DialogSpec, "fields" | "validate">) => (await ask(spec)) !== null,
    [ask],
  );
  const current = useRef<OpenDialog | null>(null);
  current.current = dialog;
  const finish = useCallback((values: FieldValues | null) => {
    const open = current.current;
    current.current = null;
    setDialog(null);
    open?.resolve(values);
  }, []);
  const node = dialog ? <Dialog key={dialog.title} {...dialog} onFinish={finish} /> : null;
  return { ask, confirm, node };
}

function initialValues(fields: Field[] = []): FieldValues {
  const values: FieldValues = {};
  for (const field of fields) {
    if (field.kind === "checkbox") values[field.name] = field.initial ?? false;
    else if (field.kind === "select") values[field.name] = field.initial ?? field.options[0]?.value ?? "";
    else values[field.name] = field.initial ?? "";
  }
  return values;
}

function Dialog({ title, body, fields, confirmLabel, danger, validate, onFinish }: OpenDialog & { onFinish: (values: FieldValues | null) => void }) {
  const [values, setValues] = useState<FieldValues>(() => initialValues(fields));
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLFormElement>(null);
  const restore = useRef<HTMLElement | null>(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  useEffect(() => {
    const first = ref.current?.querySelector<HTMLElement>("input:not([type=checkbox]), textarea, select") ??
      ref.current?.querySelector<HTMLElement>("[data-primary]");
    first?.focus();
    if (first instanceof HTMLInputElement) first.select();
    const back = restore.current;
    return () => back?.focus?.();
  }, []);
  const missing = (fields ?? []).some((f) => f.kind === "text" && f.required && !String(values[f.name] ?? "").trim());
  const submit = (event?: React.FormEvent) => {
    event?.preventDefault();
    if (missing) return;
    const problem = validate?.(values) ?? null;
    if (problem) {
      setError(problem);
      return;
    }
    onFinish(values);
  };
  const set = (name: string, value: string | boolean) => {
    setValues((current) => ({ ...current, [name]: value }));
    setError(null);
  };
  return (
    <div className="rl-git-dialog-cover" onMouseDown={(e) => { if (e.target === e.currentTarget) onFinish(null); }}>
      <form
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="rl-git-dialog"
        onSubmit={submit}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Escape") { event.preventDefault(); onFinish(null); }
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) submit(event);
        }}
      >
        <h2>{title}</h2>
        {body && <div className="rl-git-dialog-body">{body}</div>}
        {(fields ?? []).map((field) => (
          <label key={field.name} className={`rl-git-field rl-git-field-${field.kind}`}>
            {field.kind === "checkbox" ? (
              <>
                <input type="checkbox" checked={!!values[field.name]} onChange={(e) => set(field.name, e.target.checked)} />
                <span>{field.label}{field.hint && <small>{field.hint}</small>}</span>
              </>
            ) : (
              <>
                <span>{field.label}</span>
                {field.kind === "select" ? (
                  <select value={String(values[field.name])} onChange={(e) => set(field.name, e.target.value)}>
                    {field.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                ) : field.kind === "textarea" ? (
                  <textarea rows={3} value={String(values[field.name])} placeholder={field.placeholder} onChange={(e) => set(field.name, e.target.value)} />
                ) : (
                  <input
                    type="text"
                    spellCheck={false}
                    className={field.mono ? "rl-git-mono" : undefined}
                    value={String(values[field.name])}
                    placeholder={field.placeholder}
                    onChange={(e) => set(field.name, e.target.value)}
                  />
                )}
              </>
            )}
          </label>
        ))}
        {error && <p role="alert" className="rl-git-dialog-error">{error}</p>}
        <div className="rl-git-dialog-actions">
          <button type="button" className="rl-git-btn" onClick={() => onFinish(null)}>Cancel</button>
          <button type="submit" data-primary="" className={`rl-git-btn ${danger ? "rl-git-btn-danger" : "rl-git-btn-primary"}`} disabled={missing}>
            {confirmLabel}
          </button>
        </div>
      </form>
    </div>
  );
}
