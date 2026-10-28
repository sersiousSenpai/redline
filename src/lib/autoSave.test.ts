// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AUTO_SAVE_DEFAULT,
  AUTO_SAVE_MAX_BYTES,
  createAutoSaveTimer,
  shouldAutoSave,
  utf8Bytes,
  type AutoSaveState,
} from "./autoSave";

const base: AutoSaveState = {
  mode: "delay",
  trigger: "delay",
  dirty: true,
  saving: false,
  conflict: false,
  comparing: false,
  diverged: false,
  bytes: 10,
};
const at = (patch: Partial<AutoSaveState>) => shouldAutoSave({ ...base, ...patch });

describe("shouldAutoSave", () => {
  it("defaults to After delay", () => {
    expect(AUTO_SAVE_DEFAULT).toBe("delay");
  });

  it("maps mode × trigger", () => {
    expect(at({ mode: "off", trigger: "delay" })).toBe(false);
    expect(at({ mode: "off", trigger: "leave" })).toBe(false);
    expect(at({ mode: "delay", trigger: "delay" })).toBe(true);
    expect(at({ mode: "delay", trigger: "leave" })).toBe(true);
    expect(at({ mode: "focus", trigger: "delay" })).toBe(false);
    expect(at({ mode: "focus", trigger: "leave" })).toBe(true);
  });

  it("writes only a dirty buffer, one write at a time", () => {
    expect(at({ dirty: false })).toBe(false);
    expect(at({ saving: true })).toBe(false);
  });

  it("never fires while the banner shows, a Compare is open, or the disk change is unanswered", () => {
    for (const mode of ["delay", "focus"] as const) {
      for (const trigger of ["delay", "leave"] as const) {
        expect(at({ mode, trigger, conflict: true })).toBe(false);
        expect(at({ mode, trigger, comparing: true })).toBe(false);
        expect(at({ mode, trigger, diverged: true })).toBe(false);
      }
    }
  });

  it("past the size cap falls back to manual save", () => {
    expect(at({ bytes: AUTO_SAVE_MAX_BYTES })).toBe(true);
    expect(at({ bytes: AUTO_SAVE_MAX_BYTES + 1 })).toBe(false);
  });
});

describe("utf8Bytes", () => {
  it("counts multi-byte text exactly once it could matter", () => {
    expect(utf8Bytes("abc")).toBe(3);
    const big = "é".repeat(AUTO_SAVE_MAX_BYTES / 2 + 1);
    expect(utf8Bytes(big)).toBe(big.length * 2);
    expect(utf8Bytes(big)).toBeGreaterThan(AUTO_SAVE_MAX_BYTES);
  });
});

describe("createAutoSaveTimer", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("debounces: each edit restarts the clock, one fire after the last", () => {
    vi.useFakeTimers();
    const fire = vi.fn();
    const t = createAutoSaveTimer({ delayMs: 1000, fire });
    t.edited();
    vi.advanceTimersByTime(900);
    t.edited();
    vi.advanceTimersByTime(900);
    expect(fire).not.toHaveBeenCalled();
    expect(t.pending()).toBe(true);
    vi.advanceTimersByTime(100);
    expect(fire).toHaveBeenCalledTimes(1);
    expect(fire).toHaveBeenCalledWith("delay");
    expect(t.pending()).toBe(false);
  });

  it("leaving flushes at once and drops the pending timer", () => {
    vi.useFakeTimers();
    const fire = vi.fn();
    const t = createAutoSaveTimer({ delayMs: 1000, fire });
    t.edited();
    t.left();
    expect(fire).toHaveBeenCalledWith("leave");
    vi.advanceTimersByTime(5000);
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it("cancel drops a pending write", () => {
    vi.useFakeTimers();
    const fire = vi.fn();
    const t = createAutoSaveTimer({ delayMs: 1000, fire });
    t.edited();
    t.cancel();
    vi.advanceTimersByTime(5000);
    expect(fire).not.toHaveBeenCalled();
  });
});

describe("the editor's banner path blocks auto-save (source pin)", () => {
  const src = readFileSync("src/components/CodeEditor.tsx", "utf8");

  it("the policy reads the banner, the Compare and the unanswered disk change", () => {
    expect(src).toContain(
      "live.current = { mode, conflict: conflict != null, comparing: comparing != null, diverged };",
    );
    expect(src).toMatch(/shouldAutoSave\(\{\s*\.\.\.live\.current,/);
  });

  it("a disk change under a dirty buffer pauses auto-save as it raises the banner", () => {
    const branch = src.slice(src.indexOf("const onDiskChange"), src.indexOf("useLiveFile(path, onDiskChange)"));
    expect(branch).toMatch(/timer\.cancel\(\);\s*setDiverged\(true\);\s*setConflict\(/);
  });

  it("Keep editing clears the banner, not the pause", () => {
    const keep = src.slice(src.indexOf("onKeep={"), src.indexOf("onReload={"));
    expect(keep).toContain("setConflict(null)");
    expect(keep).not.toContain("setDiverged");
  });

  it("every auto-save re-reads the disk and writes only over what it last read", () => {
    const auto = src.slice(src.indexOf("const autoSave = useCallback"), src.indexOf("const autoSaveRef"));
    expect(auto).toContain('invoke<FileContent>("read_text_file"');
    expect(auto).toContain("if (f.content === base) return write(at, content, true, epoch);");
    expect(auto).toMatch(/setDiverged\(true\);\s*setConflict\(/);
  });
});
