import { layoutMap3d, type CosmosNode } from "./memoryMap3d";
import type { MemoryMapData } from "./memoryMap";
self.onmessage = (event: MessageEvent<{ request: number; data: MemoryMapData; previous: CosmosNode[] }>) => {
  const { request, data, previous } = event.data;
  try { self.postMessage({ request, layout: layoutMap3d(data, previous) }); }
  catch (error) { self.postMessage({ request, error: String(error) }); }
};
