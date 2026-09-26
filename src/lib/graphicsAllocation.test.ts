import { expect, it } from "vitest";
import { acquireGraphics, graphicsAllocation } from "./graphicsAllocation";
it("reserves a cosmos slot alongside terminals and releases each lease once", () => {
  const leases=Array.from({length:7},()=>acquireGraphics("terminal"));
  expect(leases.every(Boolean)).toBe(true); expect(acquireGraphics("terminal")).toBeNull();
  const scene=acquireGraphics("cosmos"); expect(scene).not.toBeNull(); expect(acquireGraphics("cosmos")).toBeNull();
  scene!();scene!(); expect(graphicsAllocation()).toEqual({terminal:7,cosmos:0});
  for(const release of leases){ release!();release!(); }
  expect(graphicsAllocation()).toEqual({terminal:0,cosmos:0});
});
