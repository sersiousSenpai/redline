// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useCallback, useEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { Panel, useClickPopover } from "./popover";
import { MODEL_OPTIONS } from "../lib/seatAssign";
import { useModelCatalogs } from "../hooks/useModelCatalogs";
import { integrationHealth } from "../lib/integrationHealth";
import type { CodexProbe } from "../lib/readiness";
import {
  backendLabel,
  choiceLabel,
  defaultChoice,
  effortsFor,
  modelsFor,
  normalizeChoice,
  parseChoice,
  type Backend,
  type BackendChoice,
} from "../lib/backendChoice";

/** The last pick the user made in any page chat. A chat with no pick of its
 *  own shows this one, and stores it on its first send — otherwise every new
 *  tab would start back on the seat default. */
export const LAST_HARNESS_KEY = "redline.browse.lastHarness";

/** The providers a page chat offers, in the order the row shows them. */
const PROVIDERS: readonly Backend[] = ["claude-code", "codex"];

/** Why Codex can't run a page chat on this machine, or null when it can: the
 *  preflight probe found it, it is new enough for Redline's app-server turns,
 *  and it is not known to be signed out. An unverified sign-in never blocks,
 *  the same rule `readiness.ts` applies to a Codex launch. */
export function codexBlocker(probe: CodexProbe | null | undefined): string | null {
  if (!probe) return "Couldn't check Codex on this machine";
  if (!probe.found) return "Codex isn't installed — install the ChatGPT desktop app, or point Redline at codex";
  if (!probe.usable) return `This codex${probe.version ? ` (${probe.version})` : ""} is too old for Redline — update Codex`;
  if (!probe.signedIn && probe.authState !== "unknown") return "Codex isn't signed in — run `codex login` in a terminal";
  return null;
}

/** Codex's readiness, probed while the picker is open (the probe is shared
 *  and cached by `integrationHealth`). `blocker` is undefined until it
 *  answers; `model` is Codex's own configured default. */
function useCodexReadiness(open: boolean): { blocker: string | null | undefined; model: string | null } {
  const [state, setState] = useState<{ blocker: string | null | undefined; model: string | null }>({ blocker: undefined, model: null });
  useEffect(() => {
    if (!open) return;
    let current = true;
    integrationHealth.ensure({ backend: "codex", extension: false }).then(health => {
      const probe = health.preflight.codex;
      if (current) setState({ blocker: codexBlocker(probe), model: probe?.configuredModel ?? null });
    }, () => {
      if (current) setState({ blocker: codexBlocker(null), model: null });
    });
    return () => { current = false; };
  }, [open]);
  return state;
}

