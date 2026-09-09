// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { EFFORT_OPTIONS } from "../lib/seatAssign";
import type { Backend, ModelCatalogs, ProviderModel } from "../lib/backendChoice";

interface ClaudeModel { id: string; label: string; alias: boolean; note?: string | null }

/** Each catalog belongs to a resolved binary identity; late replies cannot
 * replace the catalog of a newly selected installation. Failures can retry. */
export function useModelCatalogs() {
  const [catalogs, setCatalogs] = useState<ModelCatalogs>({});
  const [errors, setErrors] = useState<Partial<Record<Backend, string>>>({});
  const keys = useRef(new Map<Backend, string>());
  const generations = useRef(new Map<Backend, number>());
  const sequence = useRef(0);
  useEffect(() => () => { keys.current.clear(); generations.current.clear(); }, []);
  const request = useCallback((backend: Backend, identity: string) => {
    if (keys.current.get(backend) === identity) return;
    keys.current.set(backend, identity);
    const generation = ++sequence.current;
    generations.current.set(backend, generation);
    setCatalogs(prev => ({ ...prev, [backend]: [] }));
    setErrors(prev => ({ ...prev, [backend]: undefined }));
    const promise: Promise<ProviderModel[]> = backend === "claude-code"
      ? invoke<ClaudeModel[]>("claude_model_catalog").then(rows => rows.map(m => ({
          slug: m.id, displayName: m.label, description: m.note ?? "", defaultEffort: null, efforts: [...EFFORT_OPTIONS],
        })))
      : backend === "codex" ? invoke<ProviderModel[]>("codex_model_catalog")
      : invoke<ProviderModel[]>("provider_model_catalog", { backend });
    void promise.then(rows => {
      if (generations.current.get(backend) === generation) setCatalogs(prev => ({ ...prev, [backend]: rows }));
    }).catch(error => {
      if (generations.current.get(backend) !== generation) return;
      keys.current.delete(backend);
      setErrors(prev => ({ ...prev, [backend]: String(error) }));
    });
  }, []);
  return { catalogs, errors, request };
}
