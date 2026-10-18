// Synthetic boundary: no user database, model calls, dictation or profile writes.
export function useReadAloud() { return { speaking: false, stop: () => {}, speak: () => {}, warm: () => {} }; }
export async function listen() { return () => {}; }
export async function emit() {} export async function emitTo() {} export async function once() { return () => {}; }
export async function open() { return null; } export async function openUrl() {}
export function convertFileSrc(path: string) { return path; } export function isTauri() { return false; }
export function getCurrentWindow() { return { startDragging: async () => {}, toggleMaximize: async () => {} }; }
export function getCurrentWebview() { return { onDragDropEvent: async () => () => {} }; }
export class Channel { onmessage = () => {}; }
export async function invoke(command: string) {
  if (command === "projects_parent") return "~/projects/";
  if (/prefs|settings/.test(command)) return null;
  return [];
}
