import { beforeEach, expect, it, vi } from "vitest";
import { readMemoryStatus } from "./memoryStatus";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
// A block, not an arrow's value: a hook that returns a function has it run as
// its teardown, and `mockReset` returns the mock itself.
beforeEach(() => {
  invoke.mockReset();
});

it("shares one read between callers that arrive while it is out", async () => {
  let resolve: (v: unknown) => void = () => {};
  invoke.mockImplementation(() => new Promise((r) => (resolve = r)));
  const chip = readMemoryStatus<{ itemCount: number }>();
  const surface = readMemoryStatus<{ itemCount: number }>();
  resolve({ itemCount: 7 });
  expect(await chip).toEqual({ itemCount: 7 });
  expect(await surface).toBe(await chip);
  expect(invoke.mock.calls).toEqual([["memory_status"]]);
});

it("reads afresh once the last read landed, failed reads included", async () => {
  invoke.mockImplementationOnce(async () => {
    throw new Error("busy");
  });
  let failed = "";
  try {
    await readMemoryStatus();
  } catch (e) {
    failed = (e as Error).message;
  }
  expect(failed).toBe("busy");
  invoke.mockImplementationOnce(async () => ({ itemCount: 1 }));
  expect(await readMemoryStatus()).toEqual({ itemCount: 1 });
  expect(invoke).toHaveBeenCalledTimes(2);
});
