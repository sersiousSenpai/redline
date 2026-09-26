/** Reserve one of the existing eight slots for the memory scene. Terminals
 * beyond the budget keep their DOM renderer, without losing a live context. */
export const GRAPHICS_LIMIT = 8;
const live = { terminal: 0, cosmos: 0 };
export function acquireGraphics(kind: keyof typeof live): (() => void) | null {
  if (live.terminal + live.cosmos >= GRAPHICS_LIMIT || live[kind] >= (kind === "cosmos" ? 1 : GRAPHICS_LIMIT - 1)) return null;
  live[kind]++;
  let released = false;
  return () => { if (!released) { released = true; live[kind]--; } };
}
export function graphicsAllocation() { return { ...live }; }
