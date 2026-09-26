// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export const PICKING_ERROR = "Element picking isn't available on this page";
export const PICKING_TIMEOUT_MS = 3500;
export const inspectorSeed = (value: Record<string, unknown>) => ({
  text: `Inspect this element:\n\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``, nonce: Date.now(),
});

/** Poll only during picking, so failed page-to-native delivery is observable. */
export function useElementPicker(activeLabel: string, onError: (error: string) => void) {
  const [request, setRequest] = useState(0);
  const [picking, setPicking] = useState(false);
  const current = useRef<string | null>(null), generation = useRef(0);
  const errorRef = useRef(onError); errorRef.current = onError;
  const cancel = () => {
    const label = current.current;
    current.current = null; generation.current++; setPicking(false);
    if (label) void invoke("browser_eval", { label, script: "window.__redline_inspect_stop?.()" }).catch(() => {});
  };
  useEffect(() => cancel, [activeLabel]);
  const accept = (label: string) => {
    if (current.current !== label) return false;
    cancel(); return true;
  };
  const start = async (url: string) => {
    cancel();
    if (!/^https?:\/\//i.test(url)) { errorRef.current(PICKING_ERROR); return; }
    const id = generation.current;
    current.current = activeLabel; setRequest(id); setPicking(true);
    try { await invoke("browser_inspect", { label: activeLabel }); }
    catch { if (generation.current === id) { cancel(); errorRef.current(PICKING_ERROR); } }
  };
  useEffect(() => {
    if (!picking) return;
    const id = generation.current, label = current.current;
    let busy = false, deadline: ReturnType<typeof setTimeout> | undefined;
    const fail = () => {
      if (id !== generation.current) return;
      cancel(); errorRef.current(PICKING_ERROR);
    };
    const poll = async () => {
      if (busy || id !== generation.current) return;
      busy = true; deadline = setTimeout(fail, PICKING_TIMEOUT_MS);
      try {
        const raw = await invoke<string>("browser_eval_result", { label, script: "JSON.stringify(window.__redline_inspect_status || null)" });
        if (id !== generation.current) return;
        const status = JSON.parse(raw || "null") as { state: string; at: number } | null;
        if (status?.state === "cancelled") cancel();
        else if (status?.state === "error" || !status || (["pending", "sent"].includes(status.state) && Date.now() - status.at >= PICKING_TIMEOUT_MS)) fail();
      } catch { fail(); }
      finally { clearTimeout(deadline); busy = false; }
    };
    const interval = setInterval(() => void poll(), 400);
    return () => { clearInterval(interval); clearTimeout(deadline); };
  }, [picking, activeLabel, request]);
  return { picking, start, cancel, accept };
}