function readLastHarness(): BackendChoice | null {
  try {
    const raw = localStorage.getItem(LAST_HARNESS_KEY);
    return raw ? parseChoice(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

function writeLastHarness(choice: BackendChoice) {
  try {
    localStorage.setItem(LAST_HARNESS_KEY, JSON.stringify(choice));
  } catch {
    /* the pick still applies to this chat; only the inheritance is lost */
  }
}

/** Mirrors Rust's `state::BrowseHarness`. `backend: null` = never picked. */
interface StoredHarness {
  backend?: string | null;
  model?: string | null;
  effort?: string | null;
}

export interface BrowseHarness {
  /** What this chat's next message runs on: its own pick, else the last pick
   *  made in any page chat, else the `browse` seat. */
  pick: BackendChoice;
  /** The `browse` seat's own model and effort — what "Default" means. */
  seat: { model?: string; effort?: string };
  saving: boolean;
  error: string | null;
  save: (next: BackendChoice) => Promise<void>;
  /** Run before each send: a chat showing an inherited pick stores it, so the
   *  turn (which reads the stored pick) runs on what the chip shows. */
  commit: () => Promise<void>;
  /** "Clear history" dropped the chat's row, its pick with it. */
  forget: () => void;
}

/** One page chat's provider/model/effort pick, loaded and saved through
 *  `browse_thread_harness` / `browse_thread_set_harness` keyed by `browseId`.
 *  BrowserChat owns it, so its send path and agent label see the same pick
 *  the chip shows. */
export function useBrowseHarness(browseId: string): BrowseHarness {
  // `own` is this chat's stored pick; `inherited` is shown while it has none.
  const [own, setOwn] = useState<BackendChoice | null>(null);
  const [inherited, setInherited] = useState<BackendChoice | null>(readLastHarness);
  const [seat, setSeat] = useState<{ model?: string; effort?: string }>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keyRef = useRef(browseId);
  keyRef.current = browseId;
  const ownRef = useRef(own);
  ownRef.current = own;
  const inheritedRef = useRef(inherited);
  inheritedRef.current = inherited;
  // Resolves true once this chat's stored pick is known. A failed read is
  // not "never picked": `commit` must not write over a pick it never saw.
  const loaded = useRef<Promise<boolean>>(Promise.resolve(false));

  useEffect(() => {
    let current = true;
    setOwn(null);
    setError(null);
    setInherited(readLastHarness());
    loaded.current = invoke<StoredHarness | null>("browse_thread_harness", { browseId }).then(value => {
      const stored = value && typeof value === "object" && !Array.isArray(value) && value.backend ? parseChoice(value) : null;
      if (current) { ownRef.current = stored; setOwn(stored); }
      return true;
    }, e => {
      if (current) setError(String(e));
      return false;
    });
    return () => { current = false; };
  }, [browseId]);
  useEffect(() => {
    let current = true;
    void invoke<{ seats?: Record<string, { model?: string; effort?: string }> }>("get_agent_seats").then(value => {
      if (current) setSeat(value?.seats?.browse ?? {});
    }).catch(() => {});
    return () => { current = false; };
  }, []);

  const store = useCallback(async (id: string, next: BackendChoice) => {
    await invoke("browse_thread_set_harness", { browseId: id, backend: next.backend, model: next.model, effort: next.effort });
    if (keyRef.current !== id) return;
    ownRef.current = next;
    setOwn(next);
  }, []);
  const save = useCallback(async (next: BackendChoice) => {
    setSaving(true);
    setError(null);
    try {
      await store(browseId, next);
      writeLastHarness(next);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }, [browseId, store]);
  const commit = useCallback(async () => {
    const id = browseId;
    const known = await loaded.current;
    const pick = inheritedRef.current;
    if (!known || keyRef.current !== id || ownRef.current || !pick) return;
    // A failed write must not cost the message: it runs on the default.
    await store(id, pick).catch(e => setError(String(e)));
  }, [browseId, store]);
  const forget = useCallback(() => {
    ownRef.current = null;
    setOwn(null);
    setInherited(readLastHarness());
  }, []);

  return { pick: own ?? inherited ?? defaultChoice(), seat, saving, error, save, commit, forget };
}

/** `[Default (sonnet · medium) ⌄]` — this page chat's provider, model and
 *  effort. Modelled on the plan discussions' `DiscussModelChip`, plus a
 *  Provider row. Never disabled while a reply streams: the pick applies to the
 *  next message, the way the Companion's does. Codex is offered only when
 *  this machine can run it; otherwise its option says why not. */
export function BrowseHarnessChip({ harness }: { harness: BrowseHarness }) {
  const { pick, seat, saving, error, save } = harness;
  const anchor = useRef<HTMLButtonElement>(null);
  const popover = useClickPopover(anchor, "left");
  const { catalogs, errors, request } = useModelCatalogs();
  const codexReadiness = useCodexReadiness(popover.open);
  useEffect(() => { if (popover.open) request(pick.backend, pick.backend); }, [popover.open, pick.backend, request]);
  const codex = pick.backend === "codex";
  // "Default" is the browse seat on Claude, and Codex's own settings on Codex.
  const seatLabel = [seat.model, seat.effort].filter(Boolean).join(" · ") || "CLI default";
  const defaultLabel = codex ? `Default${codexReadiness.model ? ` (${codexReadiness.model})` : ""}` : `Default (${seatLabel})`;
  const isDefault = !pick.model && !pick.effort;
  // Claude is the quiet case; a Codex chat always says so.
  const label = codex
    ? (isDefault ? "Codex · Default" : choiceLabel(pick, catalogs))
    : (isDefault ? defaultLabel : choiceLabel(pick, catalogs).split(" · ").slice(1).join(" · "));
  const models = modelsFor(pick.backend, catalogs).filter(model => pick.backend !== "claude-code" || (MODEL_OPTIONS as readonly string[]).includes(model.value));
  const efforts = effortsFor(pick.backend, pick.model, catalogs);
  const providerBlocker = (backend: Backend) =>
    backend !== "codex" ? null : codexReadiness.blocker === undefined ? "Checking Codex…" : codexReadiness.blocker;
  return <>
    <button type="button" ref={anchor} className="rb-harness-chip" title="Applies to the next message" aria-label="Chat model and effort" aria-haspopup="menu" aria-expanded={popover.open} onClick={popover.toggle}>
      <span>{label}</span><ChevronDown size={12} aria-hidden/>
    </button>
    {popover.open && <Panel {...popover.panelProps} label="Chat model and effort">
      {/* The scroller, not the Panel, takes the overflow: `maxHeight` is only
          a real bound on a `minHeight: 0` child of its flex column. */}
      <div className="rl-thin-scroll-y" style={{ flex: "1 1 auto", minHeight: 0, overflowY: "auto", padding: 5 }}>
        <div className="rl-fd-menu-label">Provider</div>
        <div className="rb-provider-seg" role="group" aria-label="Provider">
          {PROVIDERS.map(backend => {
            const blocker = providerBlocker(backend);
            return <button key={backend} type="button" role="menuitemradio" aria-checked={pick.backend === backend} disabled={saving || !!blocker} title={blocker ?? undefined}
              // A provider switch drops the model and effort: a Claude alias is not a Codex slug.
              onClick={() => { if (backend !== pick.backend) void save({ backend, model: null, effort: null }); }}>{backendLabel(backend)}</button>;
          })}
        </div>
        <button type="button" role="menuitemradio" aria-checked={isDefault} className="rl-fd-menu-row" disabled={saving} onClick={() => void save({ backend: pick.backend, model: null, effort: null })}>
          <span className="rl-fd-menu-name"><Check size={12} className="rl-fd-menu-tick" style={{ opacity: isDefault ? 1 : 0 }}/>{defaultLabel}</span>
        </button>
        <label className="rl-fd-model-field"><span className="rl-fd-menu-label">Model</span><select aria-label="Chat model" disabled={saving} value={pick.model ?? ""} onChange={e => void save(normalizeChoice({ ...pick, model: e.target.value || null }, catalogs))}>
          <option value="">{codex ? defaultLabel : seat.model ? `Default (${seat.model})` : "Default"}</option>
          {models.map(model => <option key={model.value} value={model.value}>{model.label}</option>)}
          {pick.model && !models.some(model => model.value === pick.model) && <option value={pick.model}>{pick.model}</option>}
        </select></label>
        <label className="rl-fd-model-field"><span className="rl-fd-menu-label">Effort</span><select aria-label="Chat effort" disabled={saving} value={pick.effort ?? ""} onChange={e => void save({ ...pick, effort: e.target.value || null })}>
          <option value="">Default</option>
          {efforts.map(effort => <option key={effort} value={effort}>{effort}</option>)}
          {pick.effort && !efforts.includes(pick.effort) && <option value={pick.effort}>{pick.effort}</option>}
        </select></label>
        {(error || errors[pick.backend]) && <p role="alert" className="rl-fd-menu-note">{error || errors[pick.backend]}</p>}
      </div>
    </Panel>}
  </>;
}
