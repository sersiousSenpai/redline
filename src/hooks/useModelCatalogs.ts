// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Backend, ModelCatalogs, ProviderModel } from "../lib/backendChoice";

export interface ModelCatalogSnapshot {
  models: ProviderModel[];
  checkedAt: number | null;
  source: "harness" | "unavailable";
  warning: string | null;
}
export interface ModelCatalogStatus {
  refreshing: boolean;
  checkedAt: number | null;
  source?: ModelCatalogSnapshot["source"];
}

/** Native discovery owns the TTL, scope, single-flight and backoff. Asking on
 * open/focus costs only IPC for a fresh catalog. Keep usable rows during a
 * refresh, while preventing replies from an old installation replacing them. */
export function useModelCatalogs() {
  const [catalogs, setCatalogs] = useState<ModelCatalogs>({});
  const [errors, setErrors] = useState<Partial<Record<Backend, string>>>({});
  const [status, setStatus] = useState<Partial<Record<Backend, ModelCatalogStatus>>>({});
  const keys = useRef(new Map<Backend, string>());
  const generations = useRef(new Map<Backend, number>());
  const pending = useRef(new Map<Backend, number>());
  const sequence = useRef(0);
  useEffect(() => () => { keys.current.clear(); generations.current.clear(); pending.current.clear(); }, []);
  const request = useCallback((backend: Backend, identity: string, force = false) => {
    const same = keys.current.get(backend) === identity;
    if (same && pending.current.has(backend)) return;
    keys.current.set(backend, identity);
    const generation = ++sequence.current;
    generations.current.set(backend, generation);
    pending.current.set(backend, generation);
    if (!same) setCatalogs(prev => ({ ...prev, [backend]: [] }));
    setErrors(prev => ({ ...prev, [backend]: undefined }));
    setStatus(prev => ({ ...prev, [backend]: { checkedAt: same ? prev[backend]?.checkedAt ?? null : null, refreshing: true } }));
    void invoke<ModelCatalogSnapshot>("model_catalog_snapshot", { backend, force }).then(snapshot => {
      if (generations.current.get(backend) !== generation) return;
      setCatalogs(prev => ({ ...prev, [backend]: snapshot.models }));
      setErrors(prev => ({ ...prev, [backend]: snapshot.warning ?? undefined }));
      setStatus(prev => ({ ...prev, [backend]: { refreshing: false, checkedAt: snapshot.checkedAt, source: snapshot.source } }));
    }).catch(() => {
      if (generations.current.get(backend) !== generation) return;
      setErrors(prev => ({ ...prev, [backend]: "Couldn't refresh the model list. Try again shortly." }));
      setStatus(prev => ({ ...prev, [backend]: { ...prev[backend], checkedAt: prev[backend]?.checkedAt ?? null, refreshing: false } }));
    }).finally(() => {
      if (pending.current.get(backend) === generation) pending.current.delete(backend);
    });
  }, []);
  return { catalogs, errors, status, request };
}
