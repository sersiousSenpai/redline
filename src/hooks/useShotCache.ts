// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian

// Lazy loader for the picture store, mirroring `useThumbCapture`'s discipline.
//
// Three constraints shape this, and none of them are obvious:
//
// 1. **`loading="lazy"` is useless on a `data:` URL.** The browser can't defer
//    fetching something already in the string. The laziness has to live at the
//    `invoke` boundary — we decide not to READ the file — which is why this is
//    a hook and not an `<img>` attribute.
//
// 2. **A 40 KB PNG is not 40 KB in memory.** Base64 inflates it to ~55 KB, and
//    a JS string is UTF-16, so it costs ~110 KB resident before the decoder
//    even sees it. Hence a small LRU rather than "keep what we've loaded".
//
// 3. **One decode at a time.** A serial queue, so scrolling a list never
//    schedules twenty concurrent reads-and-decodes.
//
// `shots_list` is called once at mount so the hook knows what EXISTS without a
// failed `read_file_base64` per row — the difference between a quiet miss and
// an error path per absent picture.

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

interface ShotEntry {
  key: string;
  path: string;
  bytes: number;
  modifiedMs: number;
}

interface BinaryFile {
  base64: string;
  mime?: string;
}

/** Resident decoded shots. Small on purpose — see the note above. */
const LRU_MAX = 60;

export function useShotCache() {
  const [shots, setShots] = useState<Map<string, string>>(new Map());
  // Keys that exist on disk. `null` until the first listing lands, so the UI
  // can tell "no picture" from "we don't know yet".
  const onDiskRef = useRef<Map<string, string> | null>(null);
  const orderRef = useRef<string[]>([]);
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    void (async () => {
      try {
        const list = await invoke<ShotEntry[]>("shots_list");
        if (!aliveRef.current) return;
        onDiskRef.current = new Map(list.map((e) => [e.key, e.path]));
      } catch {
        onDiskRef.current = new Map();
      }
    })();
    return () => {
      aliveRef.current = false;
    };
  }, []);

  /** Load a shot if it exists, serially. Safe to call on every render. */
  const load = useCallback((key: string | null | undefined) => {
    if (!key) return;
    const disk = onDiskRef.current;
    // Unknown yet, or known-absent: either way, don't attempt a read.
    if (!disk || !disk.has(key)) return;
    if (orderRef.current.includes(key)) return;
    orderRef.current.push(key);

    queueRef.current = queueRef.current.then(async () => {
      if (!aliveRef.current) return;
      const path = onDiskRef.current?.get(key);
      if (!path) return;
      try {
        const file = await invoke<BinaryFile>("read_file_base64", { path });
        if (!aliveRef.current) return;
        setShots((prev) => {
          const next = new Map(prev);
          next.set(key, `data:${file.mime || "image/png"};base64,${file.base64}`);
          // Evict oldest beyond the cap — the whole reason the order list exists.
          while (next.size > LRU_MAX) {
            const oldest = orderRef.current.shift();
            if (!oldest || oldest === key) break;
            next.delete(oldest);
          }
          return next;
        });
      } catch {
        // A read that fails is a miss, not an error state: the file may have
        // been swept between the listing and now.
        orderRef.current = orderRef.current.filter((k) => k !== key);
      }
    });
  }, []);

  /** Forget a picture everywhere: on disk, in the DB, and here. */
  const forget = useCallback(async (key: string) => {
    await invoke("shot_forget", { key });
    onDiskRef.current?.delete(key);
    orderRef.current = orderRef.current.filter((k) => k !== key);
    setShots((prev) => {
      const next = new Map(prev);
      next.delete(key);
      return next;
    });
  }, []);

  return { shots, load, forget };
}
