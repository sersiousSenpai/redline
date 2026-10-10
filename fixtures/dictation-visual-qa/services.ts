// Synthetic service boundary only: a scripted microphone. The composers, the
// dictation host and its strip are imported intact.
// Its state lives on the window: the dev server can load this module once per
// aliased specifier, and every copy must share one set of listeners.
type Handler = (event: { payload: unknown }) => void;
const qa = window as unknown as {
  __qaHandlers?: Map<string, Set<Handler>>;
  __qaCalls: Array<[string, unknown]>;
  __qaEmit: (event: string, payload: unknown) => void;
  __qaDictated: string;
};
const handlers = (qa.__qaHandlers ??= new Map<string, Set<Handler>>());
qa.__qaCalls ??= [];
qa.__qaDictated ??= "";
qa.__qaEmit = (event, payload) => {
  for (const fn of handlers.get(event) ?? []) fn({ payload });
};
export async function invoke(command: string, args?: unknown) {
  qa.__qaCalls.push([command, args]);
  switch (command) {
    case "dictation_start":
      return { granted: true, holder: (args as { owner: string }).owner };
    case "dictation_stop":
      return qa.__qaDictated;
    case "get_ui_prefs":
      return {};
    default:
      return null;
  }
}
export async function listen(event: string, fn: Handler) {
  const set = handlers.get(event) ?? new Set<Handler>();
  set.add(fn);
  handlers.set(event, set);
  return () => set.delete(fn);
}
